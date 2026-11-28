import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Model, Types } from 'mongoose';
import { createHash, randomBytes } from 'crypto';
import { Tenant, TenantDocument } from '../auth/schemas/tenant.schema';
import { User, UserDocument } from '../auth/schemas/user.schema';
import { Lead, LeadDocument } from '../leads/schemas/lead.schema';
import { Deal, DealDocument } from '../deals/schemas/deal.schema';
import {
  ConversationThread,
  ConversationDocument,
} from '../inbox/schemas/conversation.schema';
import {
  MetaCapiDispatchStatus,
  MetaCapiEvent,
  MetaCapiEventDocument,
  MetaCapiEventName,
} from './schemas/meta-capi-event.schema';
import {
  decryptSecret,
  encryptSecret,
  maskSecret,
  normalizeIndianPhone,
} from '../auth/identity.util';
import {
  SimulateCtwaInboundDto,
  TriggerManualCapiEventDto,
  UpdateMetaCapiConfigDto,
} from './dto/meta-capi.dto';

interface AuthContext {
  userId: string;
  tenantId: string;
  email: string;
  role: string;
}

interface InvoiceLean {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  invoiceNumber?: string;
  clientName?: string;
  phone?: string;
  email?: string;
  grandTotal?: number;
  status?: string;
}

export interface FireCapiEventInput {
  tenantId: string;
  eventName: MetaCapiEventName;
  entityType: 'lead' | 'deal' | 'invoice' | 'conversation';
  entityId: string;
  entityLabel?: string;
  phone?: string;
  email?: string;
  ctwaClid?: string;
  adId?: string;
  adHeadline?: string;
  adSourceUrl?: string;
  valueInr?: number;
  triggeredBy?: string;
  respectAutoToggle?: boolean;
}

