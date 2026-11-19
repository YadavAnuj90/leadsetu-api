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
  CampaignStatus,
  CreateCampaignDto,
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
    ],
  })
  targetSegment!: CampaignSegment;

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
      'leadsetu_super_secret_access_key_2026_delhi_ncr';
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
      ] = await Promise.all([
        leadsCol.countDocuments({ tenantId: tenantObjectId, ...ownerScope }),
        leadsCol.countDocuments({
          tenantId: tenantObjectId,
          ...ownerScope,
          $or: [{ aiScore: { $gte: 75 } }, { aiLabel: 'Hot' }],
        }),
        leadsCol.countDocuments({
          tenantId: tenantObjectId,
          ...ownerScope,
          city: { $regex: /noida|delhi|gurugram|gurgaon|ghaziabad|faridabad/i },
        }),
        leadsCol.countDocuments({
          tenantId: tenantObjectId,
          ...ownerScope,
          source: 'indiamart',
        }),
        contactsCol.countDocuments({
          tenantId: tenantObjectId,
          ...ownerScope,
          gstin: { $exists: true, $ne: '' },
        }),
      ]);

      return {
        all_leads: totalLeads,
        hot_leads: hotLeads,
        noida_delhi_ncr: ncrLeads,
        indiamart_buyers: indiamartLeads,
        gst_customers: gstContacts,
        rawDbCounts: {
          totalLeads,
          hotLeads,
          ncrLeads,
          indiamartLeads,
          gstContacts,
        },
      };
    } catch {
      return {
        all_leads: 0,
        hot_leads: 0,
        noida_delhi_ncr: 0,
        indiamart_buyers: 0,
        gst_customers: 0,
        rawDbCounts: {
          totalLeads: 0,
          hotLeads: 0,
          ncrLeads: 0,
          indiamartLeads: 0,
          gstContacts: 0,
        },
      };
    }
  }

  private async resolveSegmentRecipients(
    tenantObjectId: Types.ObjectId,
    segment: CampaignSegment,
    ownerScope: Record<string, unknown> = {},
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
    }>
  > {
    const db = this.campaignModel.db;
    const leadsCol = db.collection('leads');
    const contactsCol = db.collection('contacts');
    const convsCol = db.collection('conversations');

    let rows: Array<Record<string, unknown>> = [];
    let entityType: 'lead' | 'contact' = 'lead';

    if (segment === 'gst_customers') {
      entityType = 'contact';
      rows = await contactsCol
        .find({
          tenantId: tenantObjectId,
          ...ownerScope,
          gstin: { $exists: true, $ne: '' },
          phone: { $exists: true, $ne: '' },
        })
        .sort({ updatedAt: -1 })
        .limit(200)
        .toArray();
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
      const optedOut = hasDndTag || optOutPhones.has(last10);

      results.push({
        recipientId: String(r._id),
        entityType,
        contactName: String(r.name || 'Buyer').trim(),
        company: String(r.company || '').trim(),
        phone,
        city: String(r.city || 'Delhi-NCR').trim(),
        estimatedValue: Number(r.estimatedValue ?? r.lifetimeValue ?? 0) || 0,
        optedOut,
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

  private toDto(doc: CampaignDocument) {
    const raw = doc.toObject() as unknown as Record<string, unknown> & {
      createdAt?: Date;
      updatedAt?: Date;
    };
    const sent = doc.sentCount || 0;
    const delivered = doc.deliveredCount || 0;
    const read = doc.readCount || 0;
    const replied = doc.repliedCount || 0;

    return {
      id: doc._id.toString(),
      tenantId: doc.tenantId.toString(),
      name: doc.name,
      templateName: doc.templateName || 'b2b_catalogue_hinglish_v2',
      sendMode: doc.sendMode || 'text',
      language: doc.language || 'hinglish',
      channel: doc.channel || 'whatsapp_cloud',
      targetSegment: doc.targetSegment || 'all_leads',
      messageBody: doc.messageBody,
      ctaLabel: doc.ctaLabel || 'Get Instant Quote',
      audienceCount: doc.audienceCount || 0,
      sentCount: sent,
      deliveredCount: delivered,
      readCount: read,
      repliedCount: replied,
      failedCount: doc.failedCount || 0,
      skippedDndCount: doc.skippedDndCount || 0,
      recipients: doc.recipients || [],
      deliveryRate: sent > 0 ? Math.round((delivered / sent) * 100) : 0,
      readRate: delivered > 0 ? Math.round((read / delivered) * 100) : 0,
      replyRate: read > 0 ? Math.round((replied / read) * 100) : 0,
      attributedRevenue: doc.attributedRevenue || 0,
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

    const totalSent = all.reduce((s, c) => s + (c.sentCount || 0), 0);
    const totalDelivered = all.reduce((s, c) => s + (c.deliveredCount || 0), 0);
    const totalRead = all.reduce((s, c) => s + (c.readCount || 0), 0);
    const totalReplies = all.reduce((s, c) => s + (c.repliedCount || 0), 0);
    const totalAttributedRevenue = all.reduce(
      (s, c) => s + (c.attributedRevenue || 0),
      0,
    );

    return {
      data: docs.map((d) => this.toDto(d)),
      stats: {
        totalCampaigns: all.length,
        totalSent,
        totalDelivered,
        totalRead,
        totalReplies,
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
    return this.toDto(doc);
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
