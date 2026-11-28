import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomBytes } from 'crypto';
import { Model, Types } from 'mongoose';
import { Tenant, TenantDocument } from '../auth/schemas/tenant.schema';
import { User, UserDocument } from '../auth/schemas/user.schema';
import { Contact, ContactDocument } from '../contacts/contacts.service';
import { Deal, DealDocument } from '../deals/schemas/deal.schema';
import { InboxService } from '../inbox/inbox.service';
import { LeadRoutingService } from '../lead-routing/lead-routing.service';
import { Lead, LeadDocument } from '../leads/schemas/lead.schema';
import {
  UniversalWebhook,
  UniversalWebhookDocument,
} from './schemas/universal-webhook.schema';
import {
  WebhookDeliveryLog,
  WebhookDeliveryLogDocument,
} from './schemas/webhook-delivery-log.schema';
import {
  autoSuggestFieldMappings,
  normalizeUniversalPhone,
} from './universal-webhooks.util';

export const UNIVERSAL_WEBHOOKS_QUEUE = 'universal-webhooks-queue';

export interface UniversalWebhookJobPayload {
  webhookId: string;
  method: string;
  rawPayload: unknown;
  flattenedPayload: Record<string, string>;
}

@Injectable()
export class UniversalWebhookProcessor {
  private readonly logger = new Logger(UniversalWebhookProcessor.name);
  private readonly inFlightJobs = new Set<Promise<unknown>>();

  constructor(
    @InjectModel(UniversalWebhook.name)
    private readonly webhookModel: Model<UniversalWebhookDocument>,
    @InjectModel(WebhookDeliveryLog.name)
    private readonly logModel: Model<WebhookDeliveryLogDocument>,
    @InjectModel(Lead.name)
    private readonly leadModel: Model<LeadDocument>,
    @InjectModel(Contact.name)
    private readonly contactModel: Model<ContactDocument>,
    @InjectModel(Deal.name)
    private readonly dealModel: Model<DealDocument>,
    @InjectModel(Tenant.name)
    private readonly tenantModel: Model<TenantDocument>,
    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>,
    @Optional() private readonly inboxService?: InboxService,
    @Optional() private readonly leadRoutingService?: LeadRoutingService,
  ) {}

