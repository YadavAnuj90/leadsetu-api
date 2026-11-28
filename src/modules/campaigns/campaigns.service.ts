import {
  BadRequestException,
  Injectable,
  NotFoundException,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import {
  InjectModel,
  Prop,
  Schema,
  SchemaFactory,
} from '@nestjs/mongoose';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { HydratedDocument, Model, Types } from 'mongoose';
import {
  CampaignSegment,
  CampaignSegmentFiltersDto,
  CampaignStatus,
  CreateCampaignDto,
  PreviewAudienceDto,
  RetargetCampaignDto,
} from './dto/campaigns.dto';
import { SuperAdminService } from '../super-admin/super-admin.service';
import { resolveOwnerScopeFilter } from '../auth/identity.util';
import { InboxService, extractLast10Digits } from '../inbox/inbox.service';

export type CampaignDocument = HydratedDocument<Campaign>;

export interface CampaignRecipientEntry {
  recipientId: string;
  entityType: 'lead' | 'contact';
  contactName: string;
  company: string;
  phone: string;
  status: 'sent' | 'delivered' | 'read' | 'replied' | 'failed' | 'opted_out';
  deliveryProvider: 'meta_cloud' | 'crm_local' | 'skipped_dnd';
  externalMessageId: string;
  conversationId: string;
  messageId: string;
  renderedMessage: string;
  error: string;
  replyPreview: string;
  sentAt: string;
  deliveredAt: string;
  readAt: string;
  repliedAt: string;
}

@Schema({ timestamps: true, collection: 'campaigns' })
export class Campaign {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  ownerId!: Types.ObjectId;

  @Prop({ required: true, trim: true })
  name!: string;

  @Prop({ trim: true, default: 'b2b_catalogue_hinglish_v1' })
  templateName!: string;

  @Prop({
    default: 'text',
    enum: ['text', 'meta_template'],
  })
  sendMode?: 'text' | 'meta_template';

  @Prop({
    default: 'hinglish',
    enum: ['hinglish', 'english', 'hindi'],
  })
  language!: 'hinglish' | 'english' | 'hindi';

  @Prop({
    default: 'whatsapp_cloud',
    enum: ['whatsapp_cloud', 'whatsapp_ai_drip'],
  })
  channel!: 'whatsapp_cloud' | 'whatsapp_ai_drip';

  @Prop({
    default: 'all_leads',
    enum: [
      'all_leads',
      'hot_leads',
      'noida_delhi_ncr',
      'indiamart_buyers',
      'gst_customers',
      'b2b_accounts',
      'b2c_consumers',
      'delivered_customers',
    ],
  })
  targetSegment!: CampaignSegment;

  @Prop({ type: Object, default: {} })
  segmentFilters?: CampaignSegmentFiltersDto;

  @Prop({ trim: true, default: '' })
  parentCampaignId?: string;

  @Prop({ required: true, trim: true })
  messageBody!: string;

  @Prop({ trim: true, default: 'Get Instant Quote on WhatsApp' })
  ctaLabel!: string;

  @Prop({ type: Number, default: 0 })
  audienceCount!: number;

  @Prop({ type: Number, default: 0 })
  sentCount!: number;

  @Prop({ type: Number, default: 0 })
  deliveredCount!: number;

  @Prop({ type: Number, default: 0 })
  readCount!: number;

  @Prop({ type: Number, default: 0 })
  repliedCount!: number;

  @Prop({ type: Number, default: 0 })
  failedCount?: number;

  @Prop({ type: Number, default: 0 })
  skippedDndCount?: number;

  @Prop({ type: Array, default: [] })
  recipients?: CampaignRecipientEntry[];

  @Prop({ type: Number, default: 0 })
  attributedRevenue!: number;

  @Prop({
    default: 'completed',
    enum: ['completed', 'running', 'scheduled', 'draft'],
  })
  status!: CampaignStatus;

  @Prop({ trim: true, default: '' })
  scheduledFor!: string;
}

export const CampaignSchema = SchemaFactory.createForClass(Campaign);

@Injectable()
export class CampaignsService {
  constructor(
    @InjectModel(Campaign.name)
    private readonly campaignModel: Model<CampaignDocument>,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly inboxService: InboxService,
    @Optional() private readonly superAdminService?: SuperAdminService,
  ) {}

  async verifyAuth(authHeader?: string) {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Authorization token is required.');
    }
    const token = authHeader.slice(7).trim();
    const secret =
      this.configService.get<string>('JWT_SECRET') ||
      'leadsetu_super_secret_access_key_2026';
    let payload: { sub: string; tenantId: string; email: string };
    try {
      payload = await this.jwtService.verifyAsync<{
        sub: string;
        tenantId: string;
        email: string;
      }>(token, { secret });
    } catch {
      throw new UnauthorizedException('Invalid or expired session.');
    }
    await this.superAdminService?.assertFeatureEnabled(
      payload.tenantId,
      'whatsappBroadcasts',
    );
    const userDoc = Types.ObjectId.isValid(payload.sub)
      ? await this.campaignModel.db
          .collection('users')
          .findOne(
            { _id: new Types.ObjectId(payload.sub) },
            { projection: { name: 1 } },
          )
      : null;

    return {
      userId: payload.sub,
      tenantId: payload.tenantId,
      email: payload.email,
      name:
        (userDoc?.name ? String(userDoc.name).trim() : '') ||
        payload.email.split('@')[0],
    };
  }

  private async getLiveSegmentCounts(
    tenantObjectId: Types.ObjectId,
    ownerScope: Record<string, unknown> = {},
  ) {
    try {
      const db = this.campaignModel.db;
      const leadsCol = db.collection('leads');
      const contactsCol = db.collection('contacts');

      const [
        totalLeads,
        hotLeads,
        ncrLeads,
        indiamartLeads,
        gstContacts,
        b2bAccounts,
        b2cConsumers,
        deliveredCustomers,
      ] = await Promise.all([
        leadsCol.countDocuments({
          tenantId: tenantObjectId,
          ...ownerScope,
          doNotCall: { $ne: true },
        }),
        leadsCol.countDocuments({
          tenantId: tenantObjectId,
          ...ownerScope,
          doNotCall: { $ne: true },
          $or: [{ aiScore: { $gte: 75 } }, { aiLabel: 'Hot' }],
        }),
        leadsCol.countDocuments({
          tenantId: tenantObjectId,
          ...ownerScope,
          doNotCall: { $ne: true },
          city: { $regex: /noida|delhi|gurugram|gurgaon|ghaziabad|faridabad/i },
        }),
        leadsCol.countDocuments({
          tenantId: tenantObjectId,
          ...ownerScope,
          doNotCall: { $ne: true },
          source: 'indiamart',
        }),
        contactsCol.countDocuments({
          tenantId: tenantObjectId,
          ...ownerScope,
          gstin: { $exists: true, $ne: '' },
        }),
        leadsCol.countDocuments({
          tenantId: tenantObjectId,
          ...ownerScope,
          doNotCall: { $ne: true },
          accountKind: { $ne: 'consumer' },
        }),
        leadsCol.countDocuments({
          tenantId: tenantObjectId,
          ...ownerScope,
          doNotCall: { $ne: true },
          accountKind: 'consumer',
        }),
        leadsCol.countDocuments({
          tenantId: tenantObjectId,
          ...ownerScope,
          doNotCall: { $ne: true },
          status: 'converted',
        }),
      ]);

      return {
        all_leads: totalLeads,
        hot_leads: hotLeads,
        noida_delhi_ncr: ncrLeads,
        indiamart_buyers: indiamartLeads,
        gst_customers: gstContacts,
        b2b_accounts: b2bAccounts,
        b2c_consumers: b2cConsumers,
        delivered_customers: deliveredCustomers,
        rawDbCounts: {
          totalLeads,
          hotLeads,
          ncrLeads,
          indiamartLeads,
          gstContacts,
          b2bAccounts,
          b2cConsumers,
          deliveredCustomers,
        },
      };
    } catch {
      return {
        all_leads: 0,
        hot_leads: 0,
        noida_delhi_ncr: 0,
        indiamart_buyers: 0,
        gst_customers: 0,
        b2b_accounts: 0,
        b2c_consumers: 0,
        delivered_customers: 0,
        rawDbCounts: {
          totalLeads: 0,
          hotLeads: 0,
          ncrLeads: 0,
          indiamartLeads: 0,
          gstContacts: 0,
          b2bAccounts: 0,
          b2cConsumers: 0,
          deliveredCustomers: 0,
        },
      };
    }
  }

  private async resolveSegmentRecipients(
    tenantObjectId: Types.ObjectId,
    segment: CampaignSegment,
    ownerScope: Record<string, unknown> = {},
    filters: CampaignSegmentFiltersDto = {},
  ): Promise<
    Array<{
      recipientId: string;
      entityType: 'lead' | 'contact';
      contactName: string;
      company: string;
      phone: string;
      city: string;
      estimatedValue: number;
      optedOut: boolean;
      accountKind: 'business' | 'consumer';
    }>
  > {
    const db = this.campaignModel.db;
    const leadsCol = db.collection('leads');
    const contactsCol = db.collection('contacts');
    const convsCol = db.collection('conversations');

    let rows: Array<Record<string, unknown>> = [];
    let entityType: 'lead' | 'contact' = 'lead';

    const cleanCity = String(filters?.city || '').trim();
    const cityRegex = cleanCity
      ? new RegExp(cleanCity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      : null;

    if (segment === 'gst_customers') {
      entityType = 'contact';
      const contactFilter: Record<string, unknown> = {
        tenantId: tenantObjectId,
        ...ownerScope,
        gstin: { $exists: true, $ne: '' },
        phone: { $exists: true, $ne: '' },
      };
      if (cityRegex) contactFilter.city = cityRegex;
      if (filters?.accountKind === 'consumer') {
        contactFilter.accountKind = 'consumer';
      } else if (filters?.accountKind === 'business') {
        contactFilter.accountKind = { $ne: 'consumer' };
      }
      rows = await contactsCol
        .find(contactFilter)
        .sort({ updatedAt: -1 })
        .limit(200)
        .toArray();
    } else if (segment === 'delivered_customers') {
      const leadFilter: Record<string, unknown> = {
        tenantId: tenantObjectId,
        ...ownerScope,
        status: 'converted',
        phone: { $exists: true, $ne: '' },
      };
      if (cityRegex) leadFilter.city = cityRegex;
      if (filters?.accountKind === 'consumer') {
        leadFilter.accountKind = 'consumer';
      } else if (filters?.accountKind === 'business') {
        leadFilter.accountKind = { $ne: 'consumer' };
      }
      const convertedLeads = await leadsCol
        .find(leadFilter)
        .sort({ updatedAt: -1 })
        .limit(150)
        .toArray();

      const contactFilter: Record<string, unknown> = {
        tenantId: tenantObjectId,
        ...ownerScope,
        type: 'customer',
        phone: { $exists: true, $ne: '' },
      };
      if (cityRegex) contactFilter.city = cityRegex;
      if (filters?.accountKind === 'consumer') {
        contactFilter.accountKind = 'consumer';
      } else if (filters?.accountKind === 'business') {
        contactFilter.accountKind = { $ne: 'consumer' };
      }
      const customerContacts = await contactsCol
        .find(contactFilter)
        .sort({ updatedAt: -1 })
        .limit(150)
        .toArray();

      rows = [
        ...convertedLeads.map((r) => ({ ...r, _srcType: 'lead' })),
        ...customerContacts.map((r) => ({ ...r, _srcType: 'contact' })),
      ];
    } else {
      const leadFilter: Record<string, unknown> = {
        tenantId: tenantObjectId,
        ...ownerScope,
        phone: { $exists: true, $ne: '' },
      };
      if (segment === 'hot_leads') {
        leadFilter.$or = [{ aiScore: { $gte: 75 } }, { aiLabel: 'Hot' }];
      } else if (segment === 'noida_delhi_ncr') {
        leadFilter.city = {
          $regex: /noida|delhi|gurugram|gurgaon|ghaziabad|faridabad/i,
        };
      } else if (segment === 'indiamart_buyers') {
        leadFilter.source = 'indiamart';
      } else if (segment === 'b2b_accounts') {
        leadFilter.accountKind = { $ne: 'consumer' };
      } else if (segment === 'b2c_consumers') {
        leadFilter.accountKind = 'consumer';
      }

      if (cityRegex) {
        leadFilter.city = cityRegex;
      }
      if (filters?.accountKind === 'consumer') {
        leadFilter.accountKind = 'consumer';
      } else if (filters?.accountKind === 'business') {
        leadFilter.accountKind = { $ne: 'consumer' };
      }
      if (filters?.leadStatus && filters.leadStatus !== 'all') {
        leadFilter.status = filters.leadStatus;
      }
      if (
        filters?.minAiScore !== undefined &&
        Number.isFinite(Number(filters.minAiScore)) &&
        Number(filters.minAiScore) > 0
      ) {
        leadFilter.aiScore = { $gte: Number(filters.minAiScore) };
      }

      rows = await leadsCol
        .find(leadFilter)
        .sort({ updatedAt: -1 })
        .limit(200)
        .toArray();
    }

    const optOutConvs = await convsCol
      .find(
        { tenantId: tenantObjectId, whatsappOptOut: true },
        { projection: { phone: 1 } },
      )
      .toArray();
    const optOutPhones = new Set(
      optOutConvs
        .map((c) => extractLast10Digits(String(c.phone || '')))
        .filter((d) => d.length >= 10),
    );

    const excludeDnd = filters?.excludeDnd !== false;
    const seenPhones = new Set<string>();
    const results: Array<{
      recipientId: string;
      entityType: 'lead' | 'contact';
      contactName: string;
      company: string;
      phone: string;
      city: string;
      estimatedValue: number;
      optedOut: boolean;
      accountKind: 'business' | 'consumer';
    }> = [];

    for (const r of rows) {
      const phone = String(r.phone || '').trim();
      const last10 = extractLast10Digits(phone);
      if (last10.length < 10 || seenPhones.has(last10)) continue;
      seenPhones.add(last10);

      const tags = Array.isArray(r.tags) ? r.tags : [];
      const hasDndTag = tags.some((t) =>
        /^(dnd|opt_out|opted_out|unsubscribed)$/i.test(String(t).trim()),
      );
      const isDndLead = Boolean(r.doNotCall);
      const optedOut = excludeDnd && (hasDndTag || isDndLead || optOutPhones.has(last10));

      results.push({
        recipientId: String(r._id),
        entityType:
          r._srcType === 'contact' || entityType === 'contact' ? 'contact' : 'lead',
        contactName: String(r.name || 'Buyer').trim(),
        company: String(r.company || '').trim(),
        phone,
        city: String(r.city || '').trim(),
        estimatedValue: Number(r.estimatedValue ?? r.lifetimeValue ?? 0) || 0,
        optedOut,
        accountKind: r.accountKind === 'consumer' ? 'consumer' : 'business',
      });
    }

    return results;
  }

  private recomputeMetricsFromRecipients(recipients: CampaignRecipientEntry[]) {
    const sentCount = recipients.filter((r) =>
      ['sent', 'delivered', 'read', 'replied'].includes(r.status),
    ).length;
    const deliveredCount = recipients.filter((r) =>
      ['delivered', 'read', 'replied'].includes(r.status),
    ).length;
    const readCount = recipients.filter((r) =>
      ['read', 'replied'].includes(r.status),
    ).length;
    const repliedCount = recipients.filter((r) => r.status === 'replied').length;
    const failedCount = recipients.filter((r) => r.status === 'failed').length;
    const skippedDndCount = recipients.filter(
      (r) => r.status === 'opted_out',
    ).length;

    return {
      audienceCount: recipients.length,
      sentCount,
      deliveredCount,
      readCount,
      repliedCount,
      failedCount,
      skippedDndCount,
    };
  }

  private async dispatchCampaignToRecipients(
    auth: { userId: string; tenantId: string; email: string; name?: string },
    doc: CampaignDocument,
    ownerScope: Record<string, unknown>,
  ) {
    const tenantObjectId = new Types.ObjectId(auth.tenantId);
    const audience = await this.resolveSegmentRecipients(
      tenantObjectId,
      doc.targetSegment,
      ownerScope,
      doc.segmentFilters || {},
    );

    const recipients: CampaignRecipientEntry[] = [];
    const nowIso = new Date().toISOString();
    const languageCode = doc.language === 'english' ? 'en' : 'hi';

    for (const r of audience) {
      if (r.optedOut) {
        recipients.push({
          recipientId: r.recipientId,
          entityType: r.entityType,
          contactName: r.contactName,
          company: r.company,
          phone: r.phone,
          status: 'opted_out',
          deliveryProvider: 'skipped_dnd',
          externalMessageId: '',
          conversationId: '',
          messageId: '',
          renderedMessage: '',
          error: 'Buyer opted out (STOP / DND)',
          replyPreview: '',
          sentAt: nowIso,
          deliveredAt: '',
          readAt: '',
          repliedAt: '',
        });
        continue;
      }

      const dispatch = await this.inboxService.dispatchAutomatedWhatsApp({
        tenantId: auth.tenantId,
        userId: auth.userId,
        actorName: auth.name || auth.email.split('@')[0],
        linkedEntityType: r.entityType,
        linkedEntityId: r.recipientId,
        contactName: r.contactName,
        company: r.company,
        phone: r.phone,
        city: r.city,
        estimatedValue: r.estimatedValue,
        messageBody: doc.messageBody,
        sendMode: doc.sendMode || 'text',
        metaTemplateName: doc.templateName,
        languageCode,
        campaignId: doc._id.toString(),
        campaignName: doc.name,
      });

      if (dispatch.skippedDnd) {
        recipients.push({
          recipientId: r.recipientId,
          entityType: r.entityType,
          contactName: r.contactName,
          company: r.company,
          phone: r.phone,
          status: 'opted_out',
          deliveryProvider: 'skipped_dnd',
          externalMessageId: '',
          conversationId: dispatch.conversationId || '',
          messageId: '',
          renderedMessage: '',
          error: dispatch.reason || 'Opted out (DND)',
          replyPreview: '',
          sentAt: nowIso,
          deliveredAt: '',
          readAt: '',
          repliedAt: '',
        });
        continue;
      }

      const status =
        dispatch.status === 'failed'
          ? 'failed'
          : dispatch.status === 'delivered'
            ? 'delivered'
            : 'sent';

      recipients.push({
        recipientId: r.recipientId,
        entityType: r.entityType,
        contactName: r.contactName,
        company: r.company,
        phone: r.phone,
        status,
        deliveryProvider: dispatch.deliveryProvider || 'crm_local',
        externalMessageId: dispatch.externalMessageId || '',
        conversationId: dispatch.conversationId || '',
        messageId: dispatch.messageId || '',
        renderedMessage: dispatch.renderedMessage || doc.messageBody,
        error: dispatch.deliveryError || '',
        replyPreview: '',
        sentAt: nowIso,
        deliveredAt: status === 'delivered' ? nowIso : '',
        readAt: '',
        repliedAt: '',
      });
    }

    const metrics = this.recomputeMetricsFromRecipients(recipients);
    doc.recipients = recipients;
    doc.audienceCount = metrics.audienceCount;
    doc.sentCount = metrics.sentCount;
    doc.deliveredCount = metrics.deliveredCount;
    doc.readCount = metrics.readCount;
    doc.repliedCount = metrics.repliedCount;
    doc.failedCount = metrics.failedCount;
    doc.skippedDndCount = metrics.skippedDndCount;
    doc.status = 'completed';
    doc.markModified('recipients');
  }

  private async computeCampaignAttributionMap(
    tenantObjectId: Types.ObjectId,
    ownerScope: Record<string, unknown>,
    docs: CampaignDocument[],
  ): Promise<
    Map<
      string,
      {
        qualifiedLeadsCount: number;
        closedDealsCount: number;
        liveAttributedRevenue: number;
      }
    >
  > {
    const map = new Map<
      string,
      {
        qualifiedLeadsCount: number;
        closedDealsCount: number;
        liveAttributedRevenue: number;
      }
    >();
    if (docs.length === 0) return map;

    const db = this.campaignModel.db;
    const [leads, wonDeals, paidInvoices] = await Promise.all([
      db
        .collection('leads')
        .find(
          { tenantId: tenantObjectId, ...ownerScope },
          { projection: { _id: 1, phone: 1, status: 1, aiScore: 1 } },
        )
        .toArray(),
      db
        .collection('deals')
        .find(
          {
            tenantId: tenantObjectId,
            ...ownerScope,
            $or: [{ stageCategory: 'won' }, { stage: 'won' }],
          },
          { projection: { _id: 1, contactPhone: 1, value: 1, createdAt: 1, updatedAt: 1 } },
        )
        .toArray(),
      db
        .collection('invoices')
        .find(
          {
            tenantId: tenantObjectId,
            docType: { $ne: 'proforma_quote' },
            status: { $in: ['paid', 'partial'] },
          },
          {
            projection: {
              _id: 1,
              phone: 1,
              linkedLeadId: 1,
              grandTotal: 1,
              amountPaid: 1,
              createdAt: 1,
              updatedAt: 1,
            },
          },
        )
        .toArray(),
    ]);

    const leadById = new Map<string, Record<string, unknown>>();
    const leadByLast10 = new Map<string, Record<string, unknown>>();
    for (const l of leads) {
      leadById.set(String(l._id), l);
      const p10 = extractLast10Digits(String(l.phone || ''));
      if (p10.length >= 10) leadByLast10.set(p10, l);
    }

    for (const camp of docs) {
      const recipients = camp.recipients || [];
      const recIds = new Set(recipients.map((r) => String(r.recipientId)));
      const recPhones = new Set(
        recipients
          .map((r) => extractLast10Digits(r.phone))
          .filter((d) => d.length >= 10),
      );
      const rawCamp = camp.toObject() as unknown as { createdAt?: Date };
      const campCreatedMs = rawCamp.createdAt
        ? new Date(rawCamp.createdAt).getTime() - 10_000
        : 0;

      const qualifiedSet = new Set<string>();
      for (const r of recipients) {
        const l =
          leadById.get(String(r.recipientId)) ||
          leadByLast10.get(extractLast10Digits(r.phone));
        if (
          l &&
          (['qualified', 'proposal', 'converted'].includes(String(l.status || '')) ||
            Number(l.aiScore || 0) >= 80)
        ) {
          qualifiedSet.add(String(l._id));
        }
      }

      let closedDealsCount = 0;
      let dealsRevenue = 0;
      for (const d of wonDeals) {
        const d10 = extractLast10Digits(String(d.contactPhone || ''));
        const ts = new Date(
          String(d.updatedAt || d.createdAt || new Date().toISOString()),
        ).getTime();
        if (recPhones.has(d10) && ts >= campCreatedMs) {
          closedDealsCount += 1;
          dealsRevenue += Number(d.value || 0) || 0;
        }
      }

      let invoiceRevenue = 0;
      for (const inv of paidInvoices) {
        const i10 = extractLast10Digits(String(inv.phone || ''));
        const linkedId = String(inv.linkedLeadId || '');
        const ts = new Date(
          String(inv.updatedAt || inv.createdAt || new Date().toISOString()),
        ).getTime();
        if ((recPhones.has(i10) || (linkedId && recIds.has(linkedId))) && ts >= campCreatedMs) {
          invoiceRevenue += Number(inv.amountPaid || inv.grandTotal || 0) || 0;
        }
      }

      const liveRevenue = Math.max(dealsRevenue, invoiceRevenue);
      map.set(camp._id.toString(), {
        qualifiedLeadsCount: qualifiedSet.size,
        closedDealsCount,
        liveAttributedRevenue: Math.max(liveRevenue, Number(camp.attributedRevenue || 0)),
      });
    }

    return map;
  }

  private toDto(
    doc: CampaignDocument,
    attribution?: {
      qualifiedLeadsCount: number;
      closedDealsCount: number;
      liveAttributedRevenue: number;
    },
  ) {
    const raw = doc.toObject() as unknown as Record<string, unknown> & {
      createdAt?: Date;
      updatedAt?: Date;
    };
    const sent = doc.sentCount || 0;
    const delivered = doc.deliveredCount || 0;
    const read = doc.readCount || 0;
    const replied = doc.repliedCount || 0;
    const attributedRevenue = attribution
      ? attribution.liveAttributedRevenue
      : doc.attributedRevenue || 0;

    return {
      id: doc._id.toString(),
      tenantId: doc.tenantId.toString(),
      name: doc.name,
      templateName: doc.templateName || 'b2b_catalogue_hinglish_v2',
      sendMode: doc.sendMode || 'text',
      language: doc.language || 'hinglish',
      channel: doc.channel || 'whatsapp_cloud',
      targetSegment: doc.targetSegment || 'all_leads',
      segmentFilters: doc.segmentFilters || {},
      parentCampaignId: doc.parentCampaignId || '',
      messageBody: doc.messageBody,
      ctaLabel: doc.ctaLabel || 'Get Instant Quote',
      audienceCount: doc.audienceCount || 0,
      sentCount: sent,
      deliveredCount: delivered,
      readCount: read,
      repliedCount: replied,
      failedCount: doc.failedCount || 0,
      skippedDndCount: doc.skippedDndCount || 0,
      qualifiedLeadsCount: attribution?.qualifiedLeadsCount ?? 0,
      closedDealsCount: attribution?.closedDealsCount ?? 0,
      recipients: doc.recipients || [],
      deliveryRate: sent > 0 ? Math.round((delivered / sent) * 100) : 0,
      readRate: delivered > 0 ? Math.round((read / delivered) * 100) : 0,
      replyRate: sent > 0 ? Math.round((replied / sent) * 100) : 0,
      attributedRevenue,
      status: doc.status || 'completed',
      scheduledFor: doc.scheduledFor || '',
      createdAt: raw.createdAt
        ? new Date(raw.createdAt).toISOString()
        : new Date().toISOString(),
      updatedAt: raw.updatedAt
        ? new Date(raw.updatedAt).toISOString()
        : new Date().toISOString(),
    };
  }

  async findAll(
    auth: { userId: string; tenantId: string },
    query: { search?: string; status?: string; targetSegment?: string },
  ) {
    const tenantObjectId = new Types.ObjectId(auth.tenantId);
    const ownerScope = await resolveOwnerScopeFilter(this.campaignModel.db, auth);
    const baseScope: Record<string, unknown> = {
      tenantId: tenantObjectId,
      ...ownerScope,
    };
    const filter: Record<string, unknown> = { ...baseScope };

    if (query.status && query.status !== 'all') {
      filter.status = query.status;
    }
    if (query.targetSegment && query.targetSegment !== 'all') {
      filter.targetSegment = query.targetSegment;
    }
    if (query.search?.trim()) {
      const regex = new RegExp(query.search.trim(), 'i');
      filter.$or = [
        { name: regex },
        { templateName: regex },
        { messageBody: regex },
      ];
    }

    const [docs, all, segmentCounts] = await Promise.all([
      this.campaignModel.find(filter).sort({ createdAt: -1 }).exec(),
      this.campaignModel.find(baseScope).exec(),
      this.getLiveSegmentCounts(tenantObjectId, ownerScope),
    ]);

    const attrMap = await this.computeCampaignAttributionMap(
      tenantObjectId,
      ownerScope,
      all,
    );

    const totalSent = all.reduce((s, c) => s + (c.sentCount || 0), 0);
    const totalDelivered = all.reduce((s, c) => s + (c.deliveredCount || 0), 0);
    const totalRead = all.reduce((s, c) => s + (c.readCount || 0), 0);
    const totalReplies = all.reduce((s, c) => s + (c.repliedCount || 0), 0);
    const totalQualifiedLeads = all.reduce(
      (s, c) => s + (attrMap.get(c._id.toString())?.qualifiedLeadsCount || 0),
      0,
    );
    const totalClosedDeals = all.reduce(
      (s, c) => s + (attrMap.get(c._id.toString())?.closedDealsCount || 0),
      0,
    );
    const totalAttributedRevenue = all.reduce(
      (s, c) =>
        s +
        (attrMap.get(c._id.toString())?.liveAttributedRevenue ??
          (c.attributedRevenue || 0)),
      0,
    );

    return {
      data: docs.map((d) => this.toDto(d, attrMap.get(d._id.toString()))),
      stats: {
        totalCampaigns: all.length,
        totalSent,
        totalDelivered,
        totalRead,
        totalReplies,
        totalQualifiedLeads,
        totalClosedDeals,
        avgDeliveryRate:
          totalSent > 0 ? Math.round((totalDelivered / totalSent) * 100) : 0,
        avgReadRate:
          totalDelivered > 0
            ? Math.round((totalRead / totalDelivered) * 100)
            : 0,
        totalAttributedRevenue,
        segmentCounts,
      },
    };
  }

  async previewAudience(
    auth: { userId: string; tenantId: string },
    dto: PreviewAudienceDto,
  ) {
    const tenantObjectId = new Types.ObjectId(auth.tenantId);
    const ownerScope = await resolveOwnerScopeFilter(this.campaignModel.db, auth);
    const segment: CampaignSegment = dto?.targetSegment || 'all_leads';
    const recipients = await this.resolveSegmentRecipients(
      tenantObjectId,
      segment,
      ownerScope,
      dto?.segmentFilters || {},
    );
    const active = recipients.filter((r) => !r.optedOut);
    const excluded = recipients.filter((r) => r.optedOut);

    return {
      targetSegment: segment,
      totalMatched: recipients.length,
      willDispatchCount: active.length,
      excludedDndCount: excluded.length,
      sampleRecipients: active.slice(0, 8).map((r) => ({
        id: r.recipientId,
        name: r.contactName,
        company: r.company,
        city: r.city,
        accountKind: r.accountKind,
      })),
    };
  }

  async findOne(auth: { userId: string; tenantId: string }, id: string) {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Campaign not found.');
    }
    const ownerScope = await resolveOwnerScopeFilter(this.campaignModel.db, auth);
    const doc = await this.campaignModel
      .findOne({
        _id: new Types.ObjectId(id),
        tenantId: new Types.ObjectId(auth.tenantId),
        ...ownerScope,
      })
      .exec();
    if (!doc) throw new NotFoundException('Campaign not found.');
    const attrMap = await this.computeCampaignAttributionMap(
      new Types.ObjectId(auth.tenantId),
      ownerScope,
      [doc],
    );
    return this.toDto(doc, attrMap.get(doc._id.toString()));
  }

  async create(
    auth: { userId: string; tenantId: string; email: string; name?: string },
    dto: CreateCampaignDto,
  ) {
    if (!dto.name?.trim()) {
      throw new BadRequestException('Campaign name is required.');
    }
    if (!dto.messageBody?.trim()) {
      throw new BadRequestException('WhatsApp message body is required.');
    }

    const tenantObjectId = new Types.ObjectId(auth.tenantId);
    const ownerScope = await resolveOwnerScopeFilter(this.campaignModel.db, auth);
    const segment: CampaignSegment = dto.targetSegment || 'all_leads';
    const segmentCounts = await this.getLiveSegmentCounts(
      tenantObjectId,
      ownerScope,
    );

    const status: CampaignStatus = dto.status || 'completed';
    const previewAudience =
      dto.audienceCount && Number(dto.audienceCount) > 0
        ? Number(dto.audienceCount)
        : segmentCounts[segment] || 0;

    const doc = await this.campaignModel.create({
      tenantId: tenantObjectId,
      ownerId: new Types.ObjectId(auth.userId),
      name: dto.name.trim(),
      templateName:
        dto.templateName?.trim() || 'b2b_catalogue_hinglish_v2',
      sendMode: dto.sendMode || 'text',
      language: dto.language || 'hinglish',
      channel: dto.channel || 'whatsapp_cloud',
      targetSegment: segment,
      segmentFilters: dto.segmentFilters || {},
      parentCampaignId: dto.parentCampaignId?.trim() || '',
      messageBody: dto.messageBody.trim(),
      ctaLabel: dto.ctaLabel?.trim() || 'Get Instant Quote',
      audienceCount: previewAudience,
      sentCount: 0,
      deliveredCount: 0,
      readCount: 0,
      repliedCount: 0,
      failedCount: 0,
      skippedDndCount: 0,
      recipients: [],
      attributedRevenue: Number(dto.attributedRevenue || 0),
      status,
      scheduledFor: dto.scheduledFor?.trim() || '',
    });

    if (status === 'completed' || status === 'running') {
      await this.dispatchCampaignToRecipients(auth, doc, ownerScope);
      await doc.save();
    }

    return this.toDto(doc);
  }

  async launchCampaign(
    auth: { userId: string; tenantId: string; email: string; name?: string },
    id: string,
  ) {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Campaign not found.');
    }
    const ownerScope = await resolveOwnerScopeFilter(this.campaignModel.db, auth);
    const doc = await this.campaignModel
      .findOne({
        _id: new Types.ObjectId(id),
        tenantId: new Types.ObjectId(auth.tenantId),
        ...ownerScope,
      })
      .exec();
    if (!doc) throw new NotFoundException('Campaign not found.');

    await this.dispatchCampaignToRecipients(auth, doc, ownerScope);
    await doc.save();
    return this.toDto(doc);
  }

  async retargetNonResponders(
    auth: { userId: string; tenantId: string; email: string; name?: string },
    sourceCampaignId: string,
    dto: RetargetCampaignDto,
  ) {
    if (!Types.ObjectId.isValid(sourceCampaignId)) {
      throw new NotFoundException('Source campaign not found.');
    }
    const tenantObjectId = new Types.ObjectId(auth.tenantId);
    const ownerScope = await resolveOwnerScopeFilter(this.campaignModel.db, auth);
    const source = await this.campaignModel
      .findOne({
        _id: new Types.ObjectId(sourceCampaignId),
        tenantId: tenantObjectId,
        ...ownerScope,
      })
      .exec();
    if (!source) throw new NotFoundException('Source campaign not found.');

    const nonResponders = (source.recipients || []).filter((r) =>
      ['sent', 'delivered', 'read'].includes(r.status),
    );
    if (nonResponders.length === 0) {
      throw new BadRequestException(
        'No non-responding recipients left to retarget in this campaign.',
      );
    }

    const followUpBody =
      dto?.messageBody?.trim() ||
      `Hi {{name}}, following up on our recent WhatsApp update from ${source.name}. Reply here if you'd like pricing or a quick call!`;
    const sendNow = dto?.sendNow !== false;

    const followUpDoc = await this.campaignModel.create({
      tenantId: tenantObjectId,
      ownerId: new Types.ObjectId(auth.userId),
      name: dto?.name?.trim() || `Follow-Up: ${source.name}`,
      templateName: source.templateName || 'followup_drip_v1',
      sendMode: source.sendMode || 'text',
      language: source.language || 'hinglish',
      channel: 'whatsapp_ai_drip',
      targetSegment: source.targetSegment,
      segmentFilters: source.segmentFilters || {},
      parentCampaignId: source._id.toString(),
      messageBody: followUpBody,
      ctaLabel: dto?.ctaLabel?.trim() || source.ctaLabel || 'Reply Now',
      audienceCount: nonResponders.length,
      sentCount: 0,
      deliveredCount: 0,
      readCount: 0,
      repliedCount: 0,
      failedCount: 0,
      skippedDndCount: 0,
      recipients: [],
      attributedRevenue: 0,
      status: sendNow ? 'completed' : 'draft',
      scheduledFor: '',
    });

    if (sendNow) {
      const db = this.campaignModel.db;
      const optOutConvs = await db
        .collection('conversations')
        .find({ tenantId: tenantObjectId, whatsappOptOut: true }, { projection: { phone: 1 } })
        .toArray();
      const optOutPhones = new Set(
        optOutConvs
          .map((c) => extractLast10Digits(String(c.phone || '')))
          .filter((d) => d.length >= 10),
      );
      const dndLeadRows = await db
        .collection('leads')
        .find({ tenantId: tenantObjectId, doNotCall: true }, { projection: { phone: 1 } })
        .toArray();
      const dndLeadPhones = new Set(
        dndLeadRows
          .map((l) => extractLast10Digits(String(l.phone || '')))
          .filter((d) => d.length >= 10),
      );

      const nowIso = new Date().toISOString();
      const nextRecipients: CampaignRecipientEntry[] = [];
      for (const rec of nonResponders) {
        const p10 = extractLast10Digits(rec.phone);
        if (optOutPhones.has(p10) || dndLeadPhones.has(p10)) {
          nextRecipients.push({
            ...rec,
            status: 'opted_out',
            deliveryProvider: 'skipped_dnd',
            error: 'Excluded by DND / Opt-Out guard',
            sentAt: nowIso,
          });
          continue;
        }
        const dispatch = await this.inboxService.dispatchAutomatedWhatsApp({
          tenantId: auth.tenantId,
          userId: auth.userId,
          actorName: auth.name || auth.email.split('@')[0],
          linkedEntityType: rec.entityType,
          linkedEntityId: rec.recipientId,
          contactName: rec.contactName,
          company: rec.company,
          phone: rec.phone,
          messageBody: followUpBody,
          sendMode: followUpDoc.sendMode || 'text',
          metaTemplateName: followUpDoc.templateName,
          languageCode: followUpDoc.language === 'english' ? 'en' : 'hi',
          campaignId: followUpDoc._id.toString(),
          campaignName: followUpDoc.name,
        });

        const st = dispatch.skippedDnd
          ? 'opted_out'
          : dispatch.status === 'failed'
            ? 'failed'
            : dispatch.status === 'delivered'
              ? 'delivered'
              : 'sent';

        nextRecipients.push({
          recipientId: rec.recipientId,
          entityType: rec.entityType,
          contactName: rec.contactName,
          company: rec.company,
          phone: rec.phone,
          status: st,
          deliveryProvider: dispatch.skippedDnd
            ? 'skipped_dnd'
            : dispatch.deliveryProvider || 'crm_local',
          externalMessageId: dispatch.externalMessageId || '',
          conversationId: dispatch.conversationId || '',
          messageId: dispatch.messageId || '',
          renderedMessage: dispatch.renderedMessage || followUpBody,
          error: dispatch.deliveryError || dispatch.reason || '',
          replyPreview: '',
          sentAt: nowIso,
          deliveredAt: st === 'delivered' ? nowIso : '',
          readAt: '',
          repliedAt: '',
        });
      }
      const metrics = this.recomputeMetricsFromRecipients(nextRecipients);
      followUpDoc.recipients = nextRecipients;
      followUpDoc.audienceCount = metrics.audienceCount;
      followUpDoc.sentCount = metrics.sentCount;
      followUpDoc.deliveredCount = metrics.deliveredCount;
      followUpDoc.readCount = metrics.readCount;
      followUpDoc.repliedCount = metrics.repliedCount;
      followUpDoc.failedCount = metrics.failedCount;
      followUpDoc.skippedDndCount = metrics.skippedDndCount;
      followUpDoc.markModified('recipients');
      await followUpDoc.save();
    }

    return this.toDto(followUpDoc);
  }

  async toggleRecipientOptOut(
    auth: { userId: string; tenantId: string },
    id: string,
    body: { phone: string; optOut: boolean },
  ) {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Campaign not found.');
    }
    if (!body?.phone?.trim()) {
      throw new BadRequestException('Recipient phone number is required.');
    }
    const ownerScope = await resolveOwnerScopeFilter(this.campaignModel.db, auth);
    const doc = await this.campaignModel
      .findOne({
        _id: new Types.ObjectId(id),
        tenantId: new Types.ObjectId(auth.tenantId),
        ...ownerScope,
      })
      .exec();
    if (!doc) throw new NotFoundException('Campaign not found.');

    const optOut = Boolean(body.optOut);
    await this.inboxService.setPhoneOptOut(auth.tenantId, body.phone, optOut);

    const target10 = extractLast10Digits(body.phone);
    const nextRecipients = (doc.recipients || []).map((r) => {
      if (extractLast10Digits(r.phone) !== target10) return r;
      if (optOut) {
        return {
          ...r,
          status: 'opted_out' as const,
          deliveryProvider: 'skipped_dnd' as const,
          error: 'Marked Opt-Out / DND',
        };
      }
      const restoredStatus = r.repliedAt
        ? ('replied' as const)
        : r.readAt
          ? ('read' as const)
          : r.deliveredAt
            ? ('delivered' as const)
            : ('sent' as const);
      return {
        ...r,
        status: restoredStatus,
        deliveryProvider:
          r.deliveryProvider === 'skipped_dnd'
            ? ('crm_local' as const)
            : r.deliveryProvider,
        error: '',
      };
    });

    const metrics = this.recomputeMetricsFromRecipients(nextRecipients);
    doc.recipients = nextRecipients;
    doc.skippedDndCount = metrics.skippedDndCount;
    doc.sentCount = metrics.sentCount;
    doc.deliveredCount = metrics.deliveredCount;
    doc.readCount = metrics.readCount;
    doc.repliedCount = metrics.repliedCount;
    doc.failedCount = metrics.failedCount;
    doc.markModified('recipients');
    await doc.save();

    return this.toDto(doc);
  }

  async update(
    auth: { userId: string; tenantId: string },
    id: string,
    dto: Partial<CreateCampaignDto>,
  ) {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Campaign not found.');
    }
    const ownerScope = await resolveOwnerScopeFilter(this.campaignModel.db, auth);
    const doc = await this.campaignModel
      .findOne({
        _id: new Types.ObjectId(id),
        tenantId: new Types.ObjectId(auth.tenantId),
        ...ownerScope,
      })
      .exec();
    if (!doc) throw new NotFoundException('Campaign not found.');

    if (dto.name !== undefined) doc.name = dto.name.trim();
    if (dto.templateName !== undefined)
      doc.templateName = dto.templateName.trim();
    if (dto.sendMode !== undefined) doc.sendMode = dto.sendMode;
    if (dto.language !== undefined) doc.language = dto.language;
    if (dto.channel !== undefined) doc.channel = dto.channel;
    if (dto.targetSegment !== undefined) doc.targetSegment = dto.targetSegment;
    if (dto.messageBody !== undefined) doc.messageBody = dto.messageBody.trim();
    if (dto.ctaLabel !== undefined) doc.ctaLabel = dto.ctaLabel.trim();
    if (dto.status !== undefined) doc.status = dto.status;
    if (dto.scheduledFor !== undefined)
      doc.scheduledFor = dto.scheduledFor.trim();

    await doc.save();
    return this.toDto(doc);
  }

  async remove(auth: { userId: string; tenantId: string }, id: string) {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Campaign not found.');
    }
    const ownerScope = await resolveOwnerScopeFilter(this.campaignModel.db, auth);
    await this.campaignModel
      .deleteOne({
        _id: new Types.ObjectId(id),
        tenantId: new Types.ObjectId(auth.tenantId),
        ...ownerScope,
      })
      .exec();
    return { success: true, id };
  }
}
