import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Model, Types } from 'mongoose';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import {
  IndiaMartPullConfig,
  Tenant,
  TenantDocument,
} from '../auth/schemas/tenant.schema';
import { User, UserDocument } from '../auth/schemas/user.schema';
import {
  Lead,
  LeadDocument,
  LeadSource,
} from '../leads/schemas/lead.schema';
import { ProductItem, ProductDocument } from '../products/products.module';
import { Ticket, TicketDocument } from '../tickets/tickets.module';
import {
  MarketplaceChannel,
  MarketplaceSyncLog,
  MarketplaceSyncLogDocument,
} from './schemas/marketplace-sync-log.schema';
import {
  decryptSecret,
  encryptSecret,
  maskSecret,
  normalizeIndianPhone,
} from '../auth/identity.util';
import { AuditService } from '../audit/audit.module';
import { LeadRoutingService } from '../lead-routing/lead-routing.service';
import { InboxService } from '../inbox/inbox.service';
import {
  BookingSchedulerService,
  buildDefaultBookingScheduler,
  sanitizeBookingSlug,
} from './booking-scheduler.service';
import {
  IngestMarketplaceBatchDto,
  MarketplaceRawLeadItemDto,
  SimulateConnectorWebhookDto,
  SyncIndiaMartNowDto,
  UpdateIndiaMartConfigDto,
  UpdateLeadConnectorsDto,
} from './dto/marketplace-sync.dto';

interface AuthContext {
  userId: string;
  tenantId: string;
  email: string;
  name: string;
  role: string;
}