function last10(raw?: string): string {
  const digits = String(raw || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

function buildPhoneSuffixRegex(phone10: string): string {
  return `${phone10.split('').join('\\D*')}\\D*$`;
}

function sha256Lower(raw?: string): string | undefined {
  const clean = String(raw || '').trim().toLowerCase();
  if (!clean) return undefined;
  return createHash('sha256').update(clean).digest('hex');
}

function hashPhoneForMeta(raw?: string): string | undefined {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length < 10) return undefined;
  const e164Digits = digits.length === 10 ? `91${digits}` : digits;
  return createHash('sha256').update(e164Digits).digest('hex');
}

@Injectable()
export class MetaCapiService {
  constructor(
    @InjectModel(MetaCapiEvent.name)
    private readonly eventModel: Model<MetaCapiEventDocument>,
    @InjectModel(Tenant.name)
    private readonly tenantModel: Model<TenantDocument>,
    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>,
    @InjectModel(Lead.name)
    private readonly leadModel: Model<LeadDocument>,
    @InjectModel(Deal.name)
    private readonly dealModel: Model<DealDocument>,
    @InjectModel('Invoice')
    private readonly invoiceModel: Model<InvoiceLean>,
    @InjectModel(ConversationThread.name)
    private readonly convModel: Model<ConversationDocument>,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  async verifyAuth(authHeader?: string): Promise<AuthContext> {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Authorization token is required.');
    }
    const token = authHeader.slice(7).trim();
    const secret =
      this.configService.get<string>('JWT_SECRET') ||
      'leadsetu_super_secret_access_key_2026';

    try {
      const payload = await this.jwtService.verifyAsync<{
        sub: string;
        tenantId: string;
        email: string;
        role?: string;
      }>(token, { secret });

      let role = String(payload.role || '').trim().toLowerCase();
      if (!role && Types.ObjectId.isValid(payload.sub)) {
        const user = await this.userModel
          .findById(payload.sub)
          .select('role')
          .lean();
        role = String(user?.role || 'sales').trim().toLowerCase();
      }

      return {
        userId: payload.sub,
        tenantId: payload.tenantId,
        email: payload.email,
        role: role || 'sales',
      };
    } catch {
      throw new UnauthorizedException('Invalid or expired authentication token.');
    }
  }

  private toEventDto(doc: MetaCapiEventDocument) {
    const plain = doc.toObject() as unknown as Record<string, unknown>;
    return {
      id: String(doc._id),
      eventId: doc.eventId,
      eventName: doc.eventName,
      status: doc.status,
      entityType: doc.entityType,
      entityId: doc.entityId,
      entityLabel: doc.entityLabel || '',
      phone: doc.phone || '',
      email: doc.email || '',
      ctwaClid: doc.ctwaClid || '',
      adId: doc.adId || '',
      adHeadline: doc.adHeadline || '',
      adSourceUrl: doc.adSourceUrl || '',
      valueInr: Number(doc.valueInr || 0),
      currency: doc.currency || 'INR',
      pixelId: doc.pixelId || '',
      testEventCode: doc.testEventCode || '',
      triggeredBy: doc.triggeredBy || '',
      requestPayload: doc.requestPayload || {},
      metaResponse: doc.metaResponse || {},
      errorMessage: doc.errorMessage || '',
      httpStatus: Number(doc.httpStatus || 0),
      createdAt:
        plain.createdAt instanceof Date
          ? plain.createdAt.toISOString()
          : String(plain.createdAt || new Date().toISOString()),
    };
  }

  private async resolveAttributionContext(input: FireCapiEventInput): Promise<{
    phone: string;
    email: string;
    ctwaClid: string;
    adId: string;
    adHeadline: string;
    adSourceUrl: string;
  }> {
    let phone = String(input.phone || '').trim();
    let email = String(input.email || '').trim().toLowerCase();
    let ctwaClid = String(input.ctwaClid || '').trim();
    let adId = String(input.adId || '').trim();
    let adHeadline = String(input.adHeadline || '').trim();
    let adSourceUrl = String(input.adSourceUrl || '').trim();

    if (ctwaClid && adId && (phone || email)) {
      return { phone, email, ctwaClid, adId, adHeadline, adSourceUrl };
    }

    const tenantObjId = new Types.ObjectId(input.tenantId);

    if (input.entityType === 'lead' && Types.ObjectId.isValid(input.entityId)) {
      const lead = await this.leadModel
        .findOne({ _id: new Types.ObjectId(input.entityId), tenantId: tenantObjId })
        .select('phone email ctwaClid adId adHeadline adSourceUrl')
        .lean();
      if (lead) {
        phone = phone || String(lead.phone || '');
        email = email || String(lead.email || '');
        ctwaClid = ctwaClid || String(lead.ctwaClid || '');
        adId = adId || String(lead.adId || '');
        adHeadline = adHeadline || String(lead.adHeadline || '');
        adSourceUrl = adSourceUrl || String(lead.adSourceUrl || '');
      }
    }

    // Cross-lookup CTWA attribution by last10 phone or email across Leads & Conversations
    if (!ctwaClid || !adId) {
      const phone10 = last10(phone);
      const orFilters: Record<string, unknown>[] = [];
      if (phone10.length === 10) {
        orFilters.push({ phone: { $regex: buildPhoneSuffixRegex(phone10) } });
      }
      if (email) {
        orFilters.push({ email });
      }

      if (orFilters.length > 0) {
        const attributedLead = await this.leadModel
          .findOne({
            tenantId: tenantObjId,
            $and: [
              { $or: orFilters },
              {
                $or: [
                  { adPlatform: 'meta_ctwa' },
                  { ctwaClid: { $ne: '' } },
                  { adId: { $ne: '' } },
                ],
              },
            ],
          })
          .sort({ updatedAt: -1 })
          .select('phone email ctwaClid adId adHeadline adSourceUrl')
          .lean();

        if (attributedLead) {
          ctwaClid = ctwaClid || String(attributedLead.ctwaClid || '');
          adId = adId || String(attributedLead.adId || '');
          adHeadline = adHeadline || String(attributedLead.adHeadline || '');
          adSourceUrl = adSourceUrl || String(attributedLead.adSourceUrl || '');
          phone = phone || String(attributedLead.phone || '');
          email = email || String(attributedLead.email || '');
        }
      }

      if ((!ctwaClid || !adId) && phone10.length === 10) {
        const attributedConv = await this.convModel
          .findOne({
            tenantId: tenantObjId,
            phone: { $regex: buildPhoneSuffixRegex(phone10) },
            $or: [
              { adPlatform: 'meta_ctwa' },
              { ctwaClid: { $ne: '' } },
              { adId: { $ne: '' } },
            ],
          })
          .sort({ updatedAt: -1 })
          .select('ctwaClid adId adHeadline adSourceUrl phone')
          .lean();

        if (attributedConv) {
          ctwaClid = ctwaClid || String(attributedConv.ctwaClid || '');
          adId = adId || String(attributedConv.adId || '');
          adHeadline = adHeadline || String(attributedConv.adHeadline || '');
          adSourceUrl = adSourceUrl || String(attributedConv.adSourceUrl || '');
        }
      }
    }

    return { phone, email, ctwaClid, adId, adHeadline, adSourceUrl };
  }

  private async dispatchToMetaGraph(params: {
    pixelId: string;
    accessToken: string;
    enabled: boolean;
    payloadBody: Record<string, unknown>;
  }): Promise<{
    status: MetaCapiDispatchStatus;
    httpStatus: number;
    metaResponse: Record<string, unknown>;
    errorMessage: string;
  }> {
    if (!params.enabled || !params.pixelId || !params.accessToken) {
      return {
        status: 'local_simulated',
        httpStatus: 200,
        metaResponse: {
          mode: 'local_simulation',
          events_received: 1,
          note: !params.enabled
            ? 'Live Meta CAPI dispatch is paused; event logged in sandbox simulation mode.'
            : 'Configure Pixel ID and CAPI Access Token to dispatch directly to Meta Graph API v21.0.',
        },
        errorMessage: '',
      };
    }

    const endpoint = `https://graph.facebook.com/v21.0/${encodeURIComponent(params.pixelId)}/events?access_token=${encodeURIComponent(params.accessToken)}`;
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params.payloadBody),
        signal: AbortSignal.timeout(10000),
      });
      const json = (await res.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      if (res.ok) {
        return {
          status: 'sent',
          httpStatus: res.status,
          metaResponse: json,
          errorMessage: '',
        };
      }
      const errObj = json.error as Record<string, unknown> | undefined;
      return {
        status: 'failed',
        httpStatus: res.status,
        metaResponse: json,
        errorMessage: String(
          errObj?.message || `Meta Graph API returned HTTP ${res.status}`,
        ),
      };
    } catch (err) {
      return {
        status: 'failed',
        httpStatus: 0,
        metaResponse: {},
        errorMessage:
          err instanceof Error ? err.message : 'Meta Graph API network failure',
      };
    }
  }

  async fireConversionEvent(input: FireCapiEventInput) {
    if (!Types.ObjectId.isValid(input.tenantId)) return null;
    const tenantObjId = new Types.ObjectId(input.tenantId);

    const tenant = await this.tenantModel.findById(tenantObjId);
    if (!tenant) return null;

    const cfg = tenant.metaCapi;

    if (input.respectAutoToggle) {
      if (input.eventName === 'LeadSubmitted' && cfg?.autoFireOnCtwaInbound === false) {
        return null;
      }
      if (
        input.eventName === 'QualifiedLead' &&
        cfg?.autoFireOnLeadQualified === false
      ) {
        return null;
      }
      if (
        input.eventName === 'Purchase' &&
        input.entityType === 'deal' &&
        cfg?.autoFireOnDealWon === false
      ) {
        return null;
      }
      if (
        input.eventName === 'Purchase' &&
        input.entityType === 'invoice' &&
        cfg?.autoFireOnInvoicePaid === false
      ) {
        return null;
      }
    }

    const attr = await this.resolveAttributionContext(input);

    // For automatic CRM lifecycle hooks, only fire if this contact has CTWA attribution or live Meta pixel is configured
    const hasMetaAttribution = Boolean(attr.ctwaClid || attr.adId);
    if (input.respectAutoToggle && !hasMetaAttribution && !cfg?.enabled) {
      return null;
    }

    // Deduplicate identical automatic lifecycle event per entity
    if (input.respectAutoToggle && input.entityId) {
      const existing = await this.eventModel.findOne({
        tenantId: tenantObjId,
        entityType: input.entityType,
        entityId: input.entityId,
        eventName: input.eventName,
        status: { $in: ['sent', 'local_simulated'] },
      });
      if (existing) {
        return this.toEventDto(existing);
      }
    }

    const eventId = `capi_${input.eventName.toLowerCase()}_${Date.now()}_${randomBytes(3).toString('hex')}`;
    const eventTime = Math.floor(Date.now() / 1000);

    const userData: Record<string, unknown> = {};
    const ph = hashPhoneForMeta(attr.phone);
    const em = sha256Lower(attr.email);
    if (ph) userData.ph = [ph];
    if (em) userData.em = [em];
    if (attr.ctwaClid) userData.ctwa_clid = attr.ctwaClid;

    const valueInr = Number(input.valueInr || 0);
    const customData: Record<string, unknown> = {
      currency: 'INR',
      value: Number.isFinite(valueInr) ? Math.max(0, valueInr) : 0,
    };
    if (attr.adId) customData.ad_id = attr.adId;
    if (attr.adHeadline) customData.content_name = attr.adHeadline;

    const payloadBody: Record<string, unknown> = {
      data: [
        {
          event_name: input.eventName,
          event_time: eventTime,
          event_id: eventId,
          action_source: attr.ctwaClid
            ? 'business_messaging'
            : 'system_generated',
          ...(attr.ctwaClid ? { messaging_channel: 'whatsapp' } : {}),
          ...(attr.adSourceUrl ? { event_source_url: attr.adSourceUrl } : {}),
          user_data: userData,
          custom_data: customData,
        },
      ],
      ...(cfg?.testEventCode ? { test_event_code: cfg.testEventCode } : {}),
    };

    const decryptedToken = decryptSecret(
      cfg?.accessTokenEncrypted || '',
      input.tenantId,
    );

    const result = await this.dispatchToMetaGraph({
      pixelId: String(cfg?.pixelId || '').trim(),
      accessToken: decryptedToken,
      enabled: Boolean(cfg?.enabled),
      payloadBody,
    });

    const created = await this.eventModel.create({
      tenantId: tenantObjId,
      eventId,
      eventName: input.eventName,
      status: result.status,
      entityType: input.entityType,
      entityId: input.entityId,
      entityLabel: input.entityLabel || '',
      phone: attr.phone,
      email: attr.email,
      ctwaClid: attr.ctwaClid,
      adId: attr.adId,
      adHeadline: attr.adHeadline,
      adSourceUrl: attr.adSourceUrl,
      valueInr: customData.value as number,
      currency: 'INR',
      pixelId: String(cfg?.pixelId || '').trim(),
      testEventCode: String(cfg?.testEventCode || '').trim(),
      triggeredBy: input.triggeredBy || 'auto_lifecycle',
      requestPayload: payloadBody,
      metaResponse: result.metaResponse,
      errorMessage: result.errorMessage,
      httpStatus: result.httpStatus,
      eventsReceived: Number(result.metaResponse?.events_received || (result.status === 'failed' ? 0 : 1)),
      fbtraceId: String(result.metaResponse?.fbtrace_id || ''),
      firedAt: new Date().toISOString(),
    });

    await this.tenantModel.updateOne(
      { _id: tenantObjId },
      {
        $set: {
          'metaCapi.lastFiredAt': new Date().toISOString(),
          'metaCapi.lastStatus': result.status,
          'metaCapi.lastError': result.errorMessage,
        },
      },
    );

    return this.toEventDto(created);
  }

  async getConfigAndStats(authHeader?: string) {
    const auth = await this.verifyAuth(authHeader);
    const tenantObjId = new Types.ObjectId(auth.tenantId);

    const tenant = await this.tenantModel.findById(tenantObjId).lean();
    if (!tenant) throw new NotFoundException('Workspace not found.');

    const cfg = tenant.metaCapi || {
      enabled: false,
      pixelId: '',
      accessTokenEncrypted: '',
      accessTokenMask: '',
      testEventCode: '',
      autoFireOnCtwaInbound: true,
      autoFireOnLeadQualified: true,
      autoFireOnDealWon: true,
      autoFireOnInvoicePaid: true,
      lastFiredAt: '',
      lastStatus: '',
      lastError: '',
    };

    const [events, ctwaLeads, tenantDeals, totalEventsCount, sentEventsCount, simulatedCount, failedCount] =
      await Promise.all([
        this.eventModel
          .find({ tenantId: tenantObjId })
          .sort({ createdAt: -1 })
          .limit(50),
        this.leadModel
          .find({
            tenantId: tenantObjId,
            $or: [
              { adPlatform: 'meta_ctwa' },
              { ctwaClid: { $ne: '' } },
              { adId: { $ne: '' } },
              { source: 'meta_ads' },
            ],
          })
          .select('name phone email status estimatedValue adId adHeadline adSourceUrl ctwaClid createdAt')
          .lean(),
        this.dealModel
          .find({ tenantId: tenantObjId })
          .select('title contactPhone contactEmail value stage stageCategory source')
          .lean(),
        this.eventModel.countDocuments({ tenantId: tenantObjId }),
        this.eventModel.countDocuments({ tenantId: tenantObjId, status: 'sent' }),
        this.eventModel.countDocuments({
          tenantId: tenantObjId,
          status: 'local_simulated',
        }),
        this.eventModel.countDocuments({ tenantId: tenantObjId, status: 'failed' }),
      ]);

    const purchaseAgg = await this.eventModel.aggregate([
      {
        $match: {
          tenantId: tenantObjId,
          eventName: 'Purchase',
          status: { $in: ['sent', 'local_simulated'] },
        },
      },
      { $group: { _id: null, total: { $sum: '$valueInr' }, count: { $sum: 1 } } },
    ]);

    // Map last10(phone) / email -> ad group key so closed deals roll up to the originating Meta Ad creative
    const adMap = new Map<
      string,
      {
        adId: string;
        adHeadline: string;
        inquiries: number;
        qualifiedCount: number;
        wonDealsCount: number;
        closedRevenueInr: number;
        pipelineValueInr: number;
        capiEventsCount: number;
      }
    >();

    const phoneToAdKey = new Map<string, string>();
    const emailToAdKey = new Map<string, string>();

    const ensureAdBucket = (adId?: string, adHeadline?: string) => {
      const cleanId = String(adId || '').trim();
      const cleanHeadline = String(adHeadline || '').trim();
      const key = cleanId || cleanHeadline || 'meta_ctwa_general';
      if (!adMap.has(key)) {
        adMap.set(key, {
          adId: cleanId || 'CTWA-AD',
          adHeadline: cleanHeadline || (cleanId ? `Ad #${cleanId}` : 'Meta Click-to-WhatsApp Ad'),
          inquiries: 0,
          qualifiedCount: 0,
          wonDealsCount: 0,
          closedRevenueInr: 0,
          pipelineValueInr: 0,
          capiEventsCount: 0,
        });
      }
      return key;
    };

    for (const lead of ctwaLeads) {
      const key = ensureAdBucket(lead.adId, lead.adHeadline);
      const bucket = adMap.get(key)!;
      bucket.inquiries += 1;
      if (['qualified', 'proposal', 'won'].includes(String(lead.status || '').toLowerCase())) {
        bucket.qualifiedCount += 1;
      }
      const p10 = last10(lead.phone);
      if (p10.length === 10 && !phoneToAdKey.has(p10)) {
        phoneToAdKey.set(p10, key);
      }
      const em = String(lead.email || '').trim().toLowerCase();
      if (em && !emailToAdKey.has(em)) {
        emailToAdKey.set(em, key);
      }
    }

    for (const deal of tenantDeals) {
      const p10 = last10(deal.contactPhone);
      const em = String(deal.contactEmail || '').trim().toLowerCase();
      const matchedKey =
        (p10 && phoneToAdKey.get(p10)) ||
        (em && emailToAdKey.get(em)) ||
        (deal.source === 'meta_ads' ? ensureAdBucket('', 'Meta Ads Direct') : '');
      if (!matchedKey) continue;
      const bucket = adMap.get(matchedKey);
      if (!bucket) continue;

      const stageCat = String(deal.stageCategory || '').toLowerCase();
      const stageStr = String(deal.stage || '').toLowerCase();
      const isWon = stageCat === 'won' || stageStr === 'won';
      const isLost = stageCat === 'lost' || stageStr === 'lost';
      const val = Number(deal.value || 0);
      if (isWon) {
        bucket.wonDealsCount += 1;
        bucket.closedRevenueInr += val;
      } else if (!isLost) {
        bucket.pipelineValueInr += val;
      }
    }

    const eventCountsByAd = await this.eventModel.aggregate([
      { $match: { tenantId: tenantObjId } },
      {
        $group: {
          _id: { adId: '$adId', adHeadline: '$adHeadline' },
          count: { $sum: 1 },
        },
      },
    ]);

    for (const row of eventCountsByAd) {
      const rowId = row._id as { adId?: string; adHeadline?: string };
      if (!rowId?.adId && !rowId?.adHeadline) continue;
      const key = ensureAdBucket(rowId.adId, rowId.adHeadline);
      const bucket = adMap.get(key)!;
      bucket.capiEventsCount += Number(row.count || 0);
    }

    const adRoasBreakdown = Array.from(adMap.values()).sort(
      (a, b) => b.closedRevenueInr - a.closedRevenueInr || b.inquiries - a.inquiries,
    );

    const monthlyAdSpendInr = Math.max(0, Number(cfg.monthlyAdSpendInr || 0) || 0);
    const qualifiedLeadsCount = adRoasBreakdown.reduce(
      (sum, row) => sum + row.qualifiedCount,
      0,
    );
    const wonDealsCount = adRoasBreakdown.reduce(
      (sum, row) => sum + row.wonDealsCount,
      0,
    );
    const wonRevenueInr = adRoasBreakdown.reduce(
      (sum, row) => sum + row.closedRevenueInr,
      0,
    );
    const pipelineValueInr = adRoasBreakdown.reduce(
      (sum, row) => sum + row.pipelineValueInr,
      0,
    );
    const effectiveRevenue = wonRevenueInr || Number(purchaseAgg[0]?.total || 0);
    const roasMultiplier =
      monthlyAdSpendInr > 0
        ? Number((effectiveRevenue / monthlyAdSpendInr).toFixed(2))
        : 0;
    const cplInr =
      monthlyAdSpendInr > 0 && ctwaLeads.length > 0
        ? Math.round(monthlyAdSpendInr / ctwaLeads.length)
        : 0;
    const cpqlInr =
      monthlyAdSpendInr > 0 && qualifiedLeadsCount > 0
        ? Math.round(monthlyAdSpendInr / qualifiedLeadsCount)
        : 0;
    const leadToWonPct =
      ctwaLeads.length > 0
        ? Math.round((wonDealsCount / ctwaLeads.length) * 100)
        : 0;

    return {
      config: {
        enabled: Boolean(cfg.enabled),
        pixelId: String(cfg.pixelId || ''),
        hasAccessToken: Boolean(cfg.accessTokenEncrypted),
        accessTokenMask: String(cfg.accessTokenMask || ''),
        testEventCode: String(cfg.testEventCode || ''),
        autoFireOnCtwaInbound: cfg.autoFireOnCtwaInbound !== false,
        autoFireOnLeadQualified: cfg.autoFireOnLeadQualified !== false,
        autoFireOnDealWon: cfg.autoFireOnDealWon !== false,
        autoFireOnInvoicePaid: cfg.autoFireOnInvoicePaid !== false,
        monthlyAdSpendInr,
        lastFiredAt: String(cfg.lastFiredAt || ''),
        lastStatus: String(cfg.lastStatus || ''),
        lastError: String(cfg.lastError || ''),
      },
      stats: {
        totalEvents: totalEventsCount,
        sentEvents: sentEventsCount,
        simulatedEvents: simulatedCount,
        failedEvents: failedCount,
        ctwaLeadsCount: ctwaLeads.length,
        qualifiedLeadsCount,
        wonDealsCount,
        wonRevenueInr: effectiveRevenue,
        pipelineValueInr,
        monthlyAdSpendInr,
        roasMultiplier,
        cplInr,
        cpqlInr,
        leadToWonPct,
        attributedRevenueInr: Number(purchaseAgg[0]?.total || 0),
        purchaseEventsCount: Number(purchaseAgg[0]?.count || 0),
      },
      events: events.map((e) => this.toEventDto(e)),
      adRoasBreakdown,
    };
  }

  async updateConfig(authHeader: string | undefined, dto: UpdateMetaCapiConfigDto) {
    const auth = await this.verifyAuth(authHeader);
    if (!['owner', 'admin', 'super_admin'].includes(auth.role)) {
      throw new ForbiddenException(
        'Only workspace Owners or Admins can configure Meta Conversions API.',
      );
    }

    const tenant = await this.tenantModel.findById(new Types.ObjectId(auth.tenantId));
    if (!tenant) throw new NotFoundException('Workspace not found.');

    const prev = tenant.metaCapi || {
      enabled: false,
      pixelId: '',
      accessTokenEncrypted: '',
      accessTokenMask: '',
      testEventCode: '',
      autoFireOnCtwaInbound: true,
      autoFireOnLeadQualified: true,
      autoFireOnDealWon: true,
      autoFireOnInvoicePaid: true,
      lastFiredAt: '',
      lastStatus: '',
      lastError: '',
    };

    const nextPixelId =
      dto.pixelId !== undefined ? String(dto.pixelId).trim() : prev.pixelId;
    const rawNewToken =
      dto.accessToken !== undefined ? String(dto.accessToken).trim() : '';

    const accessTokenEncrypted = rawNewToken
      ? encryptSecret(rawNewToken, auth.tenantId)
      : prev.accessTokenEncrypted || '';
    const accessTokenMask = rawNewToken
      ? maskSecret(rawNewToken)
      : prev.accessTokenMask || '';

    const nextEnabled =
      dto.enabled !== undefined ? Boolean(dto.enabled) : Boolean(prev.enabled);

    if (nextEnabled && (!nextPixelId || !accessTokenEncrypted)) {
      throw new BadRequestException(
        'Meta Pixel / Dataset ID and Conversions API Access Token are required to enable live CAPI dispatch.',
      );
    }

    tenant.metaCapi = {
      enabled: nextEnabled,
      pixelId: nextPixelId,
      accessTokenEncrypted,
      accessTokenMask,
      testEventCode:
        dto.testEventCode !== undefined
          ? String(dto.testEventCode).trim()
          : prev.testEventCode || '',
      autoFireOnCtwaInbound:
        dto.autoFireOnCtwaInbound !== undefined
          ? Boolean(dto.autoFireOnCtwaInbound)
          : prev.autoFireOnCtwaInbound !== false,
      autoFireOnLeadQualified:
        dto.autoFireOnLeadQualified !== undefined
          ? Boolean(dto.autoFireOnLeadQualified)
          : prev.autoFireOnLeadQualified !== false,
      autoFireOnDealWon:
        dto.autoFireOnDealWon !== undefined
          ? Boolean(dto.autoFireOnDealWon)
          : prev.autoFireOnDealWon !== false,
      autoFireOnInvoicePaid:
        dto.autoFireOnInvoicePaid !== undefined
          ? Boolean(dto.autoFireOnInvoicePaid)
          : prev.autoFireOnInvoicePaid !== false,
      monthlyAdSpendInr:
        dto.monthlyAdSpendInr !== undefined
          ? Math.max(0, Number(dto.monthlyAdSpendInr) || 0)
          : Number(prev.monthlyAdSpendInr || 0) || 0,
      lastFiredAt: prev.lastFiredAt || '',
      lastStatus: prev.lastStatus || '',
      lastError: prev.lastError || '',
    };

    await tenant.save();
    return this.getConfigAndStats(authHeader);
  }

  async simulateCtwaClickAndLead(
    authHeader: string | undefined,
    dto: SimulateCtwaInboundDto,
  ) {
    const auth = await this.verifyAuth(authHeader);
    const tenantObjId = new Types.ObjectId(auth.tenantId);
    const ownerObjId = new Types.ObjectId(auth.userId);
    const tenant = await this.tenantModel.findById(tenantObjId).lean();
    if (!tenant) throw new NotFoundException('Workspace not found.');

    const contactName =
      String(dto.contactName || '').trim() || 'Rohan Malhotra';
    const rawPhone = String(dto.phone || '').trim() || '+91 98112 88991';
    const normalizedPhone = normalizeIndianPhone(rawPhone) || rawPhone;
    const phone10 = last10(normalizedPhone);
    const adId =
      String(dto.adId || '').trim() ||
      `12021${Math.floor(100000000 + Math.random() * 899999999)}`;
    const adHeadline =
      String(dto.adHeadline || '').trim() ||
      'Diwali Wholesale Servo Offer - NCR';
    const adSourceUrl =
      String(dto.sourceUrl || '').trim() ||
      `https://fb.me/ad/${adId.slice(-6)}`;
    const ctwaClid =
      String(dto.ctwaClid || '').trim() ||
      `ctwa_${Date.now()}_${randomBytes(4).toString('hex')}`;
    const inboundMessage =
      String(dto.message || '').trim() ||
      `Hi, saw your Meta Ad "${adHeadline}" — please share bulk quote & GST invoice details.`;
    const estimatedValue = Number(dto.estimatedValue || 125000);

    // 1. Upsert Lead with full Meta CTWA attribution
    let lead =
      phone10.length === 10
        ? await this.leadModel.findOne({
            tenantId: tenantObjId,
            phone: { $regex: buildPhoneSuffixRegex(phone10) },
          })
        : null;

    if (!lead) {
      lead = await this.leadModel.create({
        tenantId: tenantObjId,
        ownerId: ownerObjId,
        name: contactName,
        accountKind: 'business',
        company: '',
        phone: normalizedPhone,
        email: '',
        city: tenant.city || '',
        source: 'meta_ads',
        status: 'new',
        estimatedValue,
        tags: ['Meta CTWA Ad'],
        notes: `[Meta Ad Referral: ${adHeadline}] ${dto.adBody || inboundMessage}`,
        adPlatform: 'meta_ctwa',
        ctwaClid,
        adId,
        adHeadline,
        adSourceUrl,
        aiScore: 84,
        aiLabel: 'Hot',
        aiInsight: `High-intent Click-to-WhatsApp inbound from Meta Ad "${adHeadline}".`,
      });
    } else {
      lead.adPlatform = 'meta_ctwa';
      lead.ctwaClid = ctwaClid;
      lead.adId = adId;
      lead.adHeadline = adHeadline;
      lead.adSourceUrl = adSourceUrl;
      if (!lead.tags.includes('Meta CTWA Ad')) {
        lead.tags.push('Meta CTWA Ad');
      }
      if (!lead.estimatedValue && estimatedValue > 0) {
        lead.estimatedValue = estimatedValue;
      }
      await lead.save();
    }

    // 2. Upsert WhatsApp ConversationThread with CTWA referral metadata
    let conv =
      phone10.length === 10
        ? await this.convModel.findOne({
            tenantId: tenantObjId,
            channel: 'whatsapp',
            phone: { $regex: buildPhoneSuffixRegex(phone10) },
          })
        : null;

    const nowIso = new Date().toISOString();
    const referralMsg = {
      id: `ctwa_msg_${Date.now()}_${randomBytes(3).toString('hex')}`,
      direction: 'inbound' as const,
      content: `[Meta Ad: ${adHeadline}] ${inboundMessage}`,
      senderName: contactName,
      status: 'delivered' as const,
      deliveryProvider: 'meta_cloud' as const,
      createdAt: nowIso,
    };

    if (!conv) {
      conv = await this.convModel.create({
        tenantId: tenantObjId,
        ownerId: ownerObjId,
        contactName,
        company: lead.company || '',
        phone: normalizedPhone,
        city: lead.city || tenant.city || '',
        channel: 'whatsapp',
        status: 'open',
        aiScore: lead.aiScore || 84,
        estimatedValue: lead.estimatedValue || estimatedValue,
        linkedEntityType: 'lead',
        linkedEntityId: String(lead._id),
        linkedEntityLabel: lead.name,
        unreadCount: 1,
        adPlatform: 'meta_ctwa',
        ctwaClid,
        adId,
        adHeadline,
        adSourceUrl,
        lastInboundAt: nowIso,
        messages: [referralMsg],
      });
    } else {
      conv.linkedEntityType = 'lead';
      conv.linkedEntityId = String(lead._id);
      conv.linkedEntityLabel = lead.name;
      conv.adPlatform = 'meta_ctwa';
      conv.ctwaClid = ctwaClid;
      conv.adId = adId;
      conv.adHeadline = adHeadline;
      conv.adSourceUrl = adSourceUrl;
      conv.unreadCount = Number(conv.unreadCount || 0) + 1;
      conv.lastInboundAt = nowIso;
      conv.messages = [...(conv.messages || []), referralMsg];
      conv.markModified('messages');
      await conv.save();
    }

    // 3. Fire LeadSubmitted conversion event to Meta CAPI (or local simulator if credentials aren't set)
    const event = await this.fireConversionEvent({
      tenantId: auth.tenantId,
      eventName: 'LeadSubmitted',
      entityType: 'lead',
      entityId: String(lead._id),
      entityLabel: lead.name,
      phone: lead.phone,
      email: lead.email,
      ctwaClid,
      adId,
      adHeadline,
      adSourceUrl,
      valueInr: estimatedValue,
      triggeredBy: 'ctwa_simulator',
      respectAutoToggle: false,
    });

    return {
      leadId: String(lead._id),
      conversationId: String(conv._id),
      adId,
      adHeadline,
      ctwaClid,
      event,
    };
  }

  async fireManualEvent(
    authHeader: string | undefined,
    dto: TriggerManualCapiEventDto,
  ) {
    const auth = await this.verifyAuth(authHeader);
    const tenantObjId = new Types.ObjectId(auth.tenantId);
    const entityType = dto.entityType || 'lead';
    const eventName: MetaCapiEventName = dto.eventName || 'QualifiedLead';
    const entityId = String(dto.entityId || '').trim();

    let entityLabel = 'Manual CRM Signal';
    let phone = '';
    let email = '';
    let ctwaClid = '';
    let adId = '';
    let adHeadline = '';
    let adSourceUrl = '';
    let valueInr = Number(dto.valueInr || 0);

    if (entityId && Types.ObjectId.isValid(entityId)) {
      if (entityType === 'lead') {
        const doc = await this.leadModel.findOne({
          _id: new Types.ObjectId(entityId),
          tenantId: tenantObjId,
        });
        if (!doc) throw new NotFoundException('Lead not found.');
        entityLabel = doc.name;
        phone = doc.phone;
        email = doc.email;
        ctwaClid = doc.ctwaClid || '';
        adId = doc.adId || '';
        adHeadline = doc.adHeadline || '';
        adSourceUrl = doc.adSourceUrl || '';
        if (!valueInr) valueInr = Number(doc.estimatedValue || 0);
      } else if (entityType === 'deal') {
        const doc = await this.dealModel.findOne({
          _id: new Types.ObjectId(entityId),
          tenantId: tenantObjId,
        });
        if (!doc) throw new NotFoundException('Deal not found.');
        entityLabel = doc.title;
        phone = doc.contactPhone;
        email = doc.contactEmail;
        if (!valueInr) valueInr = Number(doc.value || 0);
      } else if (entityType === 'invoice') {
        const doc = await this.invoiceModel.findOne({
          _id: new Types.ObjectId(entityId),
          tenantId: tenantObjId,
        });
        if (!doc) throw new NotFoundException('Invoice not found.');
        entityLabel = `${doc.invoiceNumber || ''} · ${doc.clientName || ''}`.trim();
        phone = doc.phone || '';
        email = doc.email || '';
        if (!valueInr) valueInr = Number(doc.grandTotal || 0);
      }
    }

    return this.fireConversionEvent({
      tenantId: auth.tenantId,
      eventName,
      entityType,
      entityId: entityId || `manual_${Date.now()}`,
      entityLabel,
      phone,
      email,
      ctwaClid,
      adId,
      adHeadline,
      adSourceUrl,
      valueInr,
      triggeredBy: 'manual_trigger',
      respectAutoToggle: false,
    });
  }

  async retryEvent(authHeader: string | undefined, eventLogId: string) {
    const auth = await this.verifyAuth(authHeader);
    if (!Types.ObjectId.isValid(eventLogId)) {
      throw new BadRequestException('Invalid CAPI event ID.');
    }

    const doc = await this.eventModel.findOne({
      _id: new Types.ObjectId(eventLogId),
      tenantId: new Types.ObjectId(auth.tenantId),
    });
    if (!doc) throw new NotFoundException('CAPI event log entry not found.');

    const tenant = await this.tenantModel.findById(new Types.ObjectId(auth.tenantId));
    if (!tenant) throw new NotFoundException('Workspace not found.');

    const cfg = tenant.metaCapi;
    const decryptedToken = decryptSecret(
      cfg?.accessTokenEncrypted || '',
      auth.tenantId,
    );

    const payloadBody = { ...(doc.requestPayload || {}) };
    if (cfg?.testEventCode) {
      payloadBody.test_event_code = cfg.testEventCode;
    }

    const result = await this.dispatchToMetaGraph({
      pixelId: String(cfg?.pixelId || doc.pixelId || '').trim(),
      accessToken: decryptedToken,
      enabled: Boolean(cfg?.enabled),
      payloadBody,
    });

    doc.status = result.status;
    doc.httpStatus = result.httpStatus;
    doc.metaResponse = result.metaResponse;
    doc.errorMessage = result.errorMessage;
    doc.pixelId = String(cfg?.pixelId || doc.pixelId || '').trim();
    await doc.save();

    await this.tenantModel.updateOne(
      { _id: new Types.ObjectId(auth.tenantId) },
      {
        $set: {
          'metaCapi.lastFiredAt': new Date().toISOString(),
          'metaCapi.lastStatus': result.status,
          'metaCapi.lastError': result.errorMessage,
        },
      },
    );

    return this.toEventDto(doc);
  }
}