  /**
   * Enqueues a job onto `universal-webhooks-queue` with exponential backoff (`attempts: 3`).
   */
  enqueueJob(payload: UniversalWebhookJobPayload): {
    queued: boolean;
    queue: string;
    attempts: number;
  } {
    const task = this.executeWithRetry(payload, 3)
      .catch((err) => {
        this.logger.warn(
          `Universal webhook job failed for ${payload.webhookId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      })
      .finally(() => {
        this.inFlightJobs.delete(task);
      });

    this.inFlightJobs.add(task);
    return {
      queued: true,
      queue: UNIVERSAL_WEBHOOKS_QUEUE,
      attempts: 3,
    };
  }

  async waitForAllInFlight(): Promise<void> {
    await Promise.allSettled(Array.from(this.inFlightJobs));
  }

  private async executeWithRetry(
    payload: UniversalWebhookJobPayload,
    maxAttempts = 3,
  ) {
    let attempt = 0;
    while (attempt < maxAttempts) {
      attempt += 1;
      try {
        return await this.processWebhookJob(payload);
      } catch (err) {
        if (attempt >= maxAttempts) throw err;
        await new Promise((r) => setTimeout(r, 150 * Math.pow(2, attempt - 1)));
      }
    }
  }

  private async pruneDeliveryLogs(webhookId: string) {
    const excess = await this.logModel
      .find({ webhookId })
      .sort({ createdAt: -1 })
      .skip(50)
      .select('_id')
      .lean()
      .exec();
    if (excess.length > 0) {
      await this.logModel
        .deleteMany({ _id: { $in: excess.map((e) => e._id) } })
        .exec();
    }
  }

  private isEmptyValue(val: unknown): boolean {
    return val === null || val === undefined || String(val).trim() === '';
  }

  async processWebhookJob(payload: UniversalWebhookJobPayload): Promise<{
    outcome: 'created' | 'updated' | 'failed';
    matchedRecordId?: string;
    matchedEntityType?: 'lead' | 'contact' | 'deal';
    normalizedPhone: string;
    errorReason?: string;
  }> {
    const webhook = await this.webhookModel
      .findOne({ webhookId: payload.webhookId })
      .exec();
    if (!webhook) {
      return {
        outcome: 'failed',
        normalizedPhone: '',
        errorReason: 'Webhook configuration not found',
      };
    }

    const tenantOid = webhook.tenantId;
    const tenantIdStr = String(tenantOid);
    const flat = payload.flattenedPayload || {};

    const effectiveMappings =
      Array.isArray(webhook.fieldMappings) && webhook.fieldMappings.length > 0
        ? webhook.fieldMappings
        : autoSuggestFieldMappings(flat, webhook.targetAction);

    const mappedFields: Record<string, string> = {};
    for (const m of effectiveMappings) {
      if (!m?.sourceKey || !m?.targetField) continue;
      const val = flat[m.sourceKey];
      if (val !== undefined && val !== null && String(val).trim() !== '') {
        mappedFields[m.targetField] = String(val).trim();
      }
    }

    // Fallback phone lookup if fieldMappings did not explicitly map `phone`
    const rawPhoneCandidate =
      mappedFields.phone ||
      mappedFields.contactPhone ||
      flat.phone ||
      flat.mobile ||
      flat.whatsapp ||
      flat['customer.phone'] ||
      flat['customer.mobile'] ||
      '';
    const normalizedPhone = normalizeUniversalPhone(rawPhoneCandidate);

    if (!normalizedPhone) {
      await this.webhookModel.updateOne(
        { _id: webhook._id },
        {
          $inc: { 'stats.failed': 1 },
          $set: { lastReceivedAt: new Date() },
        },
      );
      await this.logModel.create({
        tenantId: tenantOid,
        webhookId: webhook.webhookId,
        method: payload.method,
        rawPayload: payload.rawPayload,
        flattenedPayload: flat,
        normalizedPhone: '',
        outcome: 'failed',
        errorReason: 'Missing or invalid phone number',
        createdAt: new Date(),
      });
      await this.pruneDeliveryLogs(webhook.webhookId);
      return {
        outcome: 'failed',
        normalizedPhone: '',
        errorReason: 'Missing or invalid phone number',
      };
    }

    // Resolve default assignee or round-robin owner for new records
    let assignedUserId = webhook.defaultAssigneeId
      ? String(webhook.defaultAssigneeId)
      : '';
    let assignedRepName = 'Sales Specialist';

    if (assignedUserId && Types.ObjectId.isValid(assignedUserId)) {
      const u = await this.userModel
        .findOne({ _id: new Types.ObjectId(assignedUserId), tenantId: tenantOid })
        .select('_id name')
        .lean()
        .exec();
      if (u) {
        assignedRepName = u.name || assignedRepName;
      } else {
        assignedUserId = '';
      }
    }

    if (!assignedUserId && this.leadRoutingService) {
      try {
        const routed = await this.leadRoutingService.resolveAssigneeForLead(
          tenantIdStr,
          {
            city: mappedFields.city || '',
            source: 'website',
            estimatedValue: Number(
              mappedFields.estimatedValue || mappedFields.value || 0,
            ),
            leadName:
              mappedFields.name || mappedFields.contactName || normalizedPhone,
            commit: true,
          },
        );
        assignedUserId = routed.assignedUserId;
        assignedRepName = routed.assignedUserName || assignedRepName;
      } catch {
        // fallback below
      }
    }

    if (!assignedUserId || !Types.ObjectId.isValid(assignedUserId)) {
      const fallbackUser = await this.userModel
        .findOne({ tenantId: tenantOid, isActive: { $ne: false } })
        .sort({ _id: 1 })
        .select('_id name')
        .lean()
        .exec();
      assignedUserId = fallbackUser
        ? String(fallbackUser._id)
        : String(tenantOid);
      assignedRepName = fallbackUser?.name || assignedRepName;
    }

    const ownerOid = new Types.ObjectId(assignedUserId);
    const strategy = webhook.duplicateStrategy || 'fill_empty';
    const nowIso = new Date().toISOString();

    let outcome: 'created' | 'updated' = 'created';
    let matchedRecordId = '';
    let matchedEntityType: 'lead' | 'contact' | 'deal' = 'lead';
    let recordContactName = '';

    if (webhook.targetAction === 'create_contact') {
      matchedEntityType = 'contact';
      const upserted = await this.upsertContactRecord({
        tenantOid,
        ownerOid,
        webhookName: webhook.name,
        normalizedPhone,
        mappedFields,
        strategy,
        nowIso,
      });
      outcome = upserted.outcome;
      matchedRecordId = upserted.id;
      recordContactName = upserted.name;
    } else if (webhook.targetAction === 'create_deal') {
      matchedEntityType = 'deal';
      const upserted = await this.upsertDealRecord({
        tenantOid,
        ownerOid,
        webhookName: webhook.name,
        normalizedPhone,
        mappedFields,
        strategy,
        nowIso,
      });
      outcome = upserted.outcome;
      matchedRecordId = upserted.id;
      recordContactName = upserted.name;
    } else {
      matchedEntityType = 'lead';
      const upserted = await this.upsertLeadRecord({
        tenantOid,
        ownerOid,
        webhookName: webhook.name,
        normalizedPhone,
        mappedFields,
        strategy,
        nowIso,
      });
      outcome = upserted.outcome;
      matchedRecordId = upserted.id;
      recordContactName = upserted.name;
    }

    // Update stats & delivery log
    await this.webhookModel.updateOne(
      { _id: webhook._id },
      {
        $inc:
          outcome === 'created'
            ? { 'stats.created': 1 }
            : { 'stats.updated': 1 },
        $set: { lastReceivedAt: new Date() },
      },
    );

    await this.logModel.create({
      tenantId: tenantOid,
      webhookId: webhook.webhookId,
      method: payload.method,
      rawPayload: payload.rawPayload,
      flattenedPayload: flat,
      normalizedPhone,
      outcome,
      matchedRecordId: Types.ObjectId.isValid(matchedRecordId)
        ? new Types.ObjectId(matchedRecordId)
        : null,
      matchedEntityType,
      errorReason: '',
      createdAt: new Date(),
    });
    await this.pruneDeliveryLogs(webhook.webhookId);

    // Trigger WhatsApp greeting based on New vs Repeat rules
    const shouldFireWa =
      (outcome === 'created' && webhook.triggerWhatsappOnNew) ||
      (outcome === 'updated' && webhook.triggerWhatsappOnRepeat);

    if (shouldFireWa && this.inboxService && matchedRecordId) {
      const tenant = await this.tenantModel.findById(tenantOid).lean().exec();
      const companyName = String(
        tenant?.companyName || tenant?.name || 'our team',
      ).trim();
      const msg = `Namaste ${recordContactName || 'Sir/Madam'} ji! We have received your inquiry on *${companyName}* (${webhook.name}). Our specialist *${assignedRepName}* is connecting with you right away.`;
      try {
        await this.inboxService.dispatchAutomatedWhatsApp({
          tenantId: tenantIdStr,
          userId: assignedUserId,
          actorName: `Webhook (${webhook.name})`,
          linkedEntityType: matchedEntityType,
          linkedEntityId: matchedRecordId,
          contactName: recordContactName || normalizedPhone,
          company: mappedFields.company || companyName,
          phone: normalizedPhone,
          city: mappedFields.city || '',
          messageBody: msg,
          ...(webhook.whatsappTemplateId
            ? {
                sendMode: 'meta_template',
                metaTemplateName: webhook.whatsappTemplateId,
              }
            : { sendMode: 'text' }),
          timelineMarker: `Universal Webhook WhatsApp sent (${webhook.name})`,
        });
      } catch {
        // non-blocking WhatsApp notification
      }
    }

    return {
      outcome,
      matchedRecordId,
      matchedEntityType,
      normalizedPhone,
    };
  }

  private async findExistingByNormalizedOrSuffix(
    model: { findOne: (filter: any) => { exec: () => Promise<any> } },
    tenantOid: Types.ObjectId,
    normalizedPhone: string,
    phoneField: 'phone' | 'contactPhone',
  ): Promise<any> {
    const last10 = normalizedPhone.replace(/\D/g, '').slice(-10);
    const suffixRegex = `${last10.split('').join('\\D*')}\\D*$`;
    return model
      .findOne({
        tenantId: tenantOid,
        $or: [
          { normalizedPhone },
          { [phoneField]: { $regex: suffixRegex } },
        ],
      })
      .exec();
  }

  private async upsertLeadRecord(params: {
    tenantOid: Types.ObjectId;
    ownerOid: Types.ObjectId;
    webhookName: string;
    normalizedPhone: string;
    mappedFields: Record<string, string>;
    strategy: 'fill_empty' | 'overwrite_non_empty';
    nowIso: string;
  }): Promise<{ outcome: 'created' | 'updated'; id: string; name: string }> {
    const {
      tenantOid,
      ownerOid,
      webhookName,
      normalizedPhone,
      mappedFields,
      strategy,
      nowIso,
    } = params;

    let existing = await this.findExistingByNormalizedOrSuffix(
      this.leadModel,
      tenantOid,
      normalizedPhone,
      'phone',
    );

    if (!existing) {
      try {
        const numericVal = Number(
          (mappedFields.estimatedValue || '').replace(/[^0-9.]/g, ''),
        );
        const created = await this.leadModel.create({
          tenantId: tenantOid,
          ownerId: ownerOid,
          name: mappedFields.name || `Lead ${normalizedPhone}`,
          company: mappedFields.company || '',
          phone: normalizedPhone,
          normalizedPhone,
          email: (mappedFields.email || '').toLowerCase(),
          city: mappedFields.city || '',
          source: 'website',
          status: 'new',
          estimatedValue: Number.isFinite(numericVal) ? numericVal : 0,
          notes: mappedFields.notes || '',
          tags: ['Universal Webhook', webhookName],
          activities: [
            {
              id: randomBytes(6).toString('hex'),
              type: 'created',
              description: `Created via Webhook: ${webhookName}`,
              authorName: 'Universal Webhook Receiver',
              createdAt: nowIso,
            },
          ],
        });
        return {
          outcome: 'created',
          id: String(created._id),
          name: created.name,
        };
      } catch (err) {
        const code = (err as { code?: number })?.code;
        if (code !== 11000) throw err;
        existing = await this.findExistingByNormalizedOrSuffix(
          this.leadModel,
          tenantOid,
          normalizedPhone,
          'phone',
        );
        if (!existing) throw err;
      }
    }

    // Existing record: preserve status (pipeline stage) and ownerId!
    existing.normalizedPhone = normalizedPhone;
    const applyStr = (field: 'name' | 'company' | 'email' | 'city' | 'notes') => {
      const incoming = mappedFields[field];
      if (!incoming) return;
      const val = field === 'email' ? incoming.toLowerCase() : incoming;
      const curr = existing![field];
      const isDefaultPlaceholder =
        (field === 'city' && !curr) ||
        (field === 'name' && curr.startsWith('Lead +91'));
      if (
        strategy === 'overwrite_non_empty' ||
        this.isEmptyValue(curr) ||
        isDefaultPlaceholder
      ) {
        existing![field] = val;
      }
    };

    applyStr('name');
    applyStr('company');
    applyStr('email');
    applyStr('city');
    applyStr('notes');

    if (mappedFields.estimatedValue) {
      const num = Number(mappedFields.estimatedValue.replace(/[^0-9.]/g, ''));
      if (
        Number.isFinite(num) &&
        num > 0 &&
        (strategy === 'overwrite_non_empty' || !existing.estimatedValue)
      ) {
        existing.estimatedValue = num;
      }
    }

    existing.activities.unshift({
      id: randomBytes(6).toString('hex'),
      type: 'note',
      description: `Repeat submission received via Webhook: ${webhookName}`,
      authorName: 'Universal Webhook Receiver',
      createdAt: nowIso,
    });
    await existing.save();

    return {
      outcome: 'updated',
      id: String(existing._id),
      name: existing.name,
    };
  }

  private async upsertContactRecord(params: {
    tenantOid: Types.ObjectId;
    ownerOid: Types.ObjectId;
    webhookName: string;
    normalizedPhone: string;
    mappedFields: Record<string, string>;
    strategy: 'fill_empty' | 'overwrite_non_empty';
    nowIso: string;
  }): Promise<{ outcome: 'created' | 'updated'; id: string; name: string }> {
    const {
      tenantOid,
      ownerOid,
      webhookName,
      normalizedPhone,
      mappedFields,
      strategy,
      nowIso,
    } = params;

    let existing = await this.findExistingByNormalizedOrSuffix(
      this.contactModel,
      tenantOid,
      normalizedPhone,
      'phone',
    );

    if (!existing) {
      try {
        const created = await this.contactModel.create({
          tenantId: tenantOid,
          ownerId: ownerOid,
          name: mappedFields.name || `Contact ${normalizedPhone}`,
          company: mappedFields.company || '',
          designation: mappedFields.designation || '',
          phone: normalizedPhone,
          normalizedPhone,
          email: (mappedFields.email || '').toLowerCase(),
          city: mappedFields.city || 'New Delhi',
          gstin: (mappedFields.gstin || '').toUpperCase(),
          notes: mappedFields.notes || '',
          tags: ['Universal Webhook', webhookName],
          activities: [
            {
              id: randomBytes(6).toString('hex'),
              type: 'created',
              description: `Created via Webhook: ${webhookName}`,
              authorName: 'Universal Webhook Receiver',
              createdAt: nowIso,
            },
          ],
        });
        return {
          outcome: 'created',
          id: String(created._id),
          name: created.name,
        };
      } catch (err) {
        if ((err as { code?: number })?.code !== 11000) throw err;
        existing = await this.findExistingByNormalizedOrSuffix(
          this.contactModel,
          tenantOid,
          normalizedPhone,
          'phone',
        );
        if (!existing) throw err;
      }
    }

    existing.normalizedPhone = normalizedPhone;
    const fields: Array<
      'name' | 'company' | 'designation' | 'email' | 'city' | 'gstin' | 'notes'
    > = ['name', 'company', 'designation', 'email', 'city', 'gstin', 'notes'];
    for (const f of fields) {
      const incoming = mappedFields[f];
      if (!incoming) continue;
      const formatted =
        f === 'email'
          ? incoming.toLowerCase()
          : f === 'gstin'
            ? incoming.toUpperCase()
            : incoming;
      if (strategy === 'overwrite_non_empty' || this.isEmptyValue(existing[f])) {
        existing[f] = formatted;
      }
    }

    existing.activities.unshift({
      id: randomBytes(6).toString('hex'),
      type: 'note',
      description: `Repeat submission received via Webhook: ${webhookName}`,
      authorName: 'Universal Webhook Receiver',
      createdAt: nowIso,
    });
    await existing.save();

    return {
      outcome: 'updated',
      id: String(existing._id),
      name: existing.name,
    };
  }

  private async upsertDealRecord(params: {
    tenantOid: Types.ObjectId;
    ownerOid: Types.ObjectId;
    webhookName: string;
    normalizedPhone: string;
    mappedFields: Record<string, string>;
    strategy: 'fill_empty' | 'overwrite_non_empty';
    nowIso: string;
  }): Promise<{ outcome: 'created' | 'updated'; id: string; name: string }> {
    const {
      tenantOid,
      ownerOid,
      webhookName,
      normalizedPhone,
      mappedFields,
      strategy,
      nowIso,
    } = params;

    let existing = await this.findExistingByNormalizedOrSuffix(
      this.dealModel,
      tenantOid,
      normalizedPhone,
      'contactPhone',
    );

    if (!existing) {
      try {
        const numericVal = Number(
          (mappedFields.value || '').replace(/[^0-9.]/g, ''),
        );
        const contactName =
          mappedFields.contactName || mappedFields.name || `Buyer ${normalizedPhone}`;
        const created = await this.dealModel.create({
          tenantId: tenantOid,
          ownerId: ownerOid,
          title:
            mappedFields.title ||
            `${mappedFields.company || contactName} — Webhook Deal`,
          company: mappedFields.company || '',
          contactName,
          contactPhone: normalizedPhone,
          normalizedPhone,
          contactEmail: (
            mappedFields.contactEmail ||
            mappedFields.email ||
            ''
          ).toLowerCase(),
          city: mappedFields.city || '',
          value: Number.isFinite(numericVal) ? numericVal : 0,
          stage: 'qualified',
          notes: mappedFields.notes || '',
          tags: ['Universal Webhook', webhookName],
          activities: [
            {
              id: randomBytes(6).toString('hex'),
              type: 'created',
              description: `Created via Webhook: ${webhookName}`,
              authorName: 'Universal Webhook Receiver',
              createdAt: nowIso,
            },
          ],
        });
        return {
          outcome: 'created',
          id: String(created._id),
          name: created.contactName || created.title,
        };
      } catch (err) {
        if ((err as { code?: number })?.code !== 11000) throw err;
        existing = await this.findExistingByNormalizedOrSuffix(
          this.dealModel,
          tenantOid,
          normalizedPhone,
          'contactPhone',
        );
        if (!existing) throw err;
      }
    }

    // Preserve stage and ownerId!
    existing.normalizedPhone = normalizedPhone;
    const strFields: Array<
      'title' | 'company' | 'contactName' | 'contactEmail' | 'city' | 'notes'
    > = ['title', 'company', 'contactName', 'contactEmail', 'city', 'notes'];
    for (const f of strFields) {
      const incoming = mappedFields[f];
      if (!incoming) continue;
      if (strategy === 'overwrite_non_empty' || this.isEmptyValue(existing[f])) {
        existing[f] = f === 'contactEmail' ? incoming.toLowerCase() : incoming;
      }
    }

    if (mappedFields.value) {
      const num = Number(mappedFields.value.replace(/[^0-9.]/g, ''));
      if (
        Number.isFinite(num) &&
        num > 0 &&
        (strategy === 'overwrite_non_empty' || !existing.value)
      ) {
        existing.value = num;
      }
    }

    existing.activities.unshift({
      id: randomBytes(6).toString('hex'),
      type: 'note',
      description: `Repeat submission received via Webhook: ${webhookName}`,
      authorName: 'Universal Webhook Receiver',
      createdAt: nowIso,
    });
    await existing.save();

    return {
      outcome: 'updated',
      id: String(existing._id),
      name: existing.contactName || existing.title,
    };
  }
}