function last10(raw?: string): string {
  const digits = String(raw || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

function buildPhoneSuffixRegex(phone10: string): string {
  return `${phone10.split('').join('\\D*')}\\D*$`;
}

function formatIndiaMartTimestamp(date: Date): string {
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  const dd = String(date.getDate()).padStart(2, '0');
  const mmm = months[date.getMonth()];
  const yyyy = date.getFullYear();
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${dd}-${mmm}-${yyyy}${hh}:${mm}:${ss}`;
}

@Injectable()
export class MarketplaceSyncService implements OnModuleInit, OnModuleDestroy {
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private isSchedulerRunning = false;

  constructor(
    @InjectModel(MarketplaceSyncLog.name)
    private readonly logModel: Model<MarketplaceSyncLogDocument>,
    @InjectModel(Tenant.name)
    private readonly tenantModel: Model<TenantDocument>,
    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>,
    @InjectModel(Lead.name)
    private readonly leadModel: Model<LeadDocument>,
    @InjectModel(ProductItem.name)
    private readonly productModel: Model<ProductDocument>,
    @InjectModel(Ticket.name)
    private readonly ticketModel: Model<TicketDocument>,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    @Optional() private readonly auditService?: AuditService,
    @Optional() private readonly leadRoutingService?: LeadRoutingService,
    @Optional() private readonly inboxService?: InboxService,
    @Optional() private readonly bookingSchedulerService?: BookingSchedulerService,
  ) {}

  onModuleInit() {
    // Check every 60s for tenants with live IndiaMART Pull API polling enabled
    this.pollTimer = setInterval(() => {
      void this.runScheduledPollerTick();
    }, 60_000);
  }

  onModuleDestroy() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async runScheduledPollerTick() {
    if (this.isSchedulerRunning) return;
    this.isSchedulerRunning = true;
    try {
      const enabledTenants = await this.tenantModel
        .find({
          'indiamartPull.enabled': true,
          'indiamartPull.glusrCrmKeyEncrypted': { $ne: '' },
        })
        .select('_id indiamartPull')
        .lean();

      const nowMs = Date.now();
      for (const tenant of enabledTenants) {
        const cfg = tenant.indiamartPull;
        if (!cfg?.enabled || !cfg.glusrCrmKeyEncrypted) continue;
        const intervalMs = Math.max(5, Number(cfg.pollIntervalMinutes || 5)) * 60_000;
        const lastMs = cfg.lastSyncedAt ? new Date(cfg.lastSyncedAt).getTime() : 0;
        if (lastMs && nowMs - lastMs < intervalMs) continue;

        const fallbackOwner = await this.userModel
          .findOne({ tenantId: tenant._id, isActive: { $ne: false } })
          .select('_id email name role')
          .lean();
        if (!fallbackOwner) continue;

        await this.executeIndiaMartPullForTenant(
          {
            userId: String(fallbackOwner._id),
            tenantId: String(tenant._id),
            email: String(fallbackOwner.email || 'scheduler@leadsetu.in'),
            name: String(fallbackOwner.name || 'IndiaMART Auto-Sync'),
            role: String(fallbackOwner.role || 'owner'),
          },
          {},
        ).catch(() => {});
      }

      await this.bookingSchedulerService
        ?.processDueOneHourReminders()
        .catch(() => {});
    } catch {
      // Non-fatal background ticker guard
    } finally {
      this.isSchedulerRunning = false;
    }
  }

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
        name?: string;
        role?: string;
      }>(token, { secret });

      let role = String(payload.role || '').trim().toLowerCase();
      let name = String(payload.name || '').trim();
      if ((!role || !name) && Types.ObjectId.isValid(payload.sub)) {
        const user = await this.userModel
          .findById(payload.sub)
          .select('role name')
          .lean();
        role = role || String(user?.role || 'sales').trim().toLowerCase();
        name = name || String(user?.name || payload.email.split('@')[0]);
      }

      return {
        userId: payload.sub,
        tenantId: payload.tenantId,
        email: payload.email,
        name: name || payload.email.split('@')[0],
        role: role || 'sales',
      };
    } catch {
      throw new UnauthorizedException('Invalid or expired authentication token.');
    }
  }

  private renderGreeting(
    template: string,
    vars: { buyerName: string; product: string; company: string; repName: string },
  ): string {
    return template
      .replace(/\{\{\s*buyer_name\s*\}\}/gi, vars.buyerName || 'Sir/Madam')
      .replace(/\{\{\s*product\s*\}\}/gi, vars.product || 'our products')
      .replace(/\{\{\s*company\s*\}\}/gi, vars.company || 'our team')
      .replace(/\{\{\s*rep_name\s*\}\}/gi, vars.repName || 'our sales specialist');
  }

  private buildDefaultConfig(): IndiaMartPullConfig {
    return {
      enabled: false,
      glusrCrmKeyEncrypted: '',
      glusrCrmKeyMask: '',
      registeredMobile: '',
      pollIntervalMinutes: 5,
      autoWhatsAppSpeedToLead: true,
      greetingTemplate:
        'Namaste {{buyer_name}} ji! Thanks for your inquiry regarding {{product}}. Our specialist {{rep_name}} from {{company}} is sharing quotation & availability right away.',
      slaThresholdMinutes: 10,
      autoAttachProductBrochure: true,
      autoQuickReplyButtons: ['Share GST Quote', 'Download Catalog', 'Book Callback'],
      brokerFilterEnabled: true,
      skipWhatsAppOnJunk: false,
      junkKeywords: 'test, fake, sample free, job, vacancy, resume, student',
      lastSyncedAt: '',
      lastSyncStatus: '',
      lastSyncSummary: '',
    };
  }

  private async matchWorkspaceProduct(
    tenantOid: Types.ObjectId,
    queryText: string,
  ): Promise<ProductDocument | null> {
    const clean = String(queryText || '').trim().toLowerCase();
    if (!clean || clean.length < 3) return null;

    const products = await this.productModel
      .find({ tenantId: tenantOid, inStock: { $ne: false } })
      .limit(150)
      .exec();
    if (!products.length) return null;

    const tokens = clean
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 3);

    let bestDoc: ProductDocument | null = null;
    let bestScore = 0;

    for (const prod of products) {
      const sku = String(prod.sku || '').toLowerCase();
      const name = String(prod.name || '').toLowerCase();
      const cat = String(prod.category || '').toLowerCase();
      let score = 0;

      if (sku && clean.includes(sku)) score += 10;
      if (name && clean.includes(name)) score += 8;

      for (const tok of tokens) {
        if (name.includes(tok)) score += 2;
        if (cat.includes(tok)) score += 1;
        if (sku.includes(tok)) score += 2;
      }

      if (score > bestScore) {
        bestScore = score;
        bestDoc = prod;
      }
    }

    return bestScore >= 2 ? bestDoc : null;
  }

  private detectJunkReason(
    name: string,
    product: string,
    message: string,
    keywordsCsv?: string,
  ): string {
    const rawKeywords = String(
      keywordsCsv || 'test, fake, sample free, job, vacancy, resume, student',
    );
    const keywords = rawKeywords
      .split(',')
      .map((k) => k.trim().toLowerCase())
      .filter((k) => k.length >= 2);
    if (!keywords.length) return '';

    const haystack = `${name} ${product} ${message}`.toLowerCase();
    for (const kw of keywords) {
      if (haystack.includes(kw)) {
        return kw;
      }
    }
    return '';
  }

  private resolvePincodeZone(
    rulesStr: string | undefined,
    pincode: string | undefined,
    fallbackCity: string,
  ): { matchedZone: string; effectiveCity: string } {
    const cleanPin = String(pincode || '').replace(/\D/g, '');
    const cleanRules = String(rulesStr || '').trim();
    if (!cleanPin || !cleanRules) {
      return { matchedZone: '', effectiveCity: fallbackCity };
    }

    const entries = cleanRules
      .split(/[\n,;]+/)
      .map((item) => item.trim())
      .filter(Boolean);

    for (const entry of entries) {
      const parts = entry.split(/[:=->]+/);
      if (parts.length < 2) continue;
      const prefix = parts[0].replace(/\*/g, '').replace(/\D/g, '');
      const zoneName = parts.slice(1).join(' ').trim();
      if (prefix && zoneName && cleanPin.startsWith(prefix)) {
        return { matchedZone: zoneName, effectiveCity: zoneName };
      }
    }
    return { matchedZone: '', effectiveCity: fallbackCity };
  }

  private isServiceCategoryInquiry(
    productOrCategory: string,
    message: string,
    keywordsCsv?: string,
  ): boolean {
    const kws = String(
      keywordsCsv || 'repair, service, amc, installation, complaint, warranty',
    )
      .split(',')
      .map((k) => k.trim().toLowerCase())
      .filter((k) => k.length >= 2);
    const text = `${productOrCategory} ${message}`.toLowerCase();
    return kws.some((k) => text.includes(k));
  }

  /**
   * Reusable <10s Auto-WhatsApp Speed-to-Lead dispatcher for newly created leads
   * (used by Marketplace Sync Engine AND Lead Webhook Capture).
   */
  async dispatchInstantWelcomeForLead(params: {
    tenantId: string;
    leadDoc: LeadDocument;
    repAuth: AuthContext;
    productHint?: string;
  }): Promise<{ sent: boolean; speedToLeadSeconds: number }> {
    const startMs = Date.now();
    if (!Types.ObjectId.isValid(params.tenantId) || !params.leadDoc.phone) {
      return { sent: false, speedToLeadSeconds: -1 };
    }

    const tenant = await this.tenantModel
      .findById(new Types.ObjectId(params.tenantId))
      .lean();
    const cfg = tenant?.indiamartPull || this.buildDefaultConfig();
    if (cfg.autoWhatsAppSpeedToLead === false) {
      return { sent: false, speedToLeadSeconds: -1 };
    }

    const companyName = String(
      tenant?.companyName || tenant?.name || 'Leadsetu Partner',
    ).trim();
    const productSearchText =
      params.productHint || params.leadDoc.notes || '';
    let renderedMsg = this.renderGreeting(
      cfg.greetingTemplate || this.buildDefaultConfig().greetingTemplate,
      {
        buyerName: params.leadDoc.name || 'Buyer',
        product:
          params.productHint ||
          params.leadDoc.notes?.slice(0, 70) ||
          'your requirement',
        company: companyName,
        repName: params.repAuth.name || 'Sales Specialist',
      },
    );

    if (cfg.autoAttachProductBrochure !== false && productSearchText) {
      const matched = await this.matchWorkspaceProduct(
        new Types.ObjectId(params.tenantId),
        productSearchText,
      );
      if (matched) {
        const rateText =
          matched.unitPrice > 0
            ? `₹${Number(matched.unitPrice).toLocaleString('en-IN')}/${matched.unit || 'pcs'} + ${matched.gstRate ?? 18}% GST`
            : 'Custom Factory Quote';
        const brochureLine = matched.brochureUrl?.trim()
          ? `\nCatalog / Datasheet: ${matched.brochureUrl.trim()}`
          : '';
        renderedMsg += `\n\nMatched SKU: ${matched.name} (${matched.sku}) · Rate: ${rateText} · MOQ: ${matched.moq || 1}${brochureLine}`;
      }
    }

    if (!this.inboxService) {
      return { sent: false, speedToLeadSeconds: -1 };
    }

    const quickReplyButtons = Array.isArray(cfg.autoQuickReplyButtons)
      ? cfg.autoQuickReplyButtons
          .map((b) => String(b || '').trim())
          .filter(Boolean)
          .slice(0, 3)
      : [];

    try {
      await this.inboxService.startOrGetConversation(params.repAuth, {
        linkedEntityType: 'lead',
        linkedEntityId: String(params.leadDoc._id),
        contactName: params.leadDoc.name,
        company: params.leadDoc.company || '',
        phone: params.leadDoc.phone,
        city: params.leadDoc.city || '',
        estimatedValue: Number(params.leadDoc.estimatedValue || 0),
        channel: 'whatsapp',
        initialMessage: renderedMsg,
        via: 'inbox',
        isAiDrafted: true,
        logToTimeline: false,
        quickReplyButtons:
          quickReplyButtons.length > 0 ? quickReplyButtons : undefined,
      });

      const createdMs = new Date(
        ((params.leadDoc as unknown as { createdAt?: Date }).createdAt as Date) ||
          Date.now(),
      ).getTime();
      const speedToLeadSeconds = Math.max(
        1,
        Math.round((Date.now() - createdMs) / 1000) ||
          Math.max(1, Math.round((Date.now() - startMs) / 1000)),
      );
      const contactedIso = new Date().toISOString();

      await this.leadModel.updateOne(
        { _id: params.leadDoc._id },
        {
          $set: {
            firstContactedAt: contactedIso,
            speedToLeadSeconds,
            autoWhatsAppWelcomeSent: true,
          },
          $push: {
            activities: {
              $each: [
                {
                  id: randomBytes(6).toString('hex'),
                  type: 'whatsapp',
                  description: `Auto-WhatsApp Speed-to-Lead dispatched in ${speedToLeadSeconds}s: "${renderedMsg.slice(0, 140)}"`,
                  authorName: 'Leadsetu Speed-to-Lead Bot',
                  createdAt: contactedIso,
                },
              ],
              $position: 0,
            },
          },
        },
      );
      return { sent: true, speedToLeadSeconds };
    } catch {
      return { sent: false, speedToLeadSeconds: -1 };
    }
  }

  private mapChannelToLeadSource(channel: MarketplaceChannel): LeadSource {
    if (channel === 'meta_lead_ads') return 'meta_ads';
    if (channel === 'justdial_feed') return 'justdial';
    if (channel === 'tradeindia_feed') return 'tradeindia';
    if (channel === 'booking_widget') return 'website';
    return 'indiamart';
  }

  private buildSandboxBatch(cityHint: string, count: number): MarketplaceRawLeadItemDto[] {
    const suffix = String(Date.now()).slice(-4);
    const catalog: MarketplaceRawLeadItemDto[] = [
      {
        externalQueryId: `IMQ-${Date.now()}-A1`,
        name: `Rajeev Agarwal`,
        company: `Agarwal Switchgears & Controls`,
        phone: `+91 98104 5${suffix}`,
        email: `purchase${suffix}@agarwalswitchgear.in`,
        city: cityHint || 'Noida',
        product: '150 KVA Oil-Cooled Servo Voltage Stabilizer',
        message: 'Urgent industrial requirement for 3 units with 18% GST tax invoice.',
        estimatedValue: 285000,
      },
      {
        externalQueryId: `IMQ-${Date.now()}-B2`,
        name: `Prashant Kulkarni`,
        company: `Kulkarni Auto Ancillaries`,
        phone: `+91 97652 4${suffix}`,
        email: `procurement${suffix}@kulkarniauto.co.in`,
        city: 'Pune',
        product: 'CNC Copper Winding Distribution Panel',
        message: 'Share delivery timeline & ex-works factory rate.',
        estimatedValue: 165000,
      },
      {
        externalQueryId: `IMQ-${Date.now()}-C3`,
        name: `Meenakshi Traders`,
        company: `Meenakshi Agro Cold Storage`,
        phone: `+91 98991 3${suffix}`,
        email: '',
        city: 'Gurugram',
        product: 'Heavy-Duty Isolation Transformer 100 KVA',
        message: 'Looking for immediate dispatch in Haryana.',
        estimatedValue: 120000,
      },
    ];
    return catalog.slice(0, Math.max(1, Math.min(5, count)));
  }

  private async ingestRecords(params: {
    auth: AuthContext;
    tenant: TenantDocument;
    channel: MarketplaceChannel;
    mode: 'live_api' | 'sandbox';
    records: MarketplaceRawLeadItemDto[];
    autoWelcome?: boolean;
  }) {
    const startedMs = Date.now();
    const tenantOid = params.tenant._id;
    const tenantIdStr = String(tenantOid);
    const source = this.mapChannelToLeadSource(params.channel);

    let createdCount = 0;
    let deduplicatedCount = 0;
    let skippedCount = 0;
    let whatsAppDispatchedCount = 0;

    const sampleLeads: MarketplaceSyncLog['sampleLeads'] = [];

    for (const raw of params.records) {
      const extId = String(raw.externalQueryId || '').trim();
      const name = String(raw.name || '').trim();
      const rawPhone = String(raw.phone || '').trim();
      const phone = normalizeIndianPhone(rawPhone) || rawPhone;
      const phone10 = last10(phone);
      const email = String(raw.email || '').trim().toLowerCase();
      const rawCity = String(raw.city || params.tenant.city || '').trim();
      const company = String(raw.company || '').trim();
      const product = String(raw.product || '').trim();
      const message = String(raw.message || '').trim();
      const pincode = String(raw.pincode || '').trim();
      let estimatedValue = Math.max(0, Number(raw.estimatedValue || 0) || 0);

      const imCfg = params.tenant.indiamartPull || this.buildDefaultConfig();
      const jdCfg = params.tenant.leadConnectors?.justdialWebhook;

      const { matchedZone, effectiveCity } =
        params.channel === 'justdial_feed'
          ? this.resolvePincodeZone(jdCfg?.pincodeZoneRules, pincode, rawCity)
          : { matchedZone: '', effectiveCity: rawCity };
      const city = effectiveCity || rawCity;

      const matchedCatalogProduct =
        imCfg.autoAttachProductBrochure !== false && (product || message)
          ? await this.matchWorkspaceProduct(tenantOid, `${product} ${message}`)
          : null;
      if (estimatedValue === 0 && matchedCatalogProduct && matchedCatalogProduct.unitPrice > 0) {
        estimatedValue =
          Number(matchedCatalogProduct.unitPrice) *
          Math.max(1, Number(matchedCatalogProduct.moq || 1));
      }

      const junkKeyword =
        imCfg.brokerFilterEnabled !== false
          ? this.detectJunkReason(name, product, message, imCfg.junkKeywords)
          : '';
      const isJunkFlagged = Boolean(junkKeyword);

      if (!name && !phone && !email) {
        skippedCount += 1;
        continue;
      }

      // 1. Deduplicate by externalQueryId OR 10-digit Indian phone OR email
      const dupOr: Record<string, unknown>[] = [];
      if (extId) dupOr.push({ externalQueryId: extId });
      if (phone10.length === 10) dupOr.push({ phone: { $regex: buildPhoneSuffixRegex(phone10) } });
      if (email) dupOr.push({ email });

      const existing =
        dupOr.length > 0
          ? await this.leadModel
              .findOne({ tenantId: tenantOid, $or: dupOr })
              .sort({ updatedAt: -1 })
          : null;

      if (existing) {
        deduplicatedCount += 1;
        if (extId && !existing.externalQueryId) {
          existing.externalQueryId = extId;
        }
        existing.activities.unshift({
          id: randomBytes(6).toString('hex'),
          type: 'note',
          description: `Repeat ${source.toUpperCase()} inquiry${product ? ` (${product})` : ''}: ${message || 'Matched existing buyer by phone/query ID.'}`,
          authorName: 'IndiaMART Pull Sync',
          createdAt: new Date().toISOString(),
        });
        await existing.save();

        sampleLeads.push({
          leadId: String(existing._id),
          name: existing.name,
          phone: existing.phone,
          city: existing.city,
          product: product || 'Repeat Inquiry',
          outcome: 'deduplicated',
          assignedRepName: 'Existing Owner',
          whatsAppSent: false,
          speedToLeadSeconds: existing.speedToLeadSeconds ?? -1,
        });
        continue;
      }

      // 2. Auto-route new inquiry via LeadRoutingService
      let assignedUserId = params.auth.userId;
      let repName = params.auth.name;
      let repEmail = params.auth.email;
      let routingStrategy = 'owner_default';

      if (this.leadRoutingService) {
        try {
          const routed = await this.leadRoutingService.resolveAssigneeForLead(
            tenantIdStr,
            {
              city,
              source,
              estimatedValue,
              leadName: name || phone,
              commit: true,
            },
          );
          assignedUserId = routed.assignedUserId;
          repName = routed.assignedUserName || repName;
          repEmail = routed.assignedUserEmail || repEmail;
          routingStrategy = routed.strategyUsed;
        } catch {
          // Safe fallback to initiating admin/owner
        }
      }

      const baseAiScore = Math.min(
        96,
        72 + (estimatedValue >= 100000 ? 12 : 6) + (product ? 6 : 0) + (company ? 4 : 0),
      );
      const aiScore = isJunkFlagged ? 32 : baseAiScore;
      const aiLabel = aiScore >= 80 ? 'Hot' : aiScore >= 60 ? 'Warm' : 'Cold';
      const nowIso = new Date().toISOString();

      const tags: string[] = [
        params.channel === 'meta_lead_ads'
          ? 'Meta Lead Ads'
          : params.channel === 'justdial_feed'
            ? 'Justdial Webhook'
            : params.channel === 'tradeindia_feed'
              ? 'TradeIndia Webhook'
              : 'IndiaMART Pull',
      ];
      if (matchedZone) tags.push(`Zone: ${matchedZone}`);
      if (matchedCatalogProduct?.sku) tags.push(`SKU: ${matchedCatalogProduct.sku}`);
      if (isJunkFlagged) tags.push(`Flagged: Low Intent (${junkKeyword})`);

      const created = await this.leadModel.create({
        tenantId: tenantOid,
        ownerId: Types.ObjectId.isValid(assignedUserId)
          ? new Types.ObjectId(assignedUserId)
          : new Types.ObjectId(params.auth.userId),
        name: name || `Buyer ${phone}`,
        accountKind: company ? 'business' : 'consumer',
        company,
        phone,
        email,
        city,
        source,
        status: 'new',
        estimatedValue,
        tags,
        notes: [
          product ? `Product: ${product}` : '',
          pincode ? `Pincode: ${pincode}` : '',
          message,
        ]
          .filter(Boolean)
          .join(' — '),
        externalQueryId: extId,
        aiScore,
        aiLabel,
        aiInsight: isJunkFlagged
          ? `Flagged by Junk/Broker Shield (matched "${junkKeyword}") · Assigned to ${repName}.`
          : `Captured via ${params.channel.replace(/_/g, ' ')} · Routed to ${repName} (${routingStrategy})${matchedZone ? ` · Territory Zone: ${matchedZone}` : ''}.`,
        aiNextAction: isJunkFlagged
          ? 'Verify inquiry authenticity before committing rep follow-up.'
          : 'Verify <10s WhatsApp welcome & share GST quotation.',
        aiScoredAt: nowIso,
        activities: [
          {
            id: randomBytes(6).toString('hex'),
            type: 'created',
            description: `Captured via ${params.channel.toUpperCase()}${extId ? ` (${extId})` : ''} · Auto-assigned to ${repName}${matchedZone ? ` (Zone: ${matchedZone})` : ''}${isJunkFlagged ? ` · Junk/Broker Shield: "${junkKeyword}"` : ''}.`,
            authorName: 'Leadsetu Omnichannel Capture',
            createdAt: nowIso,
          },
        ],
      });

      createdCount += 1;

      if (
        params.channel === 'justdial_feed' &&
        !isJunkFlagged &&
        jdCfg?.autoCreateTicketForService !== false &&
        this.isServiceCategoryInquiry(
          product,
          message,
          jdCfg?.serviceCategoryKeywords,
        )
      ) {
        try {
          const slaDueAt = new Date(Date.now() + 4 * 3600_000).toISOString();
          const ticketNum = `TKT-JD-${Date.now().toString().slice(-5)}`;
          await this.ticketModel.create({
            tenantId: tenantOid,
            ownerId: created.ownerId,
            ticketNumber: ticketNum,
            subject: `Justdial Service Request: ${product || 'After-Sales Support'}`,
            category: 'amc_service',
            priority: 'high',
            status: 'open',
            customerName: created.name,
            company: created.company || '',
            phone: created.phone || '',
            email: created.email || '',
            siteAddress: pincode ? `${city} (${pincode})` : city,
            assignedToUserId: assignedUserId,
            assignedToName: repName,
            slaDueAt,
            notes: message || `Auto-created from Justdial service inquiry (${extId}).`,
            comments: [
              {
                id: randomBytes(6).toString('hex'),
                authorName: 'Justdial Auto-Splitter',
                authorRole: 'system',
                message: `Auto-routed service inquiry (${product}) from Justdial directly into SLA Desk.`,
                isInternal: true,
                createdAt: nowIso,
              },
            ],
          });
          await this.leadModel.updateOne(
            { _id: created._id },
            {
              $addToSet: { tags: 'Service Ticket Opened' },
              $push: {
                activities: {
                  $each: [
                    {
                      id: randomBytes(6).toString('hex'),
                      type: 'note',
                      description: `Auto-opened SLA Ticket ${ticketNum} for Justdial service inquiry.`,
                      authorName: 'Justdial Service Splitter',
                      createdAt: nowIso,
                    },
                  ],
                  $position: 0,
                },
              },
            },
          );
        } catch {
          // Do not block inquiry ingestion if ticket audit fails
        }
      }

      // 3. Fire <10s Auto-WhatsApp Speed-to-Lead (respecting Junk Skip guard)
      const skipWa =
        params.autoWelcome === false ||
        (isJunkFlagged && Boolean(imCfg.skipWhatsAppOnJunk));
      const welcome = skipWa
        ? { sent: false, speedToLeadSeconds: -1 }
        : await this.dispatchInstantWelcomeForLead({
            tenantId: tenantIdStr,
            leadDoc: created,
            repAuth: {
              userId: assignedUserId,
              tenantId: tenantIdStr,
              email: repEmail,
              name: repName,
              role: 'sales',
            },
            productHint: product,
          });

      if (welcome.sent) {
        whatsAppDispatchedCount += 1;
      }

      sampleLeads.push({
        leadId: String(created._id),
        name: created.name,
        phone: created.phone,
        city: created.city,
        product: product || 'General B2B Inquiry',
        outcome: 'created',
        assignedRepName: repName,
        whatsAppSent: welcome.sent,
        speedToLeadSeconds: welcome.speedToLeadSeconds,
      });
    }

    const durationMs = Math.max(1, Date.now() - startedMs);
    const syncedAt = new Date().toISOString();

    const summaryText = `${params.channel.toUpperCase()} (${params.mode === 'live_api' ? 'Live' : 'Sandbox'}): ${createdCount} new, ${deduplicatedCount} merged, ${whatsAppDispatchedCount} instant WhatsApp sent`;

    if (params.channel === 'indiamart_pull' || params.channel === 'sandbox_sim') {
      await this.tenantModel.updateOne(
        { _id: tenantOid },
        {
          $set: {
            'indiamartPull.lastSyncedAt': syncedAt,
            'indiamartPull.lastSyncStatus':
              params.mode === 'live_api' ? 'synced' : 'sandbox_simulated',
            'indiamartPull.lastSyncSummary': summaryText,
          },
        },
      );
    } else if (params.channel === 'meta_lead_ads') {
      await this.tenantModel.updateOne(
        { _id: tenantOid },
        {
          $set: {
            'leadConnectors.metaLeadAds.lastReceivedAt': syncedAt,
            'leadConnectors.metaLeadAds.lastLeadSummary': summaryText,
          },
        },
      );
    } else if (params.channel === 'justdial_feed') {
      await this.tenantModel.updateOne(
        { _id: tenantOid },
        {
          $set: {
            'leadConnectors.justdialWebhook.lastReceivedAt': syncedAt,
            'leadConnectors.justdialWebhook.lastLeadSummary': summaryText,
          },
        },
      );
    } else if (params.channel === 'tradeindia_feed') {
      await this.tenantModel.updateOne(
        { _id: tenantOid },
        {
          $set: {
            'leadConnectors.tradeindiaWebhook.lastReceivedAt': syncedAt,
            'leadConnectors.tradeindiaWebhook.lastLeadSummary': summaryText,
          },
        },
      );
    }

    const logDoc = await this.logModel.create({
      tenantId: tenantOid,
      channel: params.channel,
      mode: params.mode,
      fetchedCount: params.records.length,
      createdCount,
      deduplicatedCount,
      skippedCount,
      whatsAppDispatchedCount,
      durationMs,
      status: 'success',
      errorMessage: '',
      sampleLeads: sampleLeads.slice(0, 15),
      syncedAt,
    });

    await this.auditService?.record({
      tenantId: tenantIdStr,
      actorId: params.auth.userId,
      actorEmail: params.auth.email,
      action: 'marketplace.sync_completed',
      entityType: 'lead',
      entityId: String(logDoc._id),
      entityLabel: params.channel,
      summary: summaryText,
    });

    return {
      logId: String(logDoc._id),
      channel: params.channel,
      mode: params.mode,
      fetchedCount: params.records.length,
      createdCount,
      deduplicatedCount,
      skippedCount,
      whatsAppDispatchedCount,
      durationMs,
      summaryText,
      sampleLeads,
      syncedAt,
    };
  }

  private async executeIndiaMartPullForTenant(
    auth: AuthContext,
    dto: SyncIndiaMartNowDto,
  ) {
    const tenantOid = new Types.ObjectId(auth.tenantId);
    const tenant = await this.tenantModel.findById(tenantOid);
    if (!tenant) throw new NotFoundException('Workspace not found.');

    const cfg = tenant.indiamartPull || this.buildDefaultConfig();
    const decryptedKey = decryptSecret(cfg.glusrCrmKeyEncrypted || '', auth.tenantId);

    // Sandbox simulation when no live CRM key is configured or requested explicitly
    if (!decryptedKey || dto.simulateIfNoKey) {
      const records = this.buildSandboxBatch(
        tenant.city || '',
        dto.sampleCount ?? 2,
      );
      return this.ingestRecords({
        auth,
        tenant,
        channel: decryptedKey ? 'indiamart_pull' : 'sandbox_sim',
        mode: 'sandbox',
        records,
      });
    }

    // Live IndiaMART Pull API v2 Request
    const endDt = new Date();
    const startDt = new Date(endDt.getTime() - 24 * 60 * 60_000);
    const startTime =
      String(dto.startTime || '').trim() || formatIndiaMartTimestamp(startDt);
    const endTime =
      String(dto.endTime || '').trim() || formatIndiaMartTimestamp(endDt);

    const apiUrl = `https://mapi.indiamart.com/wservce/crm/crmListing/v2/?glusr_crm_key=${encodeURIComponent(
      decryptedKey,
    )}&start_time=${encodeURIComponent(startTime)}&end_time=${encodeURIComponent(endTime)}`;

    const startedMs = Date.now();
    try {
      const res = await fetch(apiUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(12_000),
      });
      const json = (await res.json().catch(() => ({}))) as {
        CODE?: number;
        STATUS?: string;
        MESSAGE?: string;
        RESPONSE?: Array<Record<string, unknown>>;
      };

      const isSuccess = res.ok && String(json.STATUS || '').toUpperCase() === 'SUCCESS';
      if (!isSuccess) {
        const errMsg =
          String(json.MESSAGE || '').trim() ||
          `IndiaMART Pull API returned status ${json.CODE || res.status}`;
        await this.logModel.create({
          tenantId: tenantOid,
          channel: 'indiamart_pull',
          mode: 'live_api',
          fetchedCount: 0,
          createdCount: 0,
          deduplicatedCount: 0,
          skippedCount: 0,
          whatsAppDispatchedCount: 0,
          durationMs: Date.now() - startedMs,
          status: 'error',
          errorMessage: errMsg,
          syncedAt: new Date().toISOString(),
        });
        await this.tenantModel.updateOne(
          { _id: tenantOid },
          {
            $set: {
              'indiamartPull.lastSyncedAt': new Date().toISOString(),
              'indiamartPull.lastSyncStatus': 'error',
              'indiamartPull.lastSyncSummary': errMsg,
            },
          },
        );
        throw new BadRequestException(errMsg);
      }

      const rawRows = Array.isArray(json.RESPONSE) ? json.RESPONSE : [];
      const normalized: MarketplaceRawLeadItemDto[] = rawRows.map((row) => ({
        externalQueryId: String(row.UNIQUE_QUERY_ID || '').trim(),
        name: String(row.SENDER_NAME || '').trim(),
        company: String(row.SENDER_COMPANY || '').trim(),
        phone: String(row.SENDER_MOBILE || row.SENDER_MOBILE_ALT || '').trim(),
        email: String(row.SENDER_EMAIL || '').trim(),
        city: String(row.SENDER_CITY || row.SENDER_STATE || tenant.city || '').trim(),
        product: String(row.QUERY_PRODUCT_NAME || '').trim(),
        message: String(row.QUERY_MESSAGE || '').trim(),
        estimatedValue: 0,
      }));

      return this.ingestRecords({
        auth,
        tenant,
        channel: 'indiamart_pull',
        mode: 'live_api',
        records: normalized,
      });
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      const errMsg =
        err instanceof Error ? err.message : 'IndiaMART API connection error';
      await this.logModel.create({
        tenantId: tenantOid,
        channel: 'indiamart_pull',
        mode: 'live_api',
        status: 'error',
        errorMessage: errMsg,
        durationMs: Date.now() - startedMs,
        syncedAt: new Date().toISOString(),
      });
      throw new BadRequestException(errMsg);
    }
  }

  async syncIndiaMartNow(
    authHeader: string | undefined,
    dto: SyncIndiaMartNowDto,
  ) {
    const auth = await this.verifyAuth(authHeader);
    return this.executeIndiaMartPullForTenant(auth, dto || {});
  }

  async ingestBatch(
    authHeader: string | undefined,
    dto: IngestMarketplaceBatchDto,
  ) {
    const auth = await this.verifyAuth(authHeader);
    if (!Array.isArray(dto?.records) || dto.records.length === 0) {
      throw new BadRequestException('Provide at least one marketplace inquiry record.');
    }
    const tenant = await this.tenantModel.findById(new Types.ObjectId(auth.tenantId));
    if (!tenant) throw new NotFoundException('Workspace not found.');

    return this.ingestRecords({
      auth,
      tenant,
      channel: dto.channel || 'justdial_feed',
      mode: 'live_api',
      records: dto.records.slice(0, 100),
    });
  }

  async rescueSlaLead(authHeader: string | undefined, leadId: string) {
    const auth = await this.verifyAuth(authHeader);
    if (!Types.ObjectId.isValid(leadId)) {
      throw new BadRequestException('Invalid lead ID.');
    }
    const lead = await this.leadModel.findOne({
      _id: new Types.ObjectId(leadId),
      tenantId: new Types.ObjectId(auth.tenantId),
    });
    if (!lead) throw new NotFoundException('Lead not found.');

    const res = await this.dispatchInstantWelcomeForLead({
      tenantId: auth.tenantId,
      leadDoc: lead,
      repAuth: auth,
    });
    return {
      leadId: String(lead._id),
      name: lead.name,
      whatsAppSent: res.sent,
      speedToLeadSeconds: res.speedToLeadSeconds,
    };
  }

  async updateConfig(
    authHeader: string | undefined,
    dto: UpdateIndiaMartConfigDto,
  ) {
    const auth = await this.verifyAuth(authHeader);
    if (!['owner', 'admin', 'super_admin'].includes(auth.role)) {
      throw new ForbiddenException(
        'Only workspace Owners or Admins can configure IndiaMART Pull API & Speed-to-Lead.',
      );
    }
    const tenant = await this.tenantModel.findById(new Types.ObjectId(auth.tenantId));
    if (!tenant) throw new NotFoundException('Workspace not found.');

    const prev = tenant.indiamartPull || this.buildDefaultConfig();
    const rawKey =
      dto.glusrCrmKey !== undefined ? String(dto.glusrCrmKey).trim() : '';

    const glusrCrmKeyEncrypted = rawKey
      ? encryptSecret(rawKey, auth.tenantId)
      : prev.glusrCrmKeyEncrypted || '';
    const glusrCrmKeyMask = rawKey
      ? maskSecret(rawKey)
      : prev.glusrCrmKeyMask || '';

    const nextEnabled =
      dto.enabled !== undefined ? Boolean(dto.enabled) : Boolean(prev.enabled);
    if (nextEnabled && !glusrCrmKeyEncrypted) {
      throw new BadRequestException(
        'IndiaMART glusr_crm_key API v2 key is required to enable background polling.',
      );
    }

    tenant.indiamartPull = {
      enabled: nextEnabled,
      glusrCrmKeyEncrypted,
      glusrCrmKeyMask,
      registeredMobile:
        dto.registeredMobile !== undefined
          ? String(dto.registeredMobile).trim()
          : prev.registeredMobile || '',
      pollIntervalMinutes:
        dto.pollIntervalMinutes !== undefined
          ? Math.max(5, Math.min(60, Number(dto.pollIntervalMinutes) || 5))
          : prev.pollIntervalMinutes || 5,
      autoWhatsAppSpeedToLead:
        dto.autoWhatsAppSpeedToLead !== undefined
          ? Boolean(dto.autoWhatsAppSpeedToLead)
          : prev.autoWhatsAppSpeedToLead !== false,
      greetingTemplate:
        dto.greetingTemplate !== undefined
          ? String(dto.greetingTemplate).trim() ||
            this.buildDefaultConfig().greetingTemplate
          : prev.greetingTemplate || this.buildDefaultConfig().greetingTemplate,
      slaThresholdMinutes:
        dto.slaThresholdMinutes !== undefined
          ? Math.max(1, Math.min(120, Number(dto.slaThresholdMinutes) || 10))
          : prev.slaThresholdMinutes || 10,
      autoAttachProductBrochure:
        dto.autoAttachProductBrochure !== undefined
          ? Boolean(dto.autoAttachProductBrochure)
          : prev.autoAttachProductBrochure !== false,
      autoQuickReplyButtons:
        Array.isArray(dto.autoQuickReplyButtons)
          ? dto.autoQuickReplyButtons
              .map((b) => String(b || '').trim())
              .filter(Boolean)
              .slice(0, 3)
          : Array.isArray(prev.autoQuickReplyButtons)
            ? prev.autoQuickReplyButtons
            : ['Share GST Quote', 'Download Catalog', 'Book Callback'],
      brokerFilterEnabled:
        dto.brokerFilterEnabled !== undefined
          ? Boolean(dto.brokerFilterEnabled)
          : prev.brokerFilterEnabled !== false,
      skipWhatsAppOnJunk:
        dto.skipWhatsAppOnJunk !== undefined
          ? Boolean(dto.skipWhatsAppOnJunk)
          : Boolean(prev.skipWhatsAppOnJunk),
      junkKeywords:
        dto.junkKeywords !== undefined
          ? String(dto.junkKeywords).trim()
          : prev.junkKeywords ||
            'test, fake, sample free, job, vacancy, resume, student',
      lastSyncedAt: prev.lastSyncedAt || '',
      lastSyncStatus: prev.lastSyncStatus || '',
      lastSyncSummary: prev.lastSyncSummary || '',
    };

    await tenant.save();
    return this.getOverview(authHeader);
  }

  async getOverview(authHeader?: string) {
    const auth = await this.verifyAuth(authHeader);
    const tenantOid = new Types.ObjectId(auth.tenantId);

    const [tenant, recentLogs, marketplaceLeads, users] = await Promise.all([
      this.tenantModel.findById(tenantOid).lean(),
      this.logModel
        .find({ tenantId: tenantOid })
        .sort({ createdAt: -1 })
        .limit(20)
        .lean(),
      this.leadModel
        .find({
          tenantId: tenantOid,
          source: {
            $in: ['indiamart', 'justdial', 'tradeindia', 'meta_ads', 'website'],
          },
        })
        .select(
          'name phone city source status ownerId estimatedValue tags notes firstContactedAt speedToLeadSeconds autoWhatsAppWelcomeSent createdAt',
        )
        .sort({ createdAt: -1 })
        .limit(200)
        .lean(),
      this.userModel.find({ tenantId: tenantOid }).select('_id name').lean(),
    ]);

    if (!tenant) throw new NotFoundException('Workspace not found.');

    const cfg = tenant.indiamartPull || this.buildDefaultConfig();
    const slaMinutes = Math.max(1, Number(cfg.slaThresholdMinutes || 10));
    const userMap = new Map(users.map((u) => [String(u._id), u.name]));

    const contactedLeads = marketplaceLeads.filter(
      (l) => typeof l.speedToLeadSeconds === 'number' && l.speedToLeadSeconds >= 0,
    );
    const under10sCount = contactedLeads.filter(
      (l) => (l.speedToLeadSeconds ?? 999) <= 10,
    ).length;
    const avgSpeedSeconds =
      contactedLeads.length > 0
        ? Math.round(
            contactedLeads.reduce(
              (acc, l) => acc + Number(l.speedToLeadSeconds || 0),
              0,
            ) / contactedLeads.length,
          )
        : 0;

    const nowMs = Date.now();
    const slaBreachedLeads = marketplaceLeads
      .filter((l) => {
        if (l.status !== 'new' || l.firstContactedAt) return false;
        const createdMs = new Date(
          ((l as unknown as { createdAt?: Date }).createdAt as Date) || nowMs,
        ).getTime();
        const ageMin = (nowMs - createdMs) / 60_000;
        return ageMin >= slaMinutes;
      })
      .slice(0, 12)
      .map((l) => {
        const createdMs = new Date(
          ((l as unknown as { createdAt?: Date }).createdAt as Date) || nowMs,
        ).getTime();
        return {
          id: String(l._id),
          name: l.name,
          phone: l.phone || '',
          city: l.city || '',
          source: l.source,
          ageMinutes: Math.max(1, Math.round((nowMs - createdMs) / 60_000)),
          ownerName: userMap.get(String(l.ownerId)) || 'Unassigned',
        };
      });

    const categoryMap = new Map<
      string,
      {
        category: string;
        inquiries: number;
        qualifiedOrWon: number;
        junkFlagged: number;
        totalValueInr: number;
        conversionRatePct: number;
      }
    >();

    for (const l of marketplaceLeads) {
      const notesStr = String((l as unknown as { notes?: string }).notes || '');
      const prodMatch = notesStr.match(/Product:\s*([^\n—]+)/i);
      const rawCat = prodMatch?.[1]?.trim() || String(l.source || 'marketplace').toUpperCase();
      const catKey = rawCat.slice(0, 48);
      if (!categoryMap.has(catKey)) {
        categoryMap.set(catKey, {
          category: catKey,
          inquiries: 0,
          qualifiedOrWon: 0,
          junkFlagged: 0,
          totalValueInr: 0,
          conversionRatePct: 0,
        });
      }
      const bucket = categoryMap.get(catKey)!;
      bucket.inquiries += 1;
      bucket.totalValueInr += Number((l as unknown as { estimatedValue?: number }).estimatedValue || 0);
      const leadStatus = String(l.status || '').toLowerCase();
      if (['qualified', 'proposal', 'converted', 'won'].includes(leadStatus)) {
        bucket.qualifiedOrWon += 1;
      }
      const tagsList = Array.isArray((l as unknown as { tags?: string[] }).tags)
        ? ((l as unknown as { tags?: string[] }).tags as string[])
        : [];
      if (tagsList.some((t) => t.startsWith('Flagged:'))) {
        bucket.junkFlagged += 1;
      }
    }

    const categoryRoiBreakdown = Array.from(categoryMap.values())
      .map((row) => ({
        ...row,
        conversionRatePct:
          row.inquiries > 0
            ? Math.round((row.qualifiedOrWon / row.inquiries) * 100)
            : 0,
      }))
      .sort((a, b) => b.totalValueInr - a.totalValueInr || b.inquiries - a.inquiries)
      .slice(0, 10);

    return {
      config: {
        enabled: Boolean(cfg.enabled),
        hasCrmKey: Boolean(cfg.glusrCrmKeyEncrypted),
        glusrCrmKeyMask: String(cfg.glusrCrmKeyMask || ''),
        registeredMobile: String(cfg.registeredMobile || ''),
        pollIntervalMinutes: Number(cfg.pollIntervalMinutes || 5),
        autoWhatsAppSpeedToLead: cfg.autoWhatsAppSpeedToLead !== false,
        greetingTemplate: String(
          cfg.greetingTemplate || this.buildDefaultConfig().greetingTemplate,
        ),
        slaThresholdMinutes: slaMinutes,
        autoAttachProductBrochure: cfg.autoAttachProductBrochure !== false,
        autoQuickReplyButtons: Array.isArray(cfg.autoQuickReplyButtons)
          ? cfg.autoQuickReplyButtons
          : ['Share GST Quote', 'Download Catalog', 'Book Callback'],
        brokerFilterEnabled: cfg.brokerFilterEnabled !== false,
        skipWhatsAppOnJunk: Boolean(cfg.skipWhatsAppOnJunk),
        junkKeywords: String(
          cfg.junkKeywords ||
            'test, fake, sample free, job, vacancy, resume, student',
        ),
        lastSyncedAt: String(cfg.lastSyncedAt || ''),
        lastSyncStatus: String(cfg.lastSyncStatus || ''),
        lastSyncSummary: String(cfg.lastSyncSummary || ''),
      },
      slaMetrics: {
        totalMarketplaceLeads: marketplaceLeads.length,
        autoWelcomedCount: marketplaceLeads.filter((l) => l.autoWhatsAppWelcomeSent)
          .length,
        junkFlaggedCount: marketplaceLeads.filter((l) =>
          Array.isArray((l as unknown as { tags?: string[] }).tags) &&
          ((l as unknown as { tags?: string[] }).tags as string[]).some((t) =>
            t.startsWith('Flagged:'),
          ),
        ).length,
        contactedUnder10sCount: under10sCount,
        under10sPct:
          contactedLeads.length > 0
            ? Math.round((under10sCount / contactedLeads.length) * 100)
            : 0,
        avgSpeedToLeadSeconds: avgSpeedSeconds,
        slaBreachedCount: slaBreachedLeads.length,
        slaBreachedLeads,
      },
      categoryRoiBreakdown,
      recentLogs: recentLogs.map((log) => ({
        id: String(log._id),
        channel: log.channel,
        mode: log.mode,
        fetchedCount: log.fetchedCount,
        createdCount: log.createdCount,
        deduplicatedCount: log.deduplicatedCount,
        skippedCount: log.skippedCount,
        whatsAppDispatchedCount: log.whatsAppDispatchedCount,
        durationMs: log.durationMs,
        status: log.status,
        errorMessage: log.errorMessage || '',
        sampleLeads: log.sampleLeads || [],
        syncedAt: log.syncedAt,
      })),
    };
  }

  private async ensureTenantConnectorsHydrated(tenantId: string) {
    const tenantOid = new Types.ObjectId(tenantId);
    const tenant = await this.tenantModel.findById(tenantOid);
    if (!tenant) throw new NotFoundException('Workspace not found.');

    let dirty = false;
    if (!tenant.webhookKey) {
      tenant.webhookKey = `lsw_${randomBytes(12).toString('hex')}`;
      dirty = true;
    }
    const curr = tenant.leadConnectors || {};
    const nextMeta = {
      enabled: curr.metaLeadAds?.enabled ?? false,
      verifyToken:
        curr.metaLeadAds?.verifyToken ||
        `lsmeta_${randomBytes(8).toString('hex')}`,
      appSecretEncrypted: curr.metaLeadAds?.appSecretEncrypted || '',
      appSecretMask: curr.metaLeadAds?.appSecretMask || '',
      pageAccessTokenEncrypted:
        curr.metaLeadAds?.pageAccessTokenEncrypted || '',
      pageAccessTokenMask: curr.metaLeadAds?.pageAccessTokenMask || '',
      pageId: curr.metaLeadAds?.pageId || '',
      pageName: curr.metaLeadAds?.pageName || '',
      formId: curr.metaLeadAds?.formId || '',
      autoWhatsAppWelcome: curr.metaLeadAds?.autoWhatsAppWelcome !== false,
      lastReceivedAt: curr.metaLeadAds?.lastReceivedAt || '',
      lastLeadSummary: curr.metaLeadAds?.lastLeadSummary || '',
    };
    const nextJd = {
      enabled: curr.justdialWebhook?.enabled ?? true,
      secretToken: curr.justdialWebhook?.secretToken || '',
      categoryFilter: curr.justdialWebhook?.categoryFilter || '',
      autoWhatsAppWelcome: curr.justdialWebhook?.autoWhatsAppWelcome !== false,
      pincodeZoneRules: curr.justdialWebhook?.pincodeZoneRules || '',
      autoCreateTicketForService:
        curr.justdialWebhook?.autoCreateTicketForService !== false,
      serviceCategoryKeywords:
        curr.justdialWebhook?.serviceCategoryKeywords ||
        'repair, service, amc, installation, complaint, warranty',
      reviewBoosterEnabled:
        curr.justdialWebhook?.reviewBoosterEnabled !== false,
      reviewLink: curr.justdialWebhook?.reviewLink || '',
      lastReceivedAt: curr.justdialWebhook?.lastReceivedAt || '',
      lastLeadSummary: curr.justdialWebhook?.lastLeadSummary || '',
    };
    const nextTi = {
      enabled: curr.tradeindiaWebhook?.enabled ?? true,
      secretToken: curr.tradeindiaWebhook?.secretToken || '',
      apiUserId: curr.tradeindiaWebhook?.apiUserId || '',
      profileId: curr.tradeindiaWebhook?.profileId || '',
      keyEncrypted: curr.tradeindiaWebhook?.keyEncrypted || '',
      keyMask: curr.tradeindiaWebhook?.keyMask || '',
      autoWhatsAppWelcome: curr.tradeindiaWebhook?.autoWhatsAppWelcome !== false,
      lastReceivedAt: curr.tradeindiaWebhook?.lastReceivedAt || '',
      lastLeadSummary: curr.tradeindiaWebhook?.lastLeadSummary || '',
    };
    const defaultBooking = buildDefaultBookingScheduler(
      tenant.companyName || tenant.name,
      tenant.accountId,
    );
    const nextBooking = {
      ...defaultBooking,
      ...(curr.bookingScheduler || {}),
      slug: sanitizeBookingSlug(
        curr.bookingScheduler?.slug || defaultBooking.slug,
      ),
    };

    if (
      !curr.metaLeadAds?.verifyToken ||
      !curr.bookingScheduler?.slug
    ) {
      tenant.leadConnectors = {
        metaLeadAds: nextMeta,
        justdialWebhook: nextJd,
        tradeindiaWebhook: nextTi,
        bookingScheduler: nextBooking,
      };
      tenant.markModified('leadConnectors');
      dirty = true;
    }

    if (dirty) {
      await tenant.save();
    }

    return {
      tenant,
      webhookKey: tenant.webhookKey!,
      connectors: {
        metaLeadAds: nextMeta,
        justdialWebhook: nextJd,
        tradeindiaWebhook: nextTi,
        bookingScheduler: nextBooking,
      },
    };
  }

  async getConnectorsOverview(authHeader?: string) {
    const auth = await this.verifyAuth(authHeader);
    const { webhookKey, connectors } = await this.ensureTenantConnectorsHydrated(
      auth.tenantId,
    );
    const bookings = await (
      this.bookingSchedulerService
        ? this.bookingSchedulerService.listTenantBookings(auth.tenantId)
        : Promise.resolve([])
    );

    return {
      webhookKey,
      endpoints: {
        metaLeadAdsWebhookPath: `/v1/marketplace-sync/webhooks/meta-lead-ads/${webhookKey}`,
        justdialWebhookPath: `/v1/marketplace-sync/webhooks/justdial/${webhookKey}`,
        tradeindiaWebhookPath: `/v1/marketplace-sync/webhooks/tradeindia/${webhookKey}`,
        bookingPublicPath: `/book/${connectors.bookingScheduler.slug}`,
      },
      metaLeadAds: {
        enabled: Boolean(connectors.metaLeadAds.enabled),
        verifyToken: connectors.metaLeadAds.verifyToken,
        hasAppSecret: Boolean(connectors.metaLeadAds.appSecretEncrypted),
        appSecretMask: connectors.metaLeadAds.appSecretMask || '',
        hasPageAccessToken: Boolean(
          connectors.metaLeadAds.pageAccessTokenEncrypted,
        ),
        pageAccessTokenMask: connectors.metaLeadAds.pageAccessTokenMask || '',
        pageId: connectors.metaLeadAds.pageId || '',
        pageName: connectors.metaLeadAds.pageName || '',
        formId: connectors.metaLeadAds.formId || '',
        autoWhatsAppWelcome: connectors.metaLeadAds.autoWhatsAppWelcome !== false,
        lastReceivedAt: connectors.metaLeadAds.lastReceivedAt || '',
        lastLeadSummary: connectors.metaLeadAds.lastLeadSummary || '',
      },
      justdialWebhook: {
        enabled: connectors.justdialWebhook.enabled !== false,
        secretToken: connectors.justdialWebhook.secretToken || '',
        categoryFilter: connectors.justdialWebhook.categoryFilter || '',
        autoWhatsAppWelcome:
          connectors.justdialWebhook.autoWhatsAppWelcome !== false,
        pincodeZoneRules: connectors.justdialWebhook.pincodeZoneRules || '',
        autoCreateTicketForService:
          connectors.justdialWebhook.autoCreateTicketForService !== false,
        serviceCategoryKeywords:
          connectors.justdialWebhook.serviceCategoryKeywords ||
          'repair, service, amc, installation, complaint, warranty',
        reviewBoosterEnabled:
          connectors.justdialWebhook.reviewBoosterEnabled !== false,
        reviewLink: connectors.justdialWebhook.reviewLink || '',
        lastReceivedAt: connectors.justdialWebhook.lastReceivedAt || '',
        lastLeadSummary: connectors.justdialWebhook.lastLeadSummary || '',
      },
      tradeindiaWebhook: {
        enabled: connectors.tradeindiaWebhook.enabled !== false,
        secretToken: connectors.tradeindiaWebhook.secretToken || '',
        apiUserId: connectors.tradeindiaWebhook.apiUserId || '',
        profileId: connectors.tradeindiaWebhook.profileId || '',
        hasApiKey: Boolean(connectors.tradeindiaWebhook.keyEncrypted),
        apiKeyMask: connectors.tradeindiaWebhook.keyMask || '',
        autoWhatsAppWelcome:
          connectors.tradeindiaWebhook.autoWhatsAppWelcome !== false,
        lastReceivedAt: connectors.tradeindiaWebhook.lastReceivedAt || '',
        lastLeadSummary: connectors.tradeindiaWebhook.lastLeadSummary || '',
      },
      bookingScheduler: connectors.bookingScheduler,
      recentBookings: bookings,
    };
  }

  async updateConnectors(
    authHeader: string | undefined,
    dto: UpdateLeadConnectorsDto,
  ) {
    const auth = await this.verifyAuth(authHeader);
    if (!['owner', 'admin', 'super_admin'].includes(auth.role)) {
      throw new ForbiddenException(
        'Only workspace Owners or Admins can configure lead capture & booking connectors.',
      );
    }

    const { tenant, connectors } = await this.ensureTenantConnectorsHydrated(
      auth.tenantId,
    );

    const nextMeta = { ...connectors.metaLeadAds };
    if (dto.metaLeadAds) {
      const m = dto.metaLeadAds;
      if (m.enabled !== undefined) nextMeta.enabled = Boolean(m.enabled);
      if (m.verifyToken !== undefined && m.verifyToken.trim()) {
        nextMeta.verifyToken = m.verifyToken.trim();
      }
      if (m.pageId !== undefined) nextMeta.pageId = m.pageId.trim();
      if (m.pageName !== undefined) nextMeta.pageName = m.pageName.trim();
      if (m.formId !== undefined) nextMeta.formId = m.formId.trim();
      if (m.autoWhatsAppWelcome !== undefined) {
        nextMeta.autoWhatsAppWelcome = Boolean(m.autoWhatsAppWelcome);
      }
      if (m.clearAppSecret) {
        nextMeta.appSecretEncrypted = '';
        nextMeta.appSecretMask = '';
      } else if (m.appSecret?.trim()) {
        const s = m.appSecret.trim();
        nextMeta.appSecretEncrypted = encryptSecret(s, auth.tenantId);
        nextMeta.appSecretMask = maskSecret(s);
      }
      if (m.clearPageAccessToken) {
        nextMeta.pageAccessTokenEncrypted = '';
        nextMeta.pageAccessTokenMask = '';
      } else if (m.pageAccessToken?.trim()) {
        const t = m.pageAccessToken.trim();
        nextMeta.pageAccessTokenEncrypted = encryptSecret(t, auth.tenantId);
        nextMeta.pageAccessTokenMask = maskSecret(t);
      }
    }

    const nextJd = { ...connectors.justdialWebhook };
    if (dto.justdialWebhook) {
      const j = dto.justdialWebhook;
      if (j.enabled !== undefined) nextJd.enabled = Boolean(j.enabled);
      if (j.secretToken !== undefined) nextJd.secretToken = j.secretToken.trim();
      if (j.categoryFilter !== undefined) {
        nextJd.categoryFilter = j.categoryFilter.trim();
      }
      if (j.autoWhatsAppWelcome !== undefined) {
        nextJd.autoWhatsAppWelcome = Boolean(j.autoWhatsAppWelcome);
      }
      if (j.pincodeZoneRules !== undefined) {
        nextJd.pincodeZoneRules = j.pincodeZoneRules.trim();
      }
      if (j.autoCreateTicketForService !== undefined) {
        nextJd.autoCreateTicketForService = Boolean(j.autoCreateTicketForService);
      }
      if (j.serviceCategoryKeywords !== undefined) {
        nextJd.serviceCategoryKeywords = j.serviceCategoryKeywords.trim();
      }
      if (j.reviewBoosterEnabled !== undefined) {
        nextJd.reviewBoosterEnabled = Boolean(j.reviewBoosterEnabled);
      }
      if (j.reviewLink !== undefined) {
        nextJd.reviewLink = j.reviewLink.trim();
      }
    }

    const nextTi = { ...connectors.tradeindiaWebhook };
    if (dto.tradeindiaWebhook) {
      const ti = dto.tradeindiaWebhook;
      if (ti.enabled !== undefined) nextTi.enabled = Boolean(ti.enabled);
      if (ti.secretToken !== undefined) nextTi.secretToken = ti.secretToken.trim();
      if (ti.apiUserId !== undefined) nextTi.apiUserId = ti.apiUserId.trim();
      if (ti.profileId !== undefined) nextTi.profileId = ti.profileId.trim();
      if (ti.autoWhatsAppWelcome !== undefined) {
        nextTi.autoWhatsAppWelcome = Boolean(ti.autoWhatsAppWelcome);
      }
      if (ti.clearApiKey) {
        nextTi.keyEncrypted = '';
        nextTi.keyMask = '';
      } else if (ti.apiKey?.trim()) {
        const k = ti.apiKey.trim();
        nextTi.keyEncrypted = encryptSecret(k, auth.tenantId);
        nextTi.keyMask = maskSecret(k);
      }
    }

    const nextBooking = { ...connectors.bookingScheduler };
    if (dto.bookingScheduler) {
      const b = dto.bookingScheduler;
      if (b.enabled !== undefined) nextBooking.enabled = Boolean(b.enabled);
      if (b.slug !== undefined && b.slug.trim()) {
        const candidate = sanitizeBookingSlug(b.slug.trim());
        const clash = await this.tenantModel
          .findOne({
            _id: { $ne: tenant._id },
            'leadConnectors.bookingScheduler.slug': candidate,
          })
          .select('_id')
          .lean();
        if (clash) {
          throw new BadRequestException(
            `Booking slug "${candidate}" is already taken. Choose another unique slug.`,
          );
        }
        nextBooking.slug = candidate;
      }
      if (b.title !== undefined && b.title.trim()) {
        nextBooking.title = b.title.trim().slice(0, 120);
      }
      if (b.subtitle !== undefined) {
        nextBooking.subtitle = b.subtitle.trim().slice(0, 240);
      }
      if (b.durationMinutes !== undefined) {
        nextBooking.durationMinutes = Math.max(
          15,
          Math.min(120, Number(b.durationMinutes) || 30),
        );
      }
      if (b.bufferMinutes !== undefined) {
        nextBooking.bufferMinutes = Math.max(
          0,
          Math.min(30, Number(b.bufferMinutes) || 0),
        );
      }
      if (Array.isArray(b.workingDays) && b.workingDays.length > 0) {
        nextBooking.workingDays = b.workingDays
          .map((d) => Number(d))
          .filter((d) => d >= 0 && d <= 6);
      }
      if (b.startHour && /^\d{2}:\d{2}$/.test(b.startHour)) {
        nextBooking.startHour = b.startHour;
      }
      if (b.endHour && /^\d{2}:\d{2}$/.test(b.endHour)) {
        nextBooking.endHour = b.endHour;
      }
      if (b.meetingType) nextBooking.meetingType = b.meetingType;
      if (b.confirmationWhatsappEnabled !== undefined) {
        nextBooking.confirmationWhatsappEnabled = Boolean(
          b.confirmationWhatsappEnabled,
        );
      }
      if (b.reminder1HrEnabled !== undefined) {
        nextBooking.reminder1HrEnabled = Boolean(b.reminder1HrEnabled);
      }
    }

    tenant.leadConnectors = {
      metaLeadAds: nextMeta,
      justdialWebhook: nextJd,
      tradeindiaWebhook: nextTi,
      bookingScheduler: nextBooking,
    };
    tenant.markModified('leadConnectors');
    await tenant.save();

    return this.getConnectorsOverview(authHeader);
  }

  private async resolveTenantWebhookOwner(webhookKey: string) {
    const cleanKey = String(webhookKey || '').trim();
    if (!cleanKey) throw new NotFoundException('Webhook key is required.');
    const tenant = await this.tenantModel.findOne({ webhookKey: cleanKey });
    if (!tenant) throw new NotFoundException('Invalid or rotated webhook key.');

    const owner = await this.userModel
      .findOne({ tenantId: tenant._id, isActive: { $ne: false } })
      .sort({ _id: 1 })
      .lean();
    if (!owner) {
      throw new BadRequestException('No active user found in target workspace.');
    }

    return {
      tenant,
      ownerAuth: {
        userId: String(owner._id),
        tenantId: String(tenant._id),
        email: String(owner.email || 'webhook@leadsetu.in'),
        name: String(owner.name || 'Webhook Capture'),
        role: String(owner.role || 'owner'),
      },
    };
  }

  async verifyMetaLeadAdsChallenge(
    webhookKey: string,
    mode?: string,
    verifyToken?: string,
    challenge?: string,
  ): Promise<string> {
    const { tenant } = await this.resolveTenantWebhookOwner(webhookKey);
    const expected = tenant.leadConnectors?.metaLeadAds?.verifyToken || '';
    if (
      mode === 'subscribe' &&
      expected &&
      verifyToken &&
      verifyToken.trim() === expected
    ) {
      return String(challenge || 'verified');
    }
    throw new UnauthorizedException('Meta Lead Ads verify_token mismatch.');
  }

  async handleMetaLeadAdsWebhook(
    webhookKey: string,
    rawBody: Buffer | string | undefined,
    signatureHeader: string | undefined,
    payload: Record<string, unknown>,
  ) {
    const { tenant, ownerAuth } = await this.resolveTenantWebhookOwner(webhookKey);
    const cfg = tenant.leadConnectors?.metaLeadAds;
    if (cfg?.enabled === false) {
      return { ignored: true, reason: 'Meta Lead Ads connector paused by workspace.' };
    }

    const appSecret = decryptSecret(
      cfg?.appSecretEncrypted || '',
      String(tenant._id),
    );
    if (appSecret && signatureHeader) {
      const rawBuf = Buffer.isBuffer(rawBody)
        ? rawBody
        : Buffer.from(
            typeof rawBody === 'string' && rawBody.length > 0
              ? rawBody
              : JSON.stringify(payload || {}),
            'utf8',
          );
      const expectedSig =
        'sha256=' +
        createHmac('sha256', appSecret).update(rawBuf).digest('hex');
      const a = Buffer.from(expectedSig.toLowerCase(), 'utf8');
      const b = Buffer.from(String(signatureHeader).trim().toLowerCase(), 'utf8');
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        throw new UnauthorizedException('Invalid X-Hub-Signature-256 header.');
      }
    }

    const pageAccessToken = decryptSecret(
      cfg?.pageAccessTokenEncrypted || '',
      String(tenant._id),
    );
    const records: MarketplaceRawLeadItemDto[] = [];

    // 1. Parse official Meta Graph API entry[].changes[].value.leadgen_id
    const entries = Array.isArray(payload?.entry)
      ? (payload.entry as Array<Record<string, unknown>>)
      : [];
    for (const entry of entries) {
      const changes = Array.isArray(entry?.changes)
        ? (entry.changes as Array<Record<string, unknown>>)
        : [];
      for (const change of changes) {
        const val = (change?.value || {}) as Record<string, unknown>;
        const leadgenId = String(val.leadgen_id || '').trim();
        if (!leadgenId) continue;

        let name = String(val.full_name || val.name || '').trim();
        let phone = String(val.phone_number || val.phone || '').trim();
        let email = String(val.email || '').trim();
        let city = String(val.city || '').trim();
        let company = String(val.company_name || '').trim();
        let product = String(val.product || val.form_name || '').trim();

        if (pageAccessToken && (!name || !phone)) {
          try {
            const graphUrl = `https://graph.facebook.com/v21.0/${encodeURIComponent(leadgenId)}?fields=field_data,created_time,ad_id,form_id&access_token=${encodeURIComponent(pageAccessToken)}`;
            const gRes = await fetch(graphUrl, {
              method: 'GET',
              signal: AbortSignal.timeout(8_000),
            });
            const gJson = (await gRes.json().catch(() => ({}))) as {
              field_data?: Array<{ name?: string; values?: string[] }>;
            };
            for (const f of gJson.field_data || []) {
              const key = String(f.name || '').toLowerCase();
              const valFirst = String(f.values?.[0] || '').trim();
              if (!valFirst) continue;
              if (key.includes('name') && !key.includes('company') && !name) {
                name = valFirst;
              } else if (
                (key.includes('phone') || key.includes('mobile')) &&
                !phone
              ) {
                phone = valFirst;
              } else if (key.includes('email') && !email) {
                email = valFirst;
              } else if (key.includes('city') && !city) {
                city = valFirst;
              } else if (key.includes('company') && !company) {
                company = valFirst;
              } else if (!product && (key.includes('product') || key.includes('service'))) {
                product = valFirst;
              }
            }
          } catch {
            // Fall back safely to webhook payload attributes
          }
        }

        if (name || phone || email) {
          records.push({
            externalQueryId: `META-${leadgenId}`,
            name: name || `Meta Ad Lead ${leadgenId.slice(-6)}`,
            phone,
            email,
            city: city || tenant.city || '',
            company,
            product: product || 'Meta Lead Ads Instant Form',
            message: `Captured via Meta Lead Ads (Form ${String(val.form_id || cfg?.formId || '-')}, Ad ${String(val.ad_id || '-')})`,
          });
        }
      }
    }

    // 2. Also accept normalized direct JSON payloads (from Make / Zapier / Webhooks)
    if (records.length === 0) {
      const name = String(
        payload?.full_name ?? payload?.name ?? payload?.first_name ?? '',
      ).trim();
      const phone = String(
        payload?.phone_number ?? payload?.phone ?? payload?.mobile ?? '',
      ).trim();
      const email = String(payload?.email ?? '').trim();
      if (name || phone || email) {
        records.push({
          externalQueryId: String(
            payload?.leadgen_id ?? payload?.id ?? `META-${Date.now()}`,
          ),
          name: name || `Meta Lead ${phone || email}`,
          phone,
          email,
          city: String(payload?.city || tenant.city || ''),
          company: String(payload?.company_name ?? payload?.company ?? ''),
          product: String(
            payload?.ad_name ?? payload?.campaign_name ?? payload?.form_name ?? 'Meta Instant Lead Form',
          ),
          message: String(payload?.message ?? payload?.notes ?? 'Submitted via Meta Lead Ads'),
        });
      }
    }

    if (records.length === 0) {
      return {
        received: true,
        createdCount: 0,
        note: 'Webhook accepted cleanly (no parseable lead contact fields supplied).',
      };
    }

    return this.ingestRecords({
      auth: ownerAuth,
      tenant,
      channel: 'meta_lead_ads',
      mode: 'live_api',
      records,
      autoWelcome: cfg?.autoWhatsAppWelcome !== false,
    });
  }

  async handleJustdialWebhook(
    webhookKey: string,
    input: Record<string, unknown>,
  ) {
    const { tenant, ownerAuth } = await this.resolveTenantWebhookOwner(webhookKey);
    const cfg = tenant.leadConnectors?.justdialWebhook;
    if (cfg?.enabled === false) {
      return { ignored: true, reason: 'Justdial webhook connector paused.' };
    }
    if (
      cfg?.secretToken &&
      String(input?.token || input?.secret || '').trim() !== cfg.secretToken
    ) {
      throw new UnauthorizedException('Invalid Justdial webhook secret token.');
    }

    const name = String(
      input?.name ?? input?.leadname ?? input?.prefix ?? '',
    ).trim();
    const phone = String(
      input?.mobile ?? input?.phone ?? input?.contact ?? '',
    ).trim();
    const email = String(input?.email ?? '').trim();
    if (!name && !phone && !email) {
      throw new BadRequestException(
        'Justdial payload must include name, mobile/phone, or email.',
      );
    }

    const category = String(input?.category ?? input?.leadtype ?? 'Justdial Inquiry').trim();
    const city = String(input?.city ?? input?.area ?? tenant.city ?? '').trim();
    const pincode = String(input?.pincode ?? input?.pin ?? '').trim();
    const extId = String(input?.leadid ?? input?.id ?? `JD-${Date.now()}`).trim();

    return this.ingestRecords({
      auth: ownerAuth,
      tenant,
      channel: 'justdial_feed',
      mode: 'live_api',
      autoWelcome: cfg?.autoWhatsAppWelcome !== false,
      records: [
        {
          externalQueryId: extId,
          name: name || `JD Lead ${phone || email}`,
          company: String(input?.company ?? input?.brancharea ?? '').trim(),
          phone,
          email,
          city,
          pincode,
          product: category,
          message: String(
            input?.message ?? input?.query ?? `Justdial ${category} inquiry in ${city}`,
          ).trim(),
        },
      ],
    });
  }

  async sendJustdialReviewNudge(authHeader: string | undefined, leadId: string) {
    const auth = await this.verifyAuth(authHeader);
    if (!Types.ObjectId.isValid(leadId)) {
      throw new BadRequestException('Invalid lead ID.');
    }
    const [lead, tenant] = await Promise.all([
      this.leadModel.findOne({
        _id: new Types.ObjectId(leadId),
        tenantId: new Types.ObjectId(auth.tenantId),
      }),
      this.tenantModel.findById(new Types.ObjectId(auth.tenantId)).lean(),
    ]);
    if (!lead) throw new NotFoundException('Lead not found.');
    if (!lead.phone) {
      throw new BadRequestException('Buyer mobile number is missing.');
    }
    const reviewLink =
      tenant?.leadConnectors?.justdialWebhook?.reviewLink?.trim() ||
      'https://www.justdial.com';
    const companyName = String(
      tenant?.companyName || tenant?.name || 'our team',
    ).trim();
    const msg = `Namaste ${lead.name || 'Buyer'} ji! Thank you for choosing ${companyName}. It only takes 15 seconds to rate your experience with us on Justdial: ${reviewLink}`;

    if (this.inboxService) {
      await this.inboxService.startOrGetConversation(auth, {
        linkedEntityType: 'lead',
        linkedEntityId: String(lead._id),
        contactName: lead.name,
        company: lead.company || '',
        phone: lead.phone,
        city: lead.city || '',
        estimatedValue: Number(lead.estimatedValue || 0),
        channel: 'whatsapp',
        initialMessage: msg,
        via: 'inbox',
        isAiDrafted: false,
        logToTimeline: true,
      });
    }

    await this.leadModel.updateOne(
      { _id: lead._id },
      { $addToSet: { tags: 'Justdial Review Nudge Sent' } },
    );

    return {
      ok: true,
      leadId: String(lead._id),
      reviewLink,
    };
  }

  async handleTradeIndiaWebhook(
    webhookKey: string,
    input: Record<string, unknown>,
  ) {
    const { tenant, ownerAuth } = await this.resolveTenantWebhookOwner(webhookKey);
    const cfg = tenant.leadConnectors?.tradeindiaWebhook;
    if (cfg?.enabled === false) {
      return { ignored: true, reason: 'TradeIndia webhook connector paused.' };
    }
    if (
      cfg?.secretToken &&
      String(input?.token || input?.secret || '').trim() !== cfg.secretToken
    ) {
      throw new UnauthorizedException('Invalid TradeIndia webhook secret token.');
    }

    const name = String(
      input?.sender_name ?? input?.name ?? input?.contact_person ?? '',
    ).trim();
    const phone = String(
      input?.sender_mobile ?? input?.mobile ?? input?.phone ?? '',
    ).trim();
    const email = String(input?.sender_email ?? input?.email ?? '').trim();
    if (!name && !phone && !email) {
      throw new BadRequestException(
        'TradeIndia payload must include sender_name, sender_mobile/phone, or email.',
      );
    }

    const product = String(
      input?.product_name ?? input?.subject ?? 'TradeIndia B2B Inquiry',
    ).trim();
    const city = String(
      input?.sender_city ?? input?.city ?? tenant.city ?? '',
    ).trim();
    const extId = String(input?.rfi_id ?? input?.inquiry_id ?? `TI-${Date.now()}`).trim();

    return this.ingestRecords({
      auth: ownerAuth,
      tenant,
      channel: 'tradeindia_feed',
      mode: 'live_api',
      autoWelcome: cfg?.autoWhatsAppWelcome !== false,
      records: [
        {
          externalQueryId: extId,
          name: name || `TradeIndia Lead ${phone || email}`,
          company: String(input?.sender_co ?? input?.company ?? '').trim(),
          phone,
          email,
          city,
          product,
          message: String(
            input?.message ?? input?.description ?? `TradeIndia RFI for ${product}`,
          ).trim(),
        },
      ],
    });
  }

  async simulateConnectorWebhook(
    authHeader: string | undefined,
    dto: SimulateConnectorWebhookDto,
  ) {
    const auth = await this.verifyAuth(authHeader);
    const tenant = await this.tenantModel.findById(new Types.ObjectId(auth.tenantId));
    if (!tenant) throw new NotFoundException('Workspace not found.');

    const suffix = String(Date.now()).slice(-4);
    const record: MarketplaceRawLeadItemDto = {
      externalQueryId: `${dto.channel.toUpperCase()}-${Date.now()}`,
      name: dto.name?.trim() || 'Vikramaditya Sharma',
      company:
        dto.channel === 'meta_lead_ads'
          ? ''
          : `Sharma Industrial Enterprises`,
      phone: dto.phone?.trim() || `+91 98115 4${suffix}`,
      email: `buyer${suffix}@example.in`,
      city: dto.city?.trim() || tenant.city || 'Noida',
      pincode: dto.pincode?.trim() || '',
      product:
        dto.product?.trim() ||
        (dto.channel === 'meta_lead_ads'
          ? 'Meta Instant Quote Form'
          : dto.channel === 'justdial_feed'
            ? 'Industrial Voltage Stabilizers'
            : 'Bulk Copper Control Panel 3-Phase'),
      message: `Simulated live ${dto.channel.replace(/_/g, ' ')} capture with auto-routing & <10s WhatsApp.`,
      estimatedValue: dto.channel === 'tradeindia_feed' ? 240000 : 85000,
    };

    return this.ingestRecords({
      auth,
      tenant,
      channel: dto.channel,
      mode: 'sandbox',
      records: [record],
    });
  }
}
