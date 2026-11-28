import {
  Injectable,
  Logger,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import axios from 'axios';
import { randomBytes } from 'crypto';
import { Model, Types } from 'mongoose';
import { Tenant, TenantDocument } from '../auth/schemas/tenant.schema';
import { User, UserDocument } from '../auth/schemas/user.schema';
import { InboxService } from '../inbox/inbox.service';
import { LeadRoutingService } from '../lead-routing/lead-routing.service';
import { Lead, LeadDocument } from '../leads/schemas/lead.schema';
import {
  decryptMetaPageToken,
  mapMetaFieldDataToLead,
  normalizeIndianMetaPhone,
  type MetaGraphFieldDataEntry,
} from './meta-leads.util';
import {
  MetaPageConnection,
  MetaPageConnectionDocument,
} from './schemas/meta-page-connection.schema';

export const META_LEADS_INGESTION_QUEUE = 'meta-leads-ingestion';

export interface MetaLeadgenJobPayload {
  jobId: string;
  leadgenId: string;
  pageId: string;
  formId?: string;
  adId?: string;
  createdTime?: number | string;
  /** Optional pre-supplied field_data for sandbox / testing tool simulation */
  syntheticFieldData?: MetaGraphFieldDataEntry[];
}

@Injectable()
export class MetaLeadsProcessor implements OnModuleDestroy {
  private readonly logger = new Logger(MetaLeadsProcessor.name);
  private readonly processedJobIds = new Set<string>();
  private readonly inFlightJobs = new Map<string, Promise<unknown>>();

  constructor(
    @InjectModel(MetaPageConnection.name)
    private readonly pageModel: Model<MetaPageConnectionDocument>,
    @InjectModel(Lead.name)
    private readonly leadModel: Model<LeadDocument>,
    @InjectModel(Tenant.name)
    private readonly tenantModel: Model<TenantDocument>,
    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>,
    private readonly configService: ConfigService,
    @Optional() private readonly inboxService?: InboxService,
    @Optional() private readonly leadRoutingService?: LeadRoutingService,
  ) {}

  onModuleDestroy() {
    this.inFlightJobs.clear();
  }

  private getGraphBaseUrl(): string {
    const customBase = (
      this.configService.get<string>('META_GRAPH_API_BASE') ||
      process.env.META_GRAPH_API_BASE ||
      ''
    )
      .trim()
      .replace(/\/+$/, '');
    if (customBase) return customBase;

    const version = (
      this.configService.get<string>('META_GRAPH_API_VERSION') ||
      process.env.META_GRAPH_API_VERSION ||
      'v25.0'
    ).trim();
    return `https://graph.facebook.com/${version}`;
  }

  private getEncryptionKey(): string {
    return (
      this.configService.get<string>('META_TOKEN_ENCRYPTION_KEY') ||
      process.env.META_TOKEN_ENCRYPTION_KEY ||
      this.configService.get<string>('JWT_SECRET') ||
      ''
    ).trim();
  }

  /**
   * Enqueues a `leadgen` change onto the `meta-leads-ingestion` queue using `leadgen_id`
   * as the deduplication `jobId`.
   */
  enqueueLeadgenJob(payload: MetaLeadgenJobPayload): {
    queued: boolean;
    jobId: string;
    deduplicated: boolean;
  } {
    const jobId = String(payload.jobId || payload.leadgenId || '').trim();
    if (!jobId) {
      return { queued: false, jobId: '', deduplicated: false };
    }
    if (this.processedJobIds.has(jobId) || this.inFlightJobs.has(jobId)) {
      return { queued: false, jobId, deduplicated: true };
    }

    const promise = this.processLeadgenJob(payload)
      .catch((err) => {
        this.logger.warn(
          `Meta leadgen job ${jobId} failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      })
      .finally(() => {
        this.inFlightJobs.delete(jobId);
      });

    this.inFlightJobs.set(jobId, promise);
    return { queued: true, jobId, deduplicated: false };
  }

  async waitForAllInFlight(): Promise<void> {
    await Promise.allSettled(Array.from(this.inFlightJobs.values()));
  }

  /**
   * BullMQ / Queue worker processor for `meta-leads-ingestion`.
   */
  async processLeadgenJob(payload: MetaLeadgenJobPayload): Promise<{
    outcome: 'created' | 'merged' | 'skipped';
    leadId?: string;
    whatsAppSent?: boolean;
    error?: string;
  }> {
    const leadgenId = String(payload.leadgenId || '').trim();
    const pageId = String(payload.pageId || '').trim();
    if (!leadgenId || !pageId) {
      return { outcome: 'skipped', error: 'Missing leadgenId or pageId' };
    }

    const connection = await this.pageModel
      .findOne({ pageId })
      .sort({ updatedAt: -1 })
      .exec();
    if (!connection) {
      return {
        outcome: 'skipped',
        error: `No MetaPageConnection found for pageId ${pageId}`,
      };
    }

    const tenantOid = connection.tenantId;
    const tenantIdStr = String(tenantOid);

    let decryptedToken = '';
    try {
      decryptedToken = decryptMetaPageToken({
        encryptedPageAccessToken: connection.encryptedPageAccessToken,
        tokenIv: connection.tokenIv,
        tokenAuthTag: connection.tokenAuthTag,
        encryptionKey: this.getEncryptionKey(),
      });
    } catch {
      connection.status = 'needs_reconnect';
      connection.lastError =
        'Failed to decrypt stored Page Access Token. Please reconnect Facebook Page.';
      await connection.save();
      return { outcome: 'skipped', error: connection.lastError };
    }

    let fieldData: MetaGraphFieldDataEntry[] = Array.isArray(
      payload.syntheticFieldData,
    )
      ? payload.syntheticFieldData
      : [];
    let adId = String(payload.adId || '').trim();
    let formId = String(payload.formId || '').trim();
    let createdTime = payload.createdTime
      ? new Date(
          typeof payload.createdTime === 'number'
            ? payload.createdTime * 1000
            : payload.createdTime,
        ).toISOString()
      : new Date().toISOString();

    if (fieldData.length === 0 && !decryptedToken.startsWith('sandbox_page_token_')) {
      try {
        const graphBase = this.getGraphBaseUrl();
        const { data } = await axios.get<{
          id?: string;
          created_time?: string;
          ad_id?: string;
          form_id?: string;
          field_data?: MetaGraphFieldDataEntry[];
        }>(`${graphBase}/${encodeURIComponent(leadgenId)}`, {
          params: {
            fields:
              'created_time,ad_id,form_id,field_data,custom_disclaimer_responses',
            access_token: decryptedToken,
          },
          timeout: 12_000,
        });

        if (Array.isArray(data?.field_data)) {
          fieldData = data.field_data;
        }
        if (data?.ad_id) adId = String(data.ad_id);
        if (data?.form_id) formId = String(data.form_id);
        if (data?.created_time) {
          createdTime = new Date(data.created_time).toISOString();
        }
      } catch (err) {
        if (axios.isAxiosError(err)) {
          const fbErr = (err.response?.data as {
            error?: { code?: number; type?: string; message?: string };
          })?.error;
          if (fbErr?.code === 190 || fbErr?.type === 'OAuthException') {
            connection.status = 'needs_reconnect';
            connection.lastError =
              fbErr?.message ||
              'Facebook Page Access Token expired or revoked (OAuthException 190). Please reconnect Page.';
            await connection.save();
            return { outcome: 'skipped', error: connection.lastError };
          }
        }
        throw err;
      }
    }

    const formConfig = (connection.forms || []).find(
      (f) => f.formId === formId,
    );
    const formName = formConfig?.formName || (formId ? `Form ${formId}` : 'Meta Instant Form');
    const mapped = mapMetaFieldDataToLead(
      fieldData,
      formConfig?.fieldMappings,
    );

    const normalizedPhone = normalizeIndianMetaPhone(
      mapped.phone || mapped.rawFields.phone_number || mapped.rawFields.phone || '',
    );
    const tenant = await this.tenantModel.findById(tenantOid).lean().exec();
    const city = mapped.city || tenant?.city || '';
    const leadName =
      mapped.name ||
      mapped.rawFields.full_name ||
      `Meta Lead ${normalizedPhone || leadgenId.slice(-6)}`;

    // Resolve owner / assignee
    let assignedUserId = String(formConfig?.defaultAssigneeId || '').trim();
    let assignedRepName = 'Sales Specialist';
    let assignedRepEmail = 'meta-leads@leadsetu.in';

    if (assignedUserId && Types.ObjectId.isValid(assignedUserId)) {
      const explicitUser = await this.userModel
        .findOne({ _id: new Types.ObjectId(assignedUserId), tenantId: tenantOid })
        .select('_id name email')
        .lean()
        .exec();
      if (explicitUser) {
        assignedRepName = explicitUser.name || assignedRepName;
        assignedRepEmail = explicitUser.email || assignedRepEmail;
      } else {
        assignedUserId = '';
      }
    }

    if (!assignedUserId && this.leadRoutingService) {
      try {
        const routed = await this.leadRoutingService.resolveAssigneeForLead(
          tenantIdStr,
          {
            city,
            source: 'meta_lead_ads',
            estimatedValue: mapped.estimatedValue,
            leadName,
            commit: true,
          },
        );
        assignedUserId = routed.assignedUserId;
        assignedRepName = routed.assignedUserName || assignedRepName;
        assignedRepEmail = routed.assignedUserEmail || assignedRepEmail;
      } catch {
        // fallback below
      }
    }

    if (!assignedUserId || !Types.ObjectId.isValid(assignedUserId)) {
      const fallbackUser = await this.userModel
        .findOne({ tenantId: tenantOid, isActive: { $ne: false } })
        .sort({ _id: 1 })
        .select('_id name email')
        .lean()
        .exec();
      if (!fallbackUser) {
        return { outcome: 'skipped', error: 'No active user in workspace' };
      }
      assignedUserId = String(fallbackUser._id);
      assignedRepName = fallbackUser.name || assignedRepName;
      assignedRepEmail = fallbackUser.email || assignedRepEmail;
    }

    const metaLeadData = {
      leadgenId,
      pageId: connection.pageId,
      pageName: connection.pageName,
      formId,
      formName,
      adId,
      createdTime,
      rawFields: mapped.rawFields,
    };

    // Check idempotency by leadgenId OR existing buyer phone
    let existing = await this.leadModel
      .findOne({
        tenantId: tenantOid,
        'metaLeadData.leadgenId': leadgenId,
      })
      .exec();

    if (!existing && normalizedPhone.length >= 10) {
      const last10 = normalizedPhone.replace(/\D/g, '').slice(-10);
      if (last10.length === 10) {
        const suffixRegex = `${last10.split('').join('\\D*')}\\D*$`;
        existing = await this.leadModel
          .findOne({
            tenantId: tenantOid,
            phone: { $regex: suffixRegex },
          })
          .sort({ updatedAt: -1 })
          .exec();
      }
    }

    const nowIso = new Date().toISOString();
    let leadDoc: LeadDocument;
    let outcome: 'created' | 'merged' = 'created';

    if (existing) {
      outcome = 'merged';
      if (!existing.metaLeadData?.leadgenId) {
        existing.metaLeadData = metaLeadData;
      } else {
        existing.metaLeadData = {
          ...existing.metaLeadData,
          ...metaLeadData,
          rawFields: {
            ...(existing.metaLeadData.rawFields || {}),
            ...mapped.rawFields,
          },
        };
      }
      if (mapped.company && !existing.company) existing.company = mapped.company;
      if (mapped.email && !existing.email) existing.email = mapped.email;
      if (adId && !existing.adId) existing.adId = adId;
      existing.customFields = {
        ...(existing.customFields || {}),
        ...mapped.customFields,
      };
      existing.activities.unshift({
        id: randomBytes(6).toString('hex'),
        type: 'note',
        description: `Merged Meta Lead Ad submission (${formName} · Page: ${connection.pageName} · ID: ${leadgenId}).`,
        authorName: 'Meta Lead Ads Sync',
        createdAt: nowIso,
      });
      existing.markModified('metaLeadData');
      existing.markModified('customFields');
      leadDoc = await existing.save();
    } else {
      leadDoc = await this.leadModel.create({
        tenantId: tenantOid,
        ownerId: new Types.ObjectId(assignedUserId),
        name: leadName,
        accountKind: mapped.company ? 'business' : 'consumer',
        company: mapped.company,
        phone: normalizedPhone,
        email: mapped.email,
        city,
        source: 'meta_lead_ads',
        status: 'new',
        estimatedValue: mapped.estimatedValue,
        adPlatform: 'meta',
        adId,
        adHeadline: formName,
        externalQueryId: `META-${leadgenId}`,
        tags: ['Meta Lead Ad', formName].filter(Boolean),
        notes:
          mapped.notes ||
          `Meta Lead Ad (${formName}) on ${connection.pageName}`,
        customFields: mapped.customFields,
        metaLeadData,
        aiScore: 84,
        aiLabel: 'Hot',
        aiInsight: `Captured from Meta Lead Form "${formName}" (${connection.pageName}) · Assigned to ${assignedRepName}.`,
        aiNextAction: 'Send instant WhatsApp greeting & qualify requirement.',
        aiScoredAt: nowIso,
        activities: [
          {
            id: randomBytes(6).toString('hex'),
            type: 'created',
            description: `Ingested from Meta Lead Ad "${formName}" (${connection.pageName}) · Assigned to ${assignedRepName}.`,
            authorName: 'Meta Lead Ads Worker',
            createdAt: nowIso,
          },
        ],
      });
    }

    connection.lastLeadReceivedAt = new Date();
    connection.status = 'active';
    connection.lastError = '';
    await connection.save();

    let whatsAppSent = false;
    const shouldAutoReply =
      formConfig ? formConfig.autoReplyEnabled !== false : true;

    if (
      shouldAutoReply &&
      outcome === 'created' &&
      normalizedPhone &&
      this.inboxService
    ) {
      const companyName = String(
        tenant?.companyName || tenant?.name || connection.pageName || 'our team',
      ).trim();
      const welcomeBody = `Namaste ${leadDoc.name} ji! Thank you for submitting your inquiry on *${connection.pageName}* (${formName}). Our specialist *${assignedRepName}* from *${companyName}* is reviewing your details and connecting right away.`;
      try {
        const wa = await this.inboxService.dispatchAutomatedWhatsApp({
          tenantId: tenantIdStr,
          userId: assignedUserId,
          actorName: 'Meta Lead Ads Auto-Welcome',
          linkedEntityType: 'lead',
          linkedEntityId: String(leadDoc._id),
          contactName: leadDoc.name,
          company: leadDoc.company || companyName,
          phone: normalizedPhone,
          city,
          estimatedValue: leadDoc.estimatedValue,
          messageBody: welcomeBody,
          ...(formConfig?.whatsappTemplateId
            ? {
                sendMode: 'meta_template',
                metaTemplateName: formConfig.whatsappTemplateId,
              }
            : { sendMode: 'text' }),
          timelineMarker: `Meta Lead Ad Auto-WhatsApp sent for ${formName}`,
        });
        whatsAppSent = !wa.skippedDnd && wa.status !== 'failed';
        if (whatsAppSent) {
          await this.leadModel.updateOne(
            { _id: leadDoc._id },
            {
              $set: {
                autoWhatsAppWelcomeSent: true,
                firstContactedAt: new Date().toISOString(),
                speedToLeadSeconds: 3,
              },
            },
          );
        }
      } catch {
        whatsAppSent = false;
      }
    }

    this.processedJobIds.add( String(payload.jobId || leadgenId) );
    return {
      outcome,
      leadId: String(leadDoc._id),
      whatsAppSent,
    };
  }
}
