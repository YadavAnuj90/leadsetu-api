import {
  BadRequestException,
  Injectable,
  NotFoundException,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Model, Types } from 'mongoose';
import { randomBytes } from 'crypto';
import {
  Lead,
  LeadActivity,
  LeadDocument,
  LeadSource,
  LeadStatus,
} from './schemas/lead.schema';
import { AuditService } from '../audit/audit.module';
import {
  maskPhoneNumber,
  normalizeIndianPhone,
  resolveOwnerScopeFilter,
} from '../auth/identity.util';
import { SuperAdminService } from '../super-admin/super-admin.service';
import { WorkflowsService } from '../workflows/workflows.service';
import { AiBridgeService } from '../ai-bridge/ai-bridge.service';
import { CustomFieldsService } from '../custom-fields/custom-fields.service';
import { LeadRoutingService } from '../lead-routing/lead-routing.service';
import { MetaCapiService } from '../meta-capi/meta-capi.service';
import { MarketplaceSyncService } from '../marketplace-sync/marketplace-sync.service';
import { dispatchMentionNotifications } from '../../common/mentions/mention-notifications.util';
import { resolveEffectiveGstinProviderConfig } from '../super-admin/platform-vaults.util';
import { evaluateGstinTrustProfile, type LeadGstinProfile } from './gstin.util';

export interface CreateLeadDto {
  name: string;
  accountKind?: 'business' | 'consumer';
  company?: string;
  phone?: string;
  email?: string;
  city?: string;
  gstin?: string;
  source?: LeadSource;
  status?: LeadStatus;
  estimatedValue?: number;
  tags?: string[];
  notes?: string;
  adPlatform?: string;
  ctwaClid?: string;
  adId?: string;
  adHeadline?: string;
  adSourceUrl?: string;
  customFields?: Record<string, unknown>;
  autoAssign?: boolean;
}

export interface BulkImportOptions {
  duplicateMode?: 'update' | 'skip';
  autoRoute?: boolean;
}

export interface MergeLeadsDto {
  primaryId: string;
  secondaryIds: string[];
  fieldOverrides?: {
    name?: string;
    company?: string;
    phone?: string;
    email?: string;
    city?: string;
    source?: LeadSource;
    status?: LeadStatus;
    accountKind?: 'business' | 'consumer';
    estimatedValue?: number;
    notes?: string;
  };
}

export interface UpdateLeadDto extends Partial<CreateLeadDto> {
  rescoreAi?: boolean;
}

export interface LeadsQuery {
  search?: string;
  status?: string;
  source?: string;
  aiLabel?: string;
  accountKind?: string;
  adPlatform?: string;
  sortBy?: 'aiScore' | 'createdAt' | 'estimatedValue';
  page?: string;
  limit?: string;
}

interface AuthContext {
  userId: string;
  tenantId: string;
  email: string;
}

@Injectable()
export class LeadsService {
  constructor(
    @InjectModel(Lead.name) private readonly leadModel: Model<LeadDocument>,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    @Optional() private readonly auditService?: AuditService,
    @Optional() private readonly superAdminService?: SuperAdminService,
    @Optional() private readonly workflowsService?: WorkflowsService,
    @Optional() private readonly aiBridge?: AiBridgeService,
    @Optional() private readonly customFieldsService?: CustomFieldsService,
    @Optional() private readonly leadRoutingService?: LeadRoutingService,
    @Optional() private readonly metaCapiService?: MetaCapiService,
    @Optional() private readonly marketplaceSyncService?: MarketplaceSyncService,
  ) {}

  async verifyAuth(authHeader?: string): Promise<AuthContext> {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Authorization token is required.');
    }

    const token = authHeader.slice(7).trim();
    const secret =
      this.configService.get<string>('JWT_SECRET') ||
      'leadsetu_super_secret_access_key_2026_delhi_ncr';

    try {
      const payload = await this.jwtService.verifyAsync<{
        sub: string;
        tenantId: string;
        email: string;
      }>(token, { secret });

      return {
        userId: payload.sub,
        tenantId: payload.tenantId,
        email: payload.email,
      };
    } catch {
      throw new UnauthorizedException('Invalid or expired session.');
    }
  }

  private computeAiIntelligence(input: {
    name?: string;
    city?: string;
    source?: LeadSource;
    status?: LeadStatus;
    estimatedValue?: number;
    company?: string;
    phone?: string;
    email?: string;
    notes?: string;
    whatsappMessages?: Array<{ direction?: string; content?: string }>;
    quotesOrInvoices?: Array<{
      invoiceNumber?: string;
      docType?: string;
      grandTotal?: number;
      status?: string;
    }>;
    recentActivities?: Array<{ type?: string; description?: string }>;
  }): {
    aiScore: number;
    aiLabel: 'Hot' | 'Warm' | 'Cold';
    aiInsight: string;
    aiSummary: string;
    aiNextAction: string;
    aiReasons: string[];
  } {
    let score = 52;
    const reasons: string[] = [];

    const sourceBoost: Record<string, number> = {
      whatsapp: 16,
      indiamart: 15,
      referral: 18,
      meta_ads: 12,
      google_ads: 14,
      justdial: 11,
      website: 10,
      manual: 8,
    };
    const src = input.source || 'whatsapp';
    score += sourceBoost[src] || 10;
    if (src === 'whatsapp' || src === 'indiamart' || src === 'referral') {
      reasons.push(`High-intent channel (${src.toUpperCase()})`);
    }

    const val = Number(input.estimatedValue || 0);
    if (val >= 500000) {
      score += 18;
      reasons.push('Enterprise ticket size (₹5L+)');
    } else if (val >= 200000) {
      score += 14;
      reasons.push('High B2B ticket size (₹2L+)');
    } else if (val >= 50000) {
      score += 9;
      reasons.push('Qualified order value (₹50K+)');
    } else if (val > 0) {
      score += 5;
    }

    if (input.company?.trim()) {
      score += 5;
      reasons.push(`Verified firm (${input.company.trim()})`);
    }
    if (input.phone?.trim()) score += 5;
    if (input.email?.trim()) score += 3;

    const waMsgs = input.whatsappMessages || [];
    const quotes = input.quotesOrInvoices || [];
    const acts = input.recentActivities || [];

    const combinedText = [
      input.notes || '',
      ...waMsgs.map((m) => m.content || ''),
      ...acts.map((a) => a.description || ''),
    ]
      .join(' ')
      .toLowerCase();

    if (
      /urgent|immediate|bulk|gst|quote|quotation|ready|visit|payment|order|po|finalize|turant|jaldi/.test(
        combinedText,
      )
    ) {
      score += 8;
      reasons.push('Commercial urgency / GST / MOQ intent detected');
    }

    if (waMsgs.some((m) => m.direction === 'inbound')) {
      score += 6;
      reasons.push('Two-way buyer WhatsApp engagement');
    }
    if (quotes.length > 0) {
      score += 7;
      reasons.push(`Quotation on record (${quotes[0]?.invoiceNumber || 'Sent'})`);
    }

    if (input.status === 'qualified' || input.status === 'proposal') {
      score = Math.max(score, 82);
    } else if (input.status === 'converted') {
      score = 98;
      reasons.unshift('Lead converted to Deal');
    } else if (input.status === 'lost') {
      score = Math.min(score, 35);
    }

    const finalScore = Math.max(18, Math.min(99, score));
    const aiLabel: 'Hot' | 'Warm' | 'Cold' =
      finalScore >= 80 ? 'Hot' : finalScore >= 58 ? 'Warm' : 'Cold';

    const latestQuote = quotes[0];
    const cityLabel = input.city?.trim() || 'Delhi-NCR';
    const buyerLabel = input.name?.trim() || 'Buyer';
    const companyLabel = input.company?.trim() || 'Direct Account';

    let aiNextAction =
      'Send introductory WhatsApp message, qualify MOQ & GSTIN, and confirm buyer requirement.';
    if (input.status === 'converted') {
      aiNextAction =
        'Deal won! Issue 18% GST tax invoice with Razorpay payment link and trigger onboarding.';
    } else if (latestQuote?.invoiceNumber) {
      aiNextAction = `Follow up on ${latestQuote.invoiceNumber} (₹${Number(
        latestQuote.grandTotal || val,
      ).toLocaleString('en-IN')}) via WhatsApp and confirm dispatch timeline for ${cityLabel}.`;
    } else if (finalScore >= 82 || input.status === 'proposal' || input.status === 'qualified') {
      aiNextAction = `High-intent buyer (${
        val > 0 ? `₹${val.toLocaleString('en-IN')} est.` : 'priority'
      }) — generate & send 18% GST Proforma Quotation PDF on WhatsApp within 15 mins.`;
    } else if (finalScore >= 68) {
      aiNextAction =
        'Strong B2B fit — schedule a 5-minute discovery call and share product catalogue PDF on WhatsApp.';
    } else if (finalScore < 50) {
      aiNextAction =
        'Low immediate urgency — enroll in automated 7-day WhatsApp nurture sequence.';
    }

    const aiInsight = aiNextAction;
    const latestInbound = [...waMsgs]
      .reverse()
      .find((m) => m.direction === 'inbound' && m.content);
    const aiSummary = `${buyerLabel} (${companyLabel}, ${cityLabel}) enquired via ${src.toUpperCase()} for ~₹${val.toLocaleString(
      'en-IN',
    )}. ${
      latestInbound?.content
        ? `Latest buyer WhatsApp reply: "${String(latestInbound.content).slice(0, 110)}".`
        : input.notes?.trim()
        ? `Requirement: ${input.notes.trim().slice(0, 130)}.`
        : aiNextAction
    }`;

    return {
      aiScore: finalScore,
      aiLabel,
      aiInsight,
      aiSummary,
      aiNextAction,
      aiReasons: reasons.slice(0, 4),
    };
  }

  private async buildLeadAiContext(
    tenantId: string,
    input: {
      entityId?: string;
      name?: string;
      company?: string;
      phone?: string;
      email?: string;
      city?: string;
      source?: LeadSource;
      status?: LeadStatus;
      estimatedValue?: number;
      notes?: string;
      tags?: string[];
      activities?: LeadActivity[];
    },
  ) {
    const tenantObjectId = new Types.ObjectId(tenantId);
    const tenDigits = this.last10Digits(input.phone);

    let whatsappMessages: Array<{
      direction: string;
      senderName: string;
      content: string;
    }> = [];
    let conversationAiSummary = '';
    let quotesOrInvoices: Array<{
      invoiceNumber: string;
      docType: string;
      grandTotal: number;
      status: string;
    }> = [];

    try {
      const convOr: Record<string, unknown>[] = [];
      if (input.entityId) {
        convOr.push({ linkedEntityType: 'lead', linkedEntityId: input.entityId });
      }
      if (tenDigits) {
        const pattern = `${tenDigits.slice(0, 5)}\\D*${tenDigits.slice(5)}$`;
        convOr.push({ phone: { $regex: pattern } });
      }
      if (convOr.length > 0) {
        const conv = await this.leadModel.db
          .collection('conversations')
          .findOne(
            { tenantId: tenantObjectId, $or: convOr },
            { sort: { updatedAt: -1 } },
          );
        if (conv) {
          conversationAiSummary = String(conv.aiSummary || '');
          const rawMsgs = Array.isArray(conv.messages) ? conv.messages : [];
          whatsappMessages = rawMsgs.slice(-6).map((m: Record<string, unknown>) => ({
            direction: String(m.direction || 'inbound'),
            senderName: String(m.senderName || ''),
            content: String(m.content || ''),
          }));
        }
      }
    } catch {
      // ignore optional conversation lookup errors
    }

    try {
      const invOr: Record<string, unknown>[] = [];
      if (input.entityId) {
        invOr.push({ linkedLeadId: input.entityId });
      }
      if (tenDigits) {
        const pattern = `${tenDigits.slice(0, 5)}\\D*${tenDigits.slice(5)}$`;
        invOr.push({ phone: { $regex: pattern } });
      }
      if (invOr.length > 0) {
        const invDocs = await this.leadModel.db
          .collection('invoices')
          .find({ tenantId: tenantObjectId, $or: invOr })
          .sort({ createdAt: -1 })
          .limit(3)
          .toArray();
        quotesOrInvoices = invDocs.map((inv) => ({
          invoiceNumber: String(inv.invoiceNumber || ''),
          docType: String(inv.docType || 'proforma_quote'),
          grandTotal: Number(inv.grandTotal || 0),
          status: String(inv.status || 'sent'),
        }));
      }
    } catch {
      // ignore optional invoice lookup errors
    }

    const recentActivities = (input.activities || []).slice(0, 6).map((a) => ({
      type: a.type,
      description: a.description,
      createdAt: a.createdAt,
    }));

    return {
      entityType: 'lead',
      name: input.name || 'Buyer',
      company: input.company || '',
      phone: input.phone || '',
      email: input.email || '',
      city: input.city || 'Delhi-NCR',
      source: input.source || 'whatsapp',
      status: input.status || 'new',
      estimatedValue: Number(input.estimatedValue || 0),
      notes: input.notes || '',
      tags: input.tags || [],
      conversationAiSummary,
      whatsappMessages,
      quotesOrInvoices,
      recentActivities,
    };
  }

  private async evaluateLeadAiIntelligence(
    auth: AuthContext,
    input: {
      entityId?: string;
      name?: string;
      company?: string;
      phone?: string;
      email?: string;
      city?: string;
      source?: LeadSource;
      status?: LeadStatus;
      estimatedValue?: number;
      notes?: string;
      tags?: string[];
      activities?: LeadActivity[];
    },
  ): Promise<{
    aiScore: number;
    aiLabel: 'Hot' | 'Warm' | 'Cold';
    aiInsight: string;
    aiSummary: string;
    aiNextAction: string;
    aiReasons: string[];
    aiScoredAt: string;
    provider: string;
    model: string;
  }> {
    const ctx = await this.buildLeadAiContext(auth.tenantId, input);
    const fallback = this.computeAiIntelligence({
      name: ctx.name,
      city: ctx.city,
      source: ctx.source,
      status: ctx.status,
      estimatedValue: ctx.estimatedValue,
      company: ctx.company,
      phone: ctx.phone,
      email: ctx.email,
      notes: ctx.notes,
      whatsappMessages: ctx.whatsappMessages,
      quotesOrInvoices: ctx.quotesOrInvoices,
      recentActivities: ctx.recentActivities,
    });

    const [scoreRes, summaryRes, actionRes] = await Promise.all([
      this.aiBridge
        ? this.aiBridge
            .scoreLeadIntent(
              {
                tenantId: auth.tenantId,
                userId: auth.userId,
                userRole: 'owner',
                context: ctx,
              },
              { skipMetering: true, timeoutMs: 6500 },
            )
            .catch(() => null)
        : Promise.resolve(null),
      this.aiBridge
        ? this.aiBridge
            .summarizeLeadOrDeal(
              {
                tenantId: auth.tenantId,
                userId: auth.userId,
                userRole: 'owner',
                context: ctx,
              },
              { skipMetering: true, timeoutMs: 6500 },
            )
            .catch(() => null)
        : Promise.resolve(null),
      this.aiBridge
        ? this.aiBridge
            .recommendNextBestAction(
              {
                tenantId: auth.tenantId,
                userId: auth.userId,
                userRole: 'owner',
                context: { ...ctx, aiScore: fallback.aiScore },
              },
              { skipMetering: true, timeoutMs: 6500 },
            )
            .catch(() => null)
        : Promise.resolve(null),
    ]);

    const structured = scoreRes?.structured;
    const aiScore =
      typeof structured?.aiScore === 'number'
        ? Math.min(99, Math.max(15, Math.round(structured.aiScore)))
        : fallback.aiScore;
    const aiLabel: 'Hot' | 'Warm' | 'Cold' =
      structured?.aiLabel === 'Hot' ||
      structured?.aiLabel === 'Warm' ||
      structured?.aiLabel === 'Cold'
        ? structured.aiLabel
        : aiScore >= 80
        ? 'Hot'
        : aiScore >= 58
        ? 'Warm'
        : 'Cold';
    const aiNextAction =
      actionRes?.result?.trim() ||
      structured?.aiInsight?.trim() ||
      fallback.aiNextAction;
    const aiInsight =
      structured?.aiInsight?.trim() || aiNextAction || fallback.aiInsight;
    const aiSummary = summaryRes?.result?.trim() || fallback.aiSummary;
    const aiReasons =
      Array.isArray(structured?.reasons) && structured.reasons.length > 0
        ? structured.reasons.slice(0, 4).map((r) => String(r))
        : fallback.aiReasons;

    return {
      aiScore,
      aiLabel,
      aiInsight,
      aiSummary,
      aiNextAction,
      aiReasons,
      aiScoredAt: new Date().toISOString(),
      provider:
        scoreRes?.provider ||
        actionRes?.provider ||
        summaryRes?.provider ||
        'fallback',
      model:
        scoreRes?.model ||
        actionRes?.model ||
        summaryRes?.model ||
        'leadsetu-heuristic-v1',
    };
  }

  private toDto(doc: LeadDocument, maskPhones = false) {
    const raw = doc.toObject() as unknown as Record<string, unknown> & {
      createdAt?: Date;
      updatedAt?: Date;
    };
    return {
      id: doc._id.toString(),
      tenantId: doc.tenantId.toString(),
      ownerId: doc.ownerId.toString(),
      name: doc.name,
      accountKind: doc.accountKind === 'consumer' ? 'consumer' : 'business',
      company: doc.company || '',
      phone: maskPhones ? maskPhoneNumber(doc.phone) : doc.phone || '',
      email: doc.email || '',
      city: doc.city || 'Delhi-NCR',
      gstin: doc.gstin || '',
      gstinProfile: doc.gstinProfile || undefined,
      source: doc.source,
      status: doc.status,
      estimatedValue: doc.estimatedValue || 0,
      aiScore: doc.aiScore || 70,
      aiLabel: doc.aiLabel || 'Warm',
      aiInsight: doc.aiInsight || '',
      aiSummary: doc.aiSummary || doc.aiInsight || '',
      aiNextAction: doc.aiNextAction || doc.aiInsight || '',
      aiReasons: Array.isArray(doc.aiReasons) ? doc.aiReasons : [],
      aiScoredAt: doc.aiScoredAt || '',
      tags: doc.tags || [],
      notes: doc.notes || '',
      adPlatform: doc.adPlatform || '',
      ctwaClid: doc.ctwaClid || '',
      adId: doc.adId || '',
      adHeadline: doc.adHeadline || '',
      adSourceUrl: doc.adSourceUrl || '',
      externalQueryId: doc.externalQueryId || '',
      firstContactedAt: doc.firstContactedAt || '',
      speedToLeadSeconds:
        typeof doc.speedToLeadSeconds === 'number' ? doc.speedToLeadSeconds : -1,
      autoWhatsAppWelcomeSent: Boolean(doc.autoWhatsAppWelcomeSent),
      metaLeadData: doc.metaLeadData || undefined,
      customFields: doc.customFields || {},
      activities: doc.activities || [],
      createdAt: raw.createdAt ? new Date(raw.createdAt).toISOString() : new Date().toISOString(),
      updatedAt: raw.updatedAt ? new Date(raw.updatedAt).toISOString() : new Date().toISOString(),
    };
  }

  async findAll(auth: AuthContext, query: LeadsQuery) {
    // Non-blocking check for stale New / Proposal leads needing automated WhatsApp follow-up
    this.workflowsService?.runStaleLeadFollowUps(auth).catch(() => {});

    const tenantObjectId = new Types.ObjectId(auth.tenantId);
    const ownerScope = await resolveOwnerScopeFilter(this.leadModel.db, auth);
    const baseScope: Record<string, unknown> = {
      tenantId: tenantObjectId,
      ...ownerScope,
    };
    const filter: Record<string, unknown> = { ...baseScope };

    if (query.status && query.status !== 'all') {
      filter.status = query.status;
    }
    if (query.source && query.source !== 'all') {
      filter.source = query.source;
    }
    if (query.aiLabel && query.aiLabel !== 'all') {
      filter.aiLabel = query.aiLabel;
    }
    if (query.accountKind === 'consumer') {
      filter.accountKind = 'consumer';
    } else if (query.accountKind === 'business') {
      filter.accountKind = { $ne: 'consumer' };
    }
    const andClauses: Record<string, unknown>[] = [];
    if (query.adPlatform === 'meta_ctwa') {
      andClauses.push({
        $or: [
          { adPlatform: 'meta_ctwa' },
          { source: 'meta_ads' },
          { ctwaClid: { $ne: '' } },
          { adId: { $ne: '' } },
        ],
      });
    }
    if (query.search?.trim()) {
      const regex = new RegExp(query.search.trim(), 'i');
      andClauses.push({
        $or: [
          { name: regex },
          { company: regex },
          { phone: regex },
          { email: regex },
          { city: regex },
          { adHeadline: regex },
        ],
      });
    }
    if (andClauses.length === 1) {
      Object.assign(filter, andClauses[0]);
    } else if (andClauses.length > 1) {
      filter.$and = andClauses;
    }

    const sortField = query.sortBy || 'createdAt';
    const sortObj: Record<string, 1 | -1> =
      sortField === 'aiScore'
        ? { aiScore: -1, createdAt: -1 }
        : sortField === 'estimatedValue'
        ? { estimatedValue: -1, createdAt: -1 }
        : { createdAt: -1 };

    const [docs, allTenantLeads, maskPhones] = await Promise.all([
      this.leadModel.find(filter).sort(sortObj).exec(),
      this.leadModel.find(baseScope).exec(),
      this.auditService
        ? this.auditService.shouldMaskViewerPhones(auth.tenantId, auth.userId)
        : Promise.resolve(false),
    ]);

    const total = allTenantLeads.length;
    const businessCount = allTenantLeads.filter(
      (l) => l.accountKind !== 'consumer',
    ).length;
    const consumerCount = allTenantLeads.filter(
      (l) => l.accountKind === 'consumer',
    ).length;
    const hotCount = allTenantLeads.filter((l) => l.aiLabel === 'Hot').length;
    const qualifiedCount = allTenantLeads.filter((l) =>
      ['qualified', 'proposal', 'converted'].includes(l.status),
    ).length;
    const convertedCount = allTenantLeads.filter(
      (l) => l.status === 'converted',
    ).length;
    const metaCtwaCount = allTenantLeads.filter(
      (l) =>
        l.adPlatform === 'meta_ctwa' ||
        l.source === 'meta_ads' ||
        Boolean(l.ctwaClid) ||
        Boolean(l.adId),
    ).length;
    const totalPipelineValue = allTenantLeads
      .filter((l) => l.status !== 'lost')
      .reduce((acc, l) => acc + (Number(l.estimatedValue) || 0), 0);
    const avgAiScore =
      total > 0
        ? Math.round(
            allTenantLeads.reduce((acc, l) => acc + (l.aiScore || 70), 0) /
              total,
          )
        : 0;

    return {
      data: docs.map((d) => this.toDto(d, maskPhones)),
      stats: {
        total,
        businessCount,
        consumerCount,
        hotCount,
        qualifiedCount,
        convertedCount,
        metaCtwaCount,
        totalPipelineValue,
        avgAiScore,
      },
    };
  }

  async findOne(auth: AuthContext, id: string) {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Lead not found.');
    }
    const ownerScope = await resolveOwnerScopeFilter(this.leadModel.db, auth);
    const doc = await this.leadModel
      .findOne({
        _id: new Types.ObjectId(id),
        tenantId: new Types.ObjectId(auth.tenantId),
        ...ownerScope,
      })
      .exec();

    if (!doc) {
      throw new NotFoundException('Lead not found in your workspace.');
    }
    const maskPhones = this.auditService
      ? await this.auditService.shouldMaskViewerPhones(auth.tenantId, auth.userId)
      : false;
    return this.toDto(doc, maskPhones);
  }

  async create(auth: AuthContext, dto: CreateLeadDto) {
    if (!dto.name?.trim()) {
      throw new BadRequestException('Lead name is required.');
    }

    const eff = this.superAdminService
      ? await this.superAdminService.getTenantEffectiveState(auth.tenantId).catch(() => null)
      : null;
    const aiEnabled = eff?.effectiveFeatures?.aiScoring ?? true;
    if (aiEnabled) {
      await this.superAdminService?.consumeTenantQuota(auth.tenantId, 'ai', 1);
    }
    const ai = aiEnabled
      ? await this.evaluateLeadAiIntelligence(auth, dto)
      : {
          aiScore: 0,
          aiLabel: 'Warm' as const,
          aiInsight: 'SetuAI Lead Scoring disabled by Leadsetu HQ.',
          aiSummary: 'SetuAI Lead Scoring disabled by Leadsetu HQ.',
          aiNextAction: 'SetuAI Lead Scoring disabled by Leadsetu HQ.',
          aiReasons: [] as string[],
          aiScoredAt: '',
          provider: 'disabled',
          model: 'none',
        };
    const nowIso = new Date().toISOString();

    const initialActivity: LeadActivity = {
      id: randomBytes(6).toString('hex'),
      type: 'created',
      description: `Lead captured via ${(dto.source || 'whatsapp').toUpperCase()} · SetuAI scored ${ai.aiScore}/100 (${ai.aiLabel})`,
      authorName: auth.email.split('@')[0],
      createdAt: nowIso,
    };

    const sanitizedCustomFields = this.customFieldsService
      ? await this.customFieldsService.sanitizeEntityValues(
          auth.tenantId,
          'lead',
          dto.customFields,
        )
      : dto.customFields || {};

    let ownerId = auth.userId;
    if (this.leadRoutingService && dto.autoAssign !== false) {
      try {
        const routingCfg = await this.leadRoutingService.ensureConfig(auth.tenantId);
        if (dto.autoAssign === true || (routingCfg.enabled && routingCfg.applyOnManualCreate)) {
          const routed = await this.leadRoutingService.resolveAssigneeForLead(
            auth.tenantId,
            {
              city: dto.city,
              source: dto.source || 'manual',
              estimatedValue: Number(dto.estimatedValue) || 0,
              leadName: dto.name.trim(),
              commit: true,
            },
          );
          ownerId = routed.assignedUserId;
          initialActivity.description += ` · Routed to ${routed.assignedUserName} (${routed.strategyUsed})`;
        }
      } catch {
        // Fallback to creator on routing unavailability
      }
    }

    let resolvedAccountKind: 'business' | 'consumer' =
      dto.accountKind === 'consumer' ? 'consumer' : 'business';
    if (dto.accountKind !== 'consumer' && dto.accountKind !== 'business') {
      const tenantDoc = await this.leadModel.db
        .collection('tenants')
        .findOne(
          { _id: new Types.ObjectId(auth.tenantId) },
          { projection: { businessMode: 1 } },
        )
        .catch(() => null);
      const bm = String(tenantDoc?.businessMode || '');
      if (bm === 'b2c' || bm === 'education' || bm === 'bpo') {
        resolvedAccountKind = 'consumer';
      }
    }

    const doc = await this.leadModel.create({
      tenantId: new Types.ObjectId(auth.tenantId),
      ownerId: new Types.ObjectId(ownerId),
      name: dto.name.trim(),
      accountKind: resolvedAccountKind,
      company: resolvedAccountKind === 'consumer' ? '' : dto.company?.trim() || '',
      phone: dto.phone?.trim() || '',
      email: dto.email?.trim().toLowerCase() || '',
      city: dto.city?.trim() || 'New Delhi',
      gstin: dto.gstin?.trim().toUpperCase() || '',
      ...(dto.gstin?.trim()
        ? {
            gstinProfile: await this.buildGstinProfileForTenant(
              auth.tenantId,
              dto.gstin,
              dto.company,
              dto.city,
              dto.phone,
            ),
          }
        : {}),
      source: dto.source || 'whatsapp',
      status: dto.status || 'new',
      estimatedValue: Number(dto.estimatedValue) || 0,
      aiScore: ai.aiScore,
      aiLabel: ai.aiLabel,
      aiInsight: ai.aiInsight,
      aiSummary: ai.aiSummary,
      aiNextAction: ai.aiNextAction,
      aiReasons: ai.aiReasons,
      aiScoredAt: ai.aiScoredAt,
      tags: Array.isArray(dto.tags) ? dto.tags : [],
      notes: dto.notes?.trim() || '',
      adPlatform:
        dto.adPlatform?.trim() ||
        (dto.ctwaClid || dto.adId ? 'meta_ctwa' : ''),
      ctwaClid: dto.ctwaClid?.trim() || '',
      adId: dto.adId?.trim() || '',
      adHeadline: dto.adHeadline?.trim() || '',
      adSourceUrl: dto.adSourceUrl?.trim() || '',
      customFields: sanitizedCustomFields,
      activities: [initialActivity],
    });

    // Auto-trigger active CRM Workflows (`lead.created` & `lead.hot_scored`) with real WhatsApp dispatch
    try {
      if (this.workflowsService) {
        await this.workflowsService.handleLeadCreatedEvent(auth, doc);
      } else {
        const wfTriggers =
          ai.aiScore >= 80
            ? ['lead.created', 'lead.hot_scored']
            : ['lead.created'];
        const wfCol = this.leadModel.db.collection('workflows');
        await wfCol.updateMany(
          {
            tenantId: new Types.ObjectId(auth.tenantId),
            active: true,
            triggerType: { $in: wfTriggers },
          },
          {
            $inc: { runsCount: 1 },
            $set: { lastRunAt: nowIso },
            $push: {
              executionLogs: {
                $each: [
                  {
                    id: `log-${Date.now()}`,
                    summary: `Auto-triggered for new lead "${doc.name}" (${doc.company || doc.city}) — AI Score ${ai.aiScore}/100`,
                    status: 'success',
                    executedAt: nowIso,
                  },
                ],
                $position: 0,
                $slice: 8,
              },
            },
          } as any,
        );
      }
    } catch {
      // Non-blocking workflow hook
    }

    await this.auditService?.record({
      tenantId: auth.tenantId,
      actorId: auth.userId,
      actorEmail: auth.email,
      action: 'lead.created',
      entityType: 'lead',
      entityId: doc._id.toString(),
      entityLabel: `${doc.name}${doc.company ? ` (${doc.company})` : ''}`,
      summary: `Captured lead ${doc.name} via ${(doc.source || 'whatsapp').toUpperCase()} · AI Score ${ai.aiScore}/100`,
    });

    const maskPhones = this.auditService
      ? await this.auditService.shouldMaskViewerPhones(auth.tenantId, auth.userId)
      : false;
    return this.toDto(doc, maskPhones);
  }

  async update(auth: AuthContext, id: string, dto: UpdateLeadDto) {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Lead not found.');
    }
    const ownerScope = await resolveOwnerScopeFilter(this.leadModel.db, auth);
    const doc = await this.leadModel
      .findOne({
        _id: new Types.ObjectId(id),
        tenantId: new Types.ObjectId(auth.tenantId),
        ...ownerScope,
      })
      .exec();

    if (!doc) {
      throw new NotFoundException('Lead not found.');
    }

    const prevStatus = doc.status;

    if (dto.name !== undefined) doc.name = dto.name.trim();
    if (dto.accountKind !== undefined) {
      doc.accountKind = dto.accountKind === 'consumer' ? 'consumer' : 'business';
    }
    if (dto.company !== undefined) doc.company = dto.company.trim();
    if (dto.phone !== undefined) doc.phone = dto.phone.trim();
    if (dto.email !== undefined) doc.email = dto.email.trim().toLowerCase();
    if (dto.city !== undefined) doc.city = dto.city.trim();
    if (dto.gstin !== undefined) {
      const cleanedGstin = dto.gstin.trim().toUpperCase();
      doc.gstin = cleanedGstin;
      doc.gstinProfile = cleanedGstin
        ? await this.buildGstinProfileForTenant(
            auth.tenantId,
            cleanedGstin,
            doc.company,
            doc.city,
            doc.phone,
          )
        : undefined;
      doc.markModified('gstinProfile');
    }
    if (dto.source !== undefined) doc.source = dto.source;
    if (dto.status !== undefined) doc.status = dto.status;
    if (dto.estimatedValue !== undefined)
      doc.estimatedValue = Number(dto.estimatedValue) || 0;
    if (dto.tags !== undefined) doc.tags = dto.tags;
    if (dto.notes !== undefined) doc.notes = dto.notes.trim();
    if (dto.adPlatform !== undefined) doc.adPlatform = dto.adPlatform.trim();
    if (dto.ctwaClid !== undefined) doc.ctwaClid = dto.ctwaClid.trim();
    if (dto.adId !== undefined) doc.adId = dto.adId.trim();
    if (dto.adHeadline !== undefined) doc.adHeadline = dto.adHeadline.trim();
    if (dto.adSourceUrl !== undefined) doc.adSourceUrl = dto.adSourceUrl.trim();
    if (dto.customFields !== undefined) {
      doc.customFields = this.customFieldsService
        ? await this.customFieldsService.sanitizeEntityValues(
            auth.tenantId,
            'lead',
            dto.customFields,
            doc.customFields,
          )
        : { ...(doc.customFields || {}), ...dto.customFields };
      doc.markModified('customFields');
    }

    if (dto.rescoreAi) {
      await this.superAdminService?.assertFeatureEnabled(auth.tenantId, 'aiScoring');
    }
    const eff = this.superAdminService
      ? await this.superAdminService.getTenantEffectiveState(auth.tenantId).catch(() => null)
      : null;
    if (!eff || eff.effectiveFeatures.aiScoring) {
      if (dto.rescoreAi) {
        await this.superAdminService?.consumeTenantQuota(auth.tenantId, 'ai', 1);
      }
      const ai = dto.rescoreAi
        ? await this.evaluateLeadAiIntelligence(auth, {
            entityId: doc._id.toString(),
            name: doc.name,
            city: doc.city,
            source: doc.source,
            status: doc.status,
            estimatedValue: doc.estimatedValue,
            company: doc.company,
            phone: doc.phone,
            email: doc.email,
            notes: doc.notes,
            tags: doc.tags,
            activities: doc.activities,
          })
        : {
            ...this.computeAiIntelligence({
              name: doc.name,
              city: doc.city,
              source: doc.source,
              status: doc.status,
              estimatedValue: doc.estimatedValue,
              company: doc.company,
              phone: doc.phone,
              email: doc.email,
              notes: doc.notes,
            }),
            aiScoredAt: new Date().toISOString(),
          };
      doc.aiScore = ai.aiScore;
      doc.aiLabel = ai.aiLabel;
      doc.aiInsight = ai.aiInsight;
      doc.aiSummary = ai.aiSummary;
      doc.aiNextAction = ai.aiNextAction;
      doc.aiReasons = ai.aiReasons;
      doc.aiScoredAt = ai.aiScoredAt;
    }

    if (dto.status && dto.status !== prevStatus) {
      if (dto.status !== 'new' && !doc.firstContactedAt) {
        const now = new Date();
        doc.firstContactedAt = now.toISOString();
        const createdMs = new Date(
          ((doc as unknown as { createdAt?: Date }).createdAt as Date) || now,
        ).getTime();
        doc.speedToLeadSeconds = Math.max(
          1,
          Math.round((now.getTime() - createdMs) / 1000),
        );
      }
      const activity: LeadActivity = {
        id: randomBytes(6).toString('hex'),
        type: 'status_change',
        description: `Stage updated from "${prevStatus.toUpperCase()}" to "${dto.status.toUpperCase()}"`,
        authorName: auth.email.split('@')[0],
        createdAt: new Date().toISOString(),
      };
      doc.activities = [activity, ...(doc.activities || [])];
    }

    await doc.save();
    if (dto.status && dto.status !== prevStatus) {
      await this.auditService?.record({
        tenantId: auth.tenantId,
        actorId: auth.userId,
        actorEmail: auth.email,
        action: 'lead.status_changed',
        entityType: 'lead',
        entityId: doc._id.toString(),
        entityLabel: `${doc.name}${doc.company ? ` (${doc.company})` : ''}`,
        summary: `Lead ${doc.name} status updated: ${prevStatus.toUpperCase()} -> ${dto.status.toUpperCase()}`,
      });
      if (doc.status === 'qualified' && prevStatus !== 'qualified' && this.metaCapiService) {
        await this.metaCapiService
          .fireConversionEvent({
            tenantId: auth.tenantId,
            eventName: 'QualifiedLead',
            entityType: 'lead',
            entityId: doc._id.toString(),
            entityLabel: doc.name,
            phone: doc.phone,
            email: doc.email,
            ctwaClid: doc.ctwaClid,
            adId: doc.adId,
            adHeadline: doc.adHeadline,
            adSourceUrl: doc.adSourceUrl,
            valueInr: Number(doc.estimatedValue || 0),
            triggeredBy: 'auto_lead_qualified',
            respectAutoToggle: true,
          })
          .catch(() => {});
      }
    }
    const maskPhones = this.auditService
      ? await this.auditService.shouldMaskViewerPhones(auth.tenantId, auth.userId)
      : false;
    return this.toDto(doc, maskPhones);
  }

  async addActivity(
    auth: AuthContext,
    id: string,
    body: { type?: LeadActivity['type']; description: string },
  ) {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Lead not found.');
    }
    if (!body.description?.trim()) {
      throw new BadRequestException('Activity note cannot be empty.');
    }

    const ownerScope = await resolveOwnerScopeFilter(this.leadModel.db, auth);
    const doc = await this.leadModel
      .findOne({
        _id: new Types.ObjectId(id),
        tenantId: new Types.ObjectId(auth.tenantId),
        ...ownerScope,
      })
      .exec();

    if (!doc) {
      throw new NotFoundException('Lead not found.');
    }

    const activity: LeadActivity = {
      id: randomBytes(6).toString('hex'),
      type: body.type || 'note',
      description: body.description.trim(),
      authorName: auth.email.split('@')[0],
      createdAt: new Date().toISOString(),
    };

    doc.activities = [activity, ...(doc.activities || [])];
    await doc.save();

    if (this.leadModel.db?.db) {
      await dispatchMentionNotifications({
        db: this.leadModel.db.db,
        tenantId: auth.tenantId,
        authorUserId: auth.userId,
        authorName: auth.email.split('@')[0],
        entityType: 'lead',
        entityId: doc._id.toString(),
        entityLabel: `${doc.name}${doc.company ? ` (${doc.company})` : ''}`,
        noteText: activity.description,
        activityId: activity.id,
      }).catch(() => {});
    }

    const maskPhones = this.auditService
      ? await this.auditService.shouldMaskViewerPhones(auth.tenantId, auth.userId)
      : false;
    return this.toDto(doc, maskPhones);
  }

  async analyzeWithAi(auth: AuthContext, id: string) {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Lead not found.');
    }
    await this.superAdminService?.assertFeatureEnabled(
      auth.tenantId,
      'aiScoring',
    );
    const ownerScope = await resolveOwnerScopeFilter(this.leadModel.db, auth);
    const doc = await this.leadModel
      .findOne({
        _id: new Types.ObjectId(id),
        tenantId: new Types.ObjectId(auth.tenantId),
        ...ownerScope,
      })
      .exec();

    if (!doc) {
      throw new NotFoundException('Lead not found in your workspace.');
    }

    await this.superAdminService?.consumeTenantQuota(auth.tenantId, 'ai', 1);

    const ai = await this.evaluateLeadAiIntelligence(auth, {
      entityId: doc._id.toString(),
      name: doc.name,
      company: doc.company,
      phone: doc.phone,
      email: doc.email,
      city: doc.city,
      source: doc.source,
      status: doc.status,
      estimatedValue: doc.estimatedValue,
      notes: doc.notes,
      tags: doc.tags,
      activities: doc.activities,
    });

    doc.aiScore = ai.aiScore;
    doc.aiLabel = ai.aiLabel;
    doc.aiInsight = ai.aiInsight;
    doc.aiSummary = ai.aiSummary;
    doc.aiNextAction = ai.aiNextAction;
    doc.aiReasons = ai.aiReasons;
    doc.aiScoredAt = ai.aiScoredAt;

    const activity: LeadActivity = {
      id: randomBytes(6).toString('hex'),
      type: 'ai_score',
      description: `SetuAI 360° Intent Rescore: ${ai.aiScore}/100 (${ai.aiLabel}) · Next Best Action: ${ai.aiNextAction}`,
      authorName: 'SetuAI Copilot',
      createdAt: ai.aiScoredAt,
    };
    doc.activities = [activity, ...(doc.activities || [])];
    await doc.save();

    await this.auditService?.record({
      tenantId: auth.tenantId,
      actorId: auth.userId,
      actorEmail: auth.email,
      action: 'lead.ai_analyzed',
      entityType: 'lead',
      entityId: doc._id.toString(),
      entityLabel: `${doc.name}${doc.company ? ` (${doc.company})` : ''}`,
      summary: `SetuAI scored lead ${doc.name} at ${ai.aiScore}/100 (${ai.aiLabel})`,
    });

    const maskPhones = this.auditService
      ? await this.auditService.shouldMaskViewerPhones(auth.tenantId, auth.userId)
      : false;

    return {
      lead: this.toDto(doc, maskPhones),
      aiScore: ai.aiScore,
      aiLabel: ai.aiLabel,
      aiInsight: ai.aiInsight,
      aiSummary: ai.aiSummary,
      aiNextAction: ai.aiNextAction,
      aiReasons: ai.aiReasons,
      aiScoredAt: ai.aiScoredAt,
      provider: ai.provider,
      model: ai.model,
    };
  }

  async remove(auth: AuthContext, id: string) {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Lead not found.');
    }
    const ownerScope = await resolveOwnerScopeFilter(this.leadModel.db, auth);
    const doc = await this.leadModel
      .findOneAndDelete({
        _id: new Types.ObjectId(id),
        tenantId: new Types.ObjectId(auth.tenantId),
        ...ownerScope,
      })
      .exec();

    if (doc) {
      await this.auditService?.record({
        tenantId: auth.tenantId,
        actorId: auth.userId,
        actorEmail: auth.email,
        action: 'lead.deleted',
        entityType: 'lead',
        entityId: id,
        entityLabel: `${doc.name}${doc.company ? ` (${doc.company})` : ''}`,
        summary: `Deleted lead ${doc.name}`,
      });
    }

    return { success: true, id };
  }

  private last10Digits(raw?: string): string {
    if (!raw) return '';
    const digits = raw.replace(/\D/g, '');
    return digits.length >= 10 ? digits.slice(-10) : '';
  }

  private async findDuplicateLead(
    tenantObjectId: Types.ObjectId,
    phone?: string,
    email?: string,
    ownerScope: Record<string, unknown> = {},
  ): Promise<LeadDocument | null> {
    const orClauses: Record<string, unknown>[] = [];
    const tenDigits = this.last10Digits(phone);
    if (tenDigits) {
      const pattern = `${tenDigits.slice(0, 5)}\\D*${tenDigits.slice(5)}$`;
      orClauses.push({ phone: { $regex: pattern } });
    }
    const cleanEmail = (email ?? '').trim().toLowerCase();
    if (cleanEmail) {
      orClauses.push({ email: cleanEmail });
    }
    if (orClauses.length === 0) return null;
    return this.leadModel
      .findOne({ tenantId: tenantObjectId, ...ownerScope, $or: orClauses })
      .exec();
  }

  async findDuplicates(auth: AuthContext) {
    const tenantObjectId = new Types.ObjectId(auth.tenantId);
    const ownerScope = await resolveOwnerScopeFilter(this.leadModel.db, auth);
    const [docs, maskPhones, userRows] = await Promise.all([
      this.leadModel
        .find({ tenantId: tenantObjectId, ...ownerScope })
        .sort({ createdAt: -1 })
        .exec(),
      this.auditService
        ? this.auditService.shouldMaskViewerPhones(auth.tenantId, auth.userId)
        : Promise.resolve(false),
      this.leadModel.db
        .collection('users')
        .find(
          { tenantId: tenantObjectId },
          { projection: { _id: 1, name: 1, email: 1 } },
        )
        .toArray()
        .catch(() => []),
    ]);

    const userNameById = new Map<string, string>();
    for (const u of userRows) {
      userNameById.set(
        String(u._id),
        String(u.name || u.email || 'Sales Rep'),
      );
    }

    const parent = docs.map((_, i) => i);
    const findRoot = (i: number): number => {
      let cur = i;
      while (parent[cur] !== cur) {
        parent[cur] = parent[parent[cur]];
        cur = parent[cur];
      }
      return cur;
    };
    const union = (a: number, b: number) => {
      const ra = findRoot(a);
      const rb = findRoot(b);
      if (ra !== rb) parent[rb] = ra;
    };

    const phoneMap = new Map<string, number>();
    const emailMap = new Map<string, number>();

    docs.forEach((doc, idx) => {
      const ten = this.last10Digits(doc.normalizedPhone || doc.phone);
      if (ten) {
        const firstIdx = phoneMap.get(ten);
        if (firstIdx !== undefined) {
          union(firstIdx, idx);
        } else {
          phoneMap.set(ten, idx);
        }
      }
      const cleanEmail = String(doc.email || '').trim().toLowerCase();
      if (cleanEmail) {
        const firstIdx = emailMap.get(cleanEmail);
        if (firstIdx !== undefined) {
          union(firstIdx, idx);
        } else {
          emailMap.set(cleanEmail, idx);
        }
      }
    });

    const clusters = new Map<number, number[]>();
    docs.forEach((_, idx) => {
      const root = findRoot(idx);
      const list = clusters.get(root);
      if (list) list.push(idx);
      else clusters.set(root, [idx]);
    });

    const dupClusters = Array.from(clusters.values()).filter(
      (indices) => indices.length >= 2,
    );

    const dupLeadIds = dupClusters.flat().map((i) => docs[i]._id);
    const dupLeadIdStrings = dupLeadIds.map((id) => id.toString());

    const [dealsRows, tasksRows] =
      dupLeadIds.length > 0
        ? await Promise.all([
            this.leadModel.db
              .collection('deals')
              .find(
                {
                  tenantId: tenantObjectId,
                  $or: [
                    { leadId: { $in: dupLeadIds } },
                    { leadId: { $in: dupLeadIdStrings } },
                  ],
                },
                { projection: { leadId: 1 } },
              )
              .toArray()
              .catch(() => []),
            this.leadModel.db
              .collection('tasks')
              .find(
                {
                  tenantId: tenantObjectId,
                  $or: [
                    { relatedEntityId: { $in: dupLeadIds } },
                    { relatedEntityId: { $in: dupLeadIdStrings } },
                  ],
                },
                { projection: { relatedEntityId: 1 } },
              )
              .toArray()
              .catch(() => []),
          ])
        : [[], []];

    const dealsCountByLead = new Map<string, number>();
    for (const d of dealsRows) {
      const k = String(d.leadId || '');
      if (k) dealsCountByLead.set(k, (dealsCountByLead.get(k) || 0) + 1);
    }
    const tasksCountByLead = new Map<string, number>();
    for (const t of tasksRows) {
      const k = String(t.relatedEntityId || '');
      if (k) tasksCountByLead.set(k, (tasksCountByLead.get(k) || 0) + 1);
    }

    const groups = dupClusters.map((indices, gIdx) => {
      const groupDocs = indices.map((i) => docs[i]);
      const phones = new Set<string>();
      const emails = new Set<string>();
      for (const d of groupDocs) {
        const ten = this.last10Digits(d.normalizedPhone || d.phone);
        if (ten) phones.add(ten);
        const em = String(d.email || '').trim().toLowerCase();
        if (em) emails.add(em);
      }
      const phoneCounts = new Map<string, number>();
      const emailCounts = new Map<string, number>();
      for (const d of groupDocs) {
        const ten = this.last10Digits(d.normalizedPhone || d.phone);
        if (ten) phoneCounts.set(ten, (phoneCounts.get(ten) || 0) + 1);
        const em = String(d.email || '').trim().toLowerCase();
        if (em) emailCounts.set(em, (emailCounts.get(em) || 0) + 1);
      }
      const matchedPhones = Array.from(phoneCounts.entries()).filter(
        ([, c]) => c >= 2,
      );
      const matchedEmails = Array.from(emailCounts.entries()).filter(
        ([, c]) => c >= 2,
      );

      const matchReason: 'phone' | 'email' | 'phone_and_email' =
        matchedPhones.length > 0 && matchedEmails.length > 0
          ? 'phone_and_email'
          : matchedEmails.length > 0
          ? 'email'
          : 'phone';

      const rawKey =
        matchedPhones[0]?.[0]
          ? `+91 ${matchedPhones[0][0]}`
          : matchedEmails[0]?.[0] ||
            Array.from(phones)[0] ||
            Array.from(emails)[0] ||
            'Match';
      const matchKey =
        matchedPhones[0]?.[0] && maskPhones
          ? maskPhoneNumber(rawKey)
          : rawKey;

      const enrichedLeads = groupDocs.map((d) => {
        const dto = this.toDto(d, maskPhones);
        const idStr = d._id.toString();
        const dealsCount = dealsCountByLead.get(idStr) || 0;
        const tasksCount = tasksCountByLead.get(idStr) || 0;
        const activitiesCount = Array.isArray(d.activities)
          ? d.activities.length
          : 0;
        return {
          ...dto,
          ownerName: userNameById.get(dto.ownerId) || 'Sales Rep',
          dealsCount,
          tasksCount,
          activitiesCount,
        };
      });

      let suggestedPrimaryId = enrichedLeads[0].id;
      let bestScore = -1;
      for (const item of enrichedLeads) {
        const richness =
          item.dealsCount * 30 +
          item.tasksCount * 10 +
          item.activitiesCount * 8 +
          (item.aiScore || 0) +
          (item.estimatedValue > 0 ? 15 : 0) +
          (item.email ? 5 : 0) +
          (item.company ? 5 : 0);
        if (richness > bestScore) {
          bestScore = richness;
          suggestedPrimaryId = item.id;
        }
      }

      return {
        groupId: `dup_${gIdx + 1}_${suggestedPrimaryId}`,
        matchReason,
        matchKey,
        suggestedPrimaryId,
        leads: enrichedLeads,
      };
    });

    const totalDuplicateRecords = groups.reduce(
      (acc, g) => acc + g.leads.length,
      0,
    );

    return {
      totalGroups: groups.length,
      totalDuplicateRecords,
      groups,
    };
  }

  async mergeLeads(auth: AuthContext, dto: MergeLeadsDto) {
    const primaryId = String(dto?.primaryId || '').trim();
    const rawSecondaryIds = Array.isArray(dto?.secondaryIds)
      ? dto.secondaryIds
      : [];
    const secondaryIds = Array.from(
      new Set(
        rawSecondaryIds
          .map((id) => String(id || '').trim())
          .filter((id) => id && id !== primaryId),
      ),
    );

    if (!Types.ObjectId.isValid(primaryId) || secondaryIds.length === 0) {
      throw new BadRequestException(
        'Provide a valid primaryId and at least one duplicate secondaryId.',
      );
    }
    if (secondaryIds.some((id) => !Types.ObjectId.isValid(id))) {
      throw new BadRequestException('One or more secondary lead IDs are invalid.');
    }

    const tenantObjectId = new Types.ObjectId(auth.tenantId);
    const ownerScope = await resolveOwnerScopeFilter(this.leadModel.db, auth);

    const primaryDoc = await this.leadModel
      .findOne({
        _id: new Types.ObjectId(primaryId),
        tenantId: tenantObjectId,
        ...ownerScope,
      })
      .exec();

    if (!primaryDoc) {
      throw new NotFoundException('Primary lead record not found.');
    }

    const secondaryObjectIds = secondaryIds.map((id) => new Types.ObjectId(id));
    const secondaryDocs = await this.leadModel
      .find({
        _id: { $in: secondaryObjectIds },
        tenantId: tenantObjectId,
        ...ownerScope,
      })
      .exec();

    if (secondaryDocs.length === 0) {
      throw new NotFoundException('No matching duplicate leads found to merge.');
    }

    const foundSecondaryObjectIds = secondaryDocs.map((d) => d._id);
    const foundSecondaryStrings = secondaryDocs.map((d) => d._id.toString());
    const ov = dto.fieldOverrides || {};

    const pickFirstNonEmpty = (values: Array<string | undefined>): string => {
      for (const v of values) {
        const s = String(v || '').trim();
        if (s) return s;
      }
      return '';
    };

    const mergedName =
      ov.name?.trim() ||
      pickFirstNonEmpty([primaryDoc.name, ...secondaryDocs.map((d) => d.name)]);
    const mergedCompany =
      ov.company !== undefined
        ? ov.company.trim()
        : pickFirstNonEmpty([
            primaryDoc.company,
            ...secondaryDocs.map((d) => d.company),
          ]);
    const mergedPhoneRaw =
      ov.phone !== undefined
        ? ov.phone.trim()
        : pickFirstNonEmpty([
            primaryDoc.phone,
            ...secondaryDocs.map((d) => d.phone),
          ]);
    const mergedPhone =
      normalizeIndianPhone(mergedPhoneRaw) || mergedPhoneRaw;
    const mergedEmail = (
      ov.email !== undefined
        ? ov.email
        : pickFirstNonEmpty([
            primaryDoc.email,
            ...secondaryDocs.map((d) => d.email),
          ])
    )
      .trim()
      .toLowerCase();
    const mergedCity =
      ov.city !== undefined
        ? ov.city.trim() || 'Delhi-NCR'
        : pickFirstNonEmpty([
            primaryDoc.city,
            ...secondaryDocs.map((d) => d.city),
          ]) || 'Delhi-NCR';
    const mergedSource = ov.source || primaryDoc.source;
    const mergedStatus = ov.status || primaryDoc.status;
    const mergedAccountKind = ov.accountKind || primaryDoc.accountKind;

    const allValues = [primaryDoc, ...secondaryDocs].map(
      (d) => Number(d.estimatedValue) || 0,
    );
    const mergedEstimatedValue =
      typeof ov.estimatedValue === 'number' && !Number.isNaN(ov.estimatedValue)
        ? Math.max(0, ov.estimatedValue)
        : Math.max(...allValues);

    // Combine distinct notes
    const mergedNotes =
      ov.notes !== undefined
        ? ov.notes.trim()
        : Array.from(
            new Set(
              [primaryDoc, ...secondaryDocs]
                .map((d) => String(d.notes || '').trim())
                .filter(Boolean),
            ),
          ).join('\n---\n');

    // Merge tags & customFields
    const tagSet = new Set<string>();
    for (const d of [primaryDoc, ...secondaryDocs]) {
      for (const t of d.tags || []) {
        const clean = String(t || '').trim();
        if (clean) tagSet.add(clean);
      }
    }

    const mergedCustomFields: Record<string, unknown> = {};
    for (const d of [...secondaryDocs].reverse()) {
      Object.assign(mergedCustomFields, d.customFields || {});
    }
    for (const [k, v] of Object.entries(primaryDoc.customFields || {})) {
      if (v !== undefined && v !== null && v !== '') {
        mergedCustomFields[k] = v;
      } else if (!(k in mergedCustomFields)) {
        mergedCustomFields[k] = v;
      }
    }

    // Merge activities sorted newest first and deduplicated
    const seenActivityKeys = new Set<string>();
    const combinedActivities: LeadActivity[] = [];
    for (const d of [primaryDoc, ...secondaryDocs]) {
      for (const act of d.activities || []) {
        const key = `${act.type}:${act.createdAt}:${act.description}`;
        if (seenActivityKeys.has(key)) continue;
        seenActivityKeys.add(key);
        combinedActivities.push(act);
      }
    }
    combinedActivities.sort((a, b) =>
      String(b.createdAt || '').localeCompare(String(a.createdAt || '')),
    );

    const mergeNote: LeadActivity = {
      id: randomBytes(6).toString('hex'),
      type: 'note',
      description: `Merged ${secondaryDocs.length} duplicate lead(s): ${secondaryDocs
        .map((s) => s.name)
        .join(', ')} into master record with full history preserved.`,
      authorName: auth.email.split('@')[0],
      createdAt: new Date().toISOString(),
    };

    // Preserve highest AI score
    const richestScoreDoc = [primaryDoc, ...secondaryDocs].reduce(
      (best, cur) => ((cur.aiScore || 0) > (best.aiScore || 0) ? cur : best),
      primaryDoc,
    );

    // Repoint linked collections before removing duplicates
    const db = this.leadModel.db;
    const primaryOid = primaryDoc._id;
    const primaryIdStr = primaryOid.toString();

    const repoint = async (
      colName: string,
      field: string,
      targetValue: unknown,
      matchValues: unknown[],
      extraFilter: Record<string, unknown> = {},
    ): Promise<number> => {
      try {
        const res = await db.collection(colName).updateMany(
          {
            tenantId: tenantObjectId,
            [field]: { $in: matchValues },
            ...extraFilter,
          },
          { $set: { [field]: targetValue } },
        );
        return res.modifiedCount || 0;
      } catch {
        return 0;
      }
    };

    const allMatchRefs = [...foundSecondaryObjectIds, ...foundSecondaryStrings];

    const [
      dealsMoved,
      tasksMoved,
      callsLeadIdMoved,
      callsEntityIdMoved,
      convsEntityMoved,
      convsLeadMoved,
      invoicesMoved,
      bookingsMoved,
      metaCapiMoved,
    ] = await Promise.all([
      repoint('deals', 'leadId', primaryOid, allMatchRefs),
      repoint('tasks', 'relatedEntityId', primaryIdStr, allMatchRefs),
      repoint('calls', 'leadId', primaryIdStr, allMatchRefs),
      repoint('calls', 'entityId', primaryIdStr, allMatchRefs),
      repoint('conversations', 'linkedEntityId', primaryIdStr, allMatchRefs, {
        linkedEntityType: 'lead',
      }),
      repoint('conversations', 'linkedLeadId', primaryIdStr, allMatchRefs),
      repoint('invoices', 'linkedLeadId', primaryIdStr, allMatchRefs),
      repoint('booking_appointments', 'leadId', primaryOid, allMatchRefs),
      repoint('meta_capi_events', 'leadId', primaryIdStr, allMatchRefs),
    ]);

    // Move workflow enrollments safely without triggering duplicate index conflicts
    try {
      const enrollments = await db
        .collection('workflow_enrollments')
        .find({
          tenantId: tenantObjectId,
          leadId: { $in: foundSecondaryObjectIds },
        })
        .toArray();
      for (const enr of enrollments) {
        const existsOnPrimary = await db
          .collection('workflow_enrollments')
          .findOne({
            tenantId: tenantObjectId,
            workflowId: enr.workflowId,
            leadId: primaryOid,
          });
        if (existsOnPrimary) {
          await db.collection('workflow_enrollments').deleteOne({ _id: enr._id });
        } else {
          await db
            .collection('workflow_enrollments')
            .updateOne({ _id: enr._id }, { $set: { leadId: primaryOid } });
        }
      }
    } catch {
      // Ignore enrollment cleanup issues
    }

    // Delete secondary duplicate records BEFORE updating normalizedPhone on primary
    await this.leadModel
      .deleteMany({
        _id: { $in: foundSecondaryObjectIds },
        tenantId: tenantObjectId,
      })
      .exec();

    const ten = this.last10Digits(mergedPhone);
    primaryDoc.name = mergedName;
    primaryDoc.company = mergedAccountKind === 'consumer' ? '' : mergedCompany;
    primaryDoc.phone = mergedPhone;
    if (ten) {
      primaryDoc.normalizedPhone = `+91${ten}`;
    }
    primaryDoc.email = mergedEmail;
    primaryDoc.city = mergedCity;
    primaryDoc.source = mergedSource;
    primaryDoc.status = mergedStatus;
    primaryDoc.accountKind = mergedAccountKind;
    primaryDoc.estimatedValue = mergedEstimatedValue;
    primaryDoc.notes = mergedNotes;
    primaryDoc.tags = Array.from(tagSet);
    primaryDoc.customFields = mergedCustomFields;
    primaryDoc.aiScore = richestScoreDoc.aiScore;
    primaryDoc.aiLabel = richestScoreDoc.aiLabel;
    if (!primaryDoc.aiInsight && richestScoreDoc.aiInsight) {
      primaryDoc.aiInsight = richestScoreDoc.aiInsight;
    }
    primaryDoc.activities = [mergeNote, ...combinedActivities].slice(0, 120);

    const savedPrimary = await primaryDoc.save();

    const repointedCounts = {
      deals: dealsMoved,
      tasks: tasksMoved,
      calls: callsLeadIdMoved + callsEntityIdMoved,
      conversations: convsEntityMoved + convsLeadMoved,
      invoices: invoicesMoved,
      appointments: bookingsMoved,
      metaCapiEvents: metaCapiMoved,
    };

    await this.auditService?.record({
      tenantId: auth.tenantId,
      actorId: auth.userId,
      actorEmail: auth.email,
      action: 'lead.merged',
      entityType: 'lead',
      entityId: primaryIdStr,
      entityLabel: `${savedPrimary.name}${savedPrimary.company ? ` (${savedPrimary.company})` : ''}`,
      summary: `Merged ${secondaryDocs.length} duplicate lead(s) into ${savedPrimary.name}`,
    });

    const maskPhones = this.auditService
      ? await this.auditService.shouldMaskViewerPhones(auth.tenantId, auth.userId)
      : false;

    return {
      merged: true,
      mergedCount: secondaryDocs.length,
      repointedCounts,
      primaryLead: this.toDto(savedPrimary, maskPhones),
    };
  }

  async bulkImport(
    auth: AuthContext,
    rows: CreateLeadDto[],
    options: BulkImportOptions = {},
  ) {
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new BadRequestException('Provide at least one CSV lead row to import.');
    }
    const duplicateMode = options.duplicateMode === 'skip' ? 'skip' : 'update';
    const autoRoute = Boolean(options.autoRoute);
    const tenantObjectId = new Types.ObjectId(auth.tenantId);
    const ownerScope = await resolveOwnerScopeFilter(this.leadModel.db, auth);
    const batch = rows.slice(0, 500);
    const data = [];
    const errors: Array<{ rowNumber: number; name: string; reason: string }> = [];
    let importedCount = 0;
    let duplicateUpdatedCount = 0;
    let skippedCount = 0;
    let routedCount = 0;

    for (let idx = 0; idx < batch.length; idx += 1) {
      const row = batch[idx];
      const name = String(row?.name ?? '').trim();
      if (!name) {
        skippedCount += 1;
        errors.push({
          rowNumber: idx + 1,
          name: '',
          reason: 'Missing buyer name',
        });
        continue;
      }

      const formattedPhone =
        normalizeIndianPhone(row.phone) ?? String(row.phone ?? '').trim();
      const email = String(row.email ?? '').trim().toLowerCase();

      const existing = await this.findDuplicateLead(
        tenantObjectId,
        formattedPhone,
        email,
        ownerScope,
      );

      if (existing) {
        if (duplicateMode === 'skip') {
          skippedCount += 1;
          errors.push({
            rowNumber: idx + 1,
            name,
            reason: 'Skipped matching existing phone/email lead',
          });
          continue;
        }

        const noteText = row.notes?.trim()
          ? `CSV/Excel Import refresh: ${row.notes.trim()}`
          : 'CSV/Excel Import match — refreshed inquiry timestamp.';
        existing.activities.unshift({
          id: randomBytes(6).toString('hex'),
          type: 'note',
          description: noteText,
          authorName: auth.email.split('@')[0],
          createdAt: new Date().toISOString(),
        });
        if (!existing.company && row.company) existing.company = row.company.trim();
        if (!existing.email && email) existing.email = email;
        if (!existing.city && row.city) existing.city = row.city.trim();
        if (
          typeof row.estimatedValue === 'number' &&
          row.estimatedValue > (existing.estimatedValue || 0)
        ) {
          existing.estimatedValue = row.estimatedValue;
        }
        if (Array.isArray(row.tags) && row.tags.length > 0) {
          existing.tags = Array.from(new Set([...(existing.tags || []), ...row.tags]));
        }
        if (row.customFields && typeof row.customFields === 'object') {
          const sanitizedCf = this.customFieldsService
            ? await this.customFieldsService.sanitizeEntityValues(
                auth.tenantId,
                'lead',
                row.customFields,
              )
            : row.customFields;
          existing.customFields = {
            ...(existing.customFields || {}),
            ...sanitizedCf,
          };
        }
        await existing.save();
        duplicateUpdatedCount += 1;
        data.push(await this.findOne(auth, String(existing._id)));
        continue;
      }

      const created = await this.create(auth, {
        name,
        accountKind: row.accountKind,
        company: row.company?.trim() ?? '',
        phone: formattedPhone,
        email,
        city: row.city?.trim() || 'Delhi-NCR',
        source: row.source || 'manual',
        status: row.status,
        estimatedValue: Number(row.estimatedValue ?? 0) || 0,
        tags: Array.isArray(row.tags) ? row.tags : undefined,
        notes: row.notes?.trim() ?? '',
        customFields: row.customFields,
        autoAssign: autoRoute,
      });
      importedCount += 1;
      if (autoRoute) routedCount += 1;
      data.push(created);
    }

    await this.auditService?.record({
      tenantId: auth.tenantId,
      actorId: auth.userId,
      actorEmail: auth.email,
      action: 'lead.bulk_imported',
      entityType: 'lead',
      entityId: auth.tenantId,
      entityLabel: 'CSV/Excel Bulk Import',
      summary: `Bulk import (${duplicateMode}): ${importedCount} created, ${duplicateUpdatedCount} updated, ${skippedCount} skipped`,
    });

    return {
      importedCount,
      duplicateUpdatedCount,
      skippedCount,
      routedCount,
      totalProcessed: batch.length,
      errors,
      data,
    };
  }

  async getWebhookConfig(auth: AuthContext) {
    await this.superAdminService?.assertFeatureEnabled(auth.tenantId, 'apiWebhooks');
    const tenantObjectId = new Types.ObjectId(auth.tenantId);
    const tenantsCol = this.leadModel.db.collection('tenants');
    const tenant = await tenantsCol.findOne({ _id: tenantObjectId });
    if (!tenant) {
      throw new NotFoundException('Workspace tenant not found.');
    }

    let webhookKey =
      typeof tenant.webhookKey === 'string' && tenant.webhookKey
        ? tenant.webhookKey
        : '';

    if (!webhookKey) {
      webhookKey = `lsw_${randomBytes(16).toString('hex')}`;
      await tenantsCol.updateOne(
        { _id: tenantObjectId },
        { $set: { webhookKey } },
      );
    }

    const maskPhones = this.auditService
      ? await this.auditService.shouldMaskViewerPhones(auth.tenantId, auth.userId)
      : false;

    const recentDocs = await this.leadModel
      .find({
        tenantId: tenantObjectId,
        source: { $in: ['indiamart', 'justdial', 'meta_ads', 'website'] },
      })
      .sort({ createdAt: -1 })
      .limit(8)
      .exec();

    return {
      webhookKey,
      webhookPath: `/v1/leads/webhook/${webhookKey}`,
      roundRobinIndex: Number(tenant.roundRobinIndex ?? 0),
      recentWebhookLeads: recentDocs.map((doc) => this.toDto(doc, maskPhones)),
    };
  }

  async rotateWebhookKey(auth: AuthContext) {
    await this.superAdminService?.assertFeatureEnabled(auth.tenantId, 'apiWebhooks');
    const actor = await this.leadModel.db
      .collection('users')
      .findOne({ _id: new Types.ObjectId(auth.userId) });
    const role = String(actor?.role ?? '');
    if (role !== 'owner' && role !== 'admin') {
      throw new UnauthorizedException(
        'Only workspace owners or admins can rotate the webhook capture key.',
      );
    }

    const tenantObjectId = new Types.ObjectId(auth.tenantId);
    const webhookKey = `lsw_${randomBytes(16).toString('hex')}`;
    await this.leadModel.db
      .collection('tenants')
      .updateOne({ _id: tenantObjectId }, { $set: { webhookKey } });

    await this.auditService?.record({
      tenantId: auth.tenantId,
      actorId: auth.userId,
      actorEmail: auth.email,
      action: 'webhook.key_rotated',
      entityType: 'security',
      entityId: auth.tenantId,
      entityLabel: 'Inbound Webhook Key',
      summary: 'Rotated inbound lead capture webhook key',
    });

    return {
      webhookKey,
      webhookPath: `/v1/leads/webhook/${webhookKey}`,
    };
  }

  private resolveWebhookSource(raw?: unknown): LeadSource {
    const val = String(raw ?? '').trim().toLowerCase();
    if (val === 'indiamart') return 'indiamart';
    if (val === 'justdial') return 'justdial';
    if (val === 'meta_ads' || val === 'meta' || val === 'facebook') return 'meta_ads';
    if (val === 'google_ads' || val === 'google') return 'google_ads';
    if (val === 'whatsapp') return 'whatsapp';
    if (val === 'referral') return 'referral';
    if (val === 'manual') return 'manual';
    return 'website';
  }

  async captureWebhook(webhookKey: string, payload: Record<string, unknown>) {
    const key = String(webhookKey ?? '').trim();
    if (!key) {
      throw new NotFoundException('Webhook key is required.');
    }

    const tenantsCol = this.leadModel.db.collection('tenants');
    const tenant = await tenantsCol.findOne({ webhookKey: key });
    if (!tenant) {
      throw new NotFoundException('Invalid or rotated webhook key.');
    }

    const tenantObjectId = tenant._id as Types.ObjectId;
    const tenantIdStr = String(tenantObjectId);
    await this.superAdminService?.assertFeatureEnabled(tenantIdStr, 'apiWebhooks');
    const rawName = String(
      payload?.SENDER_NAME ??
        payload?.name ??
        payload?.fullName ??
        payload?.customerName ??
        '',
    ).trim();
    const rawPhone = String(
      payload?.SENDER_MOBILE ??
        payload?.phone ??
        payload?.mobile ??
        payload?.SENDER_MOBILE_ALT ??
        '',
    ).trim();
    const rawEmail = String(
      payload?.SENDER_EMAIL ?? payload?.email ?? '',
    )
      .trim()
      .toLowerCase();

    if (!rawName && !rawPhone && !rawEmail) {
      throw new BadRequestException(
        'Webhook payload must include a contact name, phone, or email.',
      );
    }

    const formattedPhone = normalizeIndianPhone(rawPhone) ?? rawPhone;
    const inferredSource = payload?.SENDER_NAME || payload?.QUERY_ID
      ? 'indiamart'
      : this.resolveWebhookSource(payload?.source);

    const rawNotes = String(
      payload?.QUERY_MESSAGE ??
        payload?.QUERY_PRODUCT_NAME ??
        payload?.notes ??
        payload?.message ??
        '',
    ).trim();

    const existing = await this.findDuplicateLead(
      tenantObjectId,
      formattedPhone,
      rawEmail,
    );

    if (existing) {
      existing.activities.unshift({
        id: randomBytes(6).toString('hex'),
        type: 'note',
        description: `Inbound ${inferredSource} webhook inquiry: ${rawNotes || 'Repeat inquiry captured automatically.'}`,
        authorName: 'Webhook Capture',
        createdAt: new Date().toISOString(),
      });
      await existing.save();

      await this.auditService?.record({
        tenantId: tenantIdStr,
        actorId: String(existing.ownerId),
        actorName: 'Webhook Capture',
        actorRole: 'system',
        action: 'lead.webhook_deduplicated',
        entityType: 'lead',
        entityId: String(existing._id),
        entityLabel: existing.name,
        summary: `Deduplicated inbound ${inferredSource} inquiry for ${existing.name}`,
      });

      return {
        status: 'deduplicated' as const,
        assignedRepName: 'Existing Owner',
        lead: this.toDto(existing, false),
      };
    }

    const leadName = rawName || `Inquiry ${formattedPhone || rawEmail}`;
    const company = String(
      payload?.SENDER_COMPANY ?? payload?.company ?? '',
    ).trim();
    const city = String(
      payload?.SENDER_CITY ?? payload?.city ?? 'Delhi-NCR',
    ).trim();
    const estimatedValue = Number(payload?.estimatedValue ?? payload?.budget ?? 0) || 0;

    let assignedUserId = '';
    let repEmail = 'webhook@leadsetu.in';
    let repName = 'Sales Rep';
    let strategyUsed = 'round_robin';
    let routingReason = 'Assigned via workspace Round-Robin';

    if (this.leadRoutingService) {
      const routed = await this.leadRoutingService.resolveAssigneeForLead(
        tenantIdStr,
        {
          city,
          source: inferredSource,
          estimatedValue,
          leadName,
          commit: true,
        },
      );
      assignedUserId = routed.assignedUserId;
      repEmail = routed.assignedUserEmail || repEmail;
      repName = routed.assignedUserName || repName;
      strategyUsed = routed.strategyUsed;
      routingReason = routed.reason;
    } else {
      const usersCol = this.leadModel.db.collection('users');
      const reps = await usersCol
        .find({ tenantId: tenantObjectId, isActive: { $ne: false } })
        .sort({ _id: 1 })
        .toArray();

      if (reps.length === 0) {
        throw new BadRequestException('No active sales users in workspace.');
      }

      const currentIdx = Number(tenant.roundRobinIndex ?? 0);
      const chosenRep = reps[currentIdx % reps.length];
      await tenantsCol.updateOne(
        { _id: tenantObjectId },
        { $set: { roundRobinIndex: (currentIdx + 1) % reps.length } },
      );
      assignedUserId = String(chosenRep._id);
      repEmail = String(chosenRep.email ?? repEmail);
      repName = String(chosenRep.name ?? repName);
    }

    const repAuth: AuthContext = {
      userId: assignedUserId,
      tenantId: tenantIdStr,
      email: repEmail,
    };

    const created = await this.create(repAuth, {
      name: leadName,
      company,
      phone: formattedPhone,
      email: rawEmail,
      city,
      source: inferredSource,
      estimatedValue,
      notes: rawNotes || `Captured live via ${inferredSource} webhook`,
      autoAssign: false,
    });

    await this.auditService?.record({
      tenantId: tenantIdStr,
      actorId: repAuth.userId,
      actorName: 'Webhook Capture',
      actorEmail: repAuth.email,
      actorRole: 'system',
      action: 'lead.webhook_captured',
      entityType: 'lead',
      entityId: created.id,
      entityLabel: created.name,
      summary: `Captured ${inferredSource} webhook lead ${created.name} -> ${repName} (${routingReason})`,
    });

    if (this.marketplaceSyncService && formattedPhone && Types.ObjectId.isValid(created.id)) {
      const createdDoc = await this.leadModel.findById(created.id).exec();
      if (createdDoc) {
        await this.marketplaceSyncService
          .dispatchInstantWelcomeForLead({
            tenantId: tenantIdStr,
            leadDoc: createdDoc,
            repAuth: {
              userId: repAuth.userId,
              tenantId: tenantIdStr,
              email: repAuth.email,
              name: repName,
              role: 'sales',
            },
            productHint: String(payload?.QUERY_PRODUCT_NAME || rawNotes || '').trim(),
          })
          .catch(() => {});
      }
    }

    return {
      status: 'created' as const,
      assignedRepName: repName,
      strategyUsed,
      routingReason,
      lead: created,
    };
  }

  async autoAssignLead(auth: AuthContext, id: string) {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Lead not found.');
    }
    if (!this.leadRoutingService) {
      throw new BadRequestException('Lead routing engine is unavailable.');
    }
    const ownerScope = await resolveOwnerScopeFilter(this.leadModel.db, auth);
    const doc = await this.leadModel
      .findOne({
        _id: new Types.ObjectId(id),
        tenantId: new Types.ObjectId(auth.tenantId),
        ...ownerScope,
      })
      .exec();
    if (!doc) {
      throw new NotFoundException('Lead not found.');
    }

    const routed = await this.leadRoutingService.resolveAssigneeForLead(
      auth.tenantId,
      {
        city: doc.city,
        source: doc.source,
        estimatedValue: doc.estimatedValue,
        leadId: doc._id.toString(),
        leadName: doc.name,
        commit: true,
      },
    );

    doc.ownerId = new Types.ObjectId(routed.assignedUserId);
    doc.activities = [
      {
        id: randomBytes(6).toString('hex'),
        type: 'note',
        description: `Smart Routing assigned lead to ${routed.assignedUserName} · ${routed.reason}`,
        authorName: auth.email.split('@')[0],
        createdAt: new Date().toISOString(),
      },
      ...(doc.activities || []),
    ];
    await doc.save();

    await this.auditService?.record({
      tenantId: auth.tenantId,
      actorId: auth.userId,
      actorEmail: auth.email,
      action: 'lead.auto_assigned',
      entityType: 'lead',
      entityId: doc._id.toString(),
      entityLabel: doc.name,
      summary: `Auto-assigned ${doc.name} -> ${routed.assignedUserName} (${routed.strategyUsed})`,
    });

    const maskPhones = this.auditService
      ? await this.auditService.shouldMaskViewerPhones(auth.tenantId, auth.userId)
      : false;

    return {
      routing: routed,
      lead: this.toDto(doc, maskPhones),
    };
  }

  private async buildGstinProfileForTenant(
    tenantId: string,
    gstin: string,
    company?: string,
    city?: string,
    phone?: string,
  ): Promise<LeadGstinProfile> {
    let overdueInvoicesCount = 0;
    let overdueAmountInr = 0;
    try {
      const tenantObjectId = new Types.ObjectId(tenantId);
      const orClauses: Record<string, unknown>[] = [];
      const cleanGstin = gstin.trim().toUpperCase();
      if (cleanGstin) orClauses.push({ clientGstin: cleanGstin });
      if (company?.trim()) {
        orClauses.push({
          clientName: {
            $regex: company.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
            $options: 'i',
          },
        });
      }
      const digits = this.last10Digits(phone);
      if (digits.length === 10) {
        orClauses.push({ phone: { $regex: `${digits.slice(0, 5)}\\D*${digits.slice(5)}$` } });
      }
      if (orClauses.length > 0) {
        const overdueDocs = await this.leadModel.db
          .collection('invoices')
          .find({
            tenantId: tenantObjectId,
            $or: orClauses,
            status: { $in: ['overdue', 'partial', 'unpaid'] },
          })
          .limit(10)
          .toArray();
        const now = Date.now();
        for (const inv of overdueDocs) {
          const bal = Number(inv.balanceDue ?? inv.grandTotal ?? 0);
          const isOverdue =
            String(inv.status) === 'overdue' ||
            (inv.dueDate && new Date(String(inv.dueDate)).getTime() < now);
          if (isOverdue && bal > 0) {
            overdueInvoicesCount += 1;
            overdueAmountInr += bal;
          }
        }
      }
    } catch {
      // ignore optional invoice exposure check
    }

    const effGstin = await resolveEffectiveGstinProviderConfig(
      this.leadModel.db,
      this.configService,
    );

    return evaluateGstinTrustProfile({
      gstin,
      company,
      city,
      overdueInvoicesCount,
      overdueAmountInr,
      liveApiUrl: effGstin.isLiveConfigured ? effGstin.apiUrlTemplate : undefined,
      liveApiKey: effGstin.isLiveConfigured ? effGstin.apiKey : undefined,
    });
  }

  async verifyGstinPreview(
    auth: AuthContext,
    payload: { gstin: string; company?: string; city?: string; phone?: string },
  ): Promise<LeadGstinProfile> {
    await this.superAdminService?.assertFeatureEnabled(auth.tenantId, 'gstinTrustGuard');
    if (!payload.gstin?.trim()) {
      throw new BadRequestException('GSTIN is required for verification.');
    }
    return this.buildGstinProfileForTenant(
      auth.tenantId,
      payload.gstin,
      payload.company,
      payload.city,
      payload.phone,
    );
  }

  async verifyLeadGstin(
    auth: AuthContext,
    id: string,
    payload?: { gstin?: string },
  ) {
    await this.superAdminService?.assertFeatureEnabled(auth.tenantId, 'gstinTrustGuard');
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Lead not found.');
    }
    const ownerScope = await resolveOwnerScopeFilter(this.leadModel.db, auth);
    const doc = await this.leadModel
      .findOne({
        _id: new Types.ObjectId(id),
        tenantId: new Types.ObjectId(auth.tenantId),
        ...ownerScope,
      })
      .exec();
    if (!doc) {
      throw new NotFoundException('Lead not found.');
    }

    const targetGstin = (payload?.gstin ?? doc.gstin ?? '').trim().toUpperCase();
    if (!targetGstin) {
      throw new BadRequestException(
        'Enter a 15-character buyer GSTIN before verifying.',
      );
    }

    const profile = await this.buildGstinProfileForTenant(
      auth.tenantId,
      targetGstin,
      doc.company,
      doc.city,
      doc.phone,
    );
    doc.gstin = profile.gstin;
    doc.gstinProfile = profile;
    if (profile.checksumValid && profile.trustScore >= 75 && doc.aiScore < 85) {
      doc.aiScore = Math.min(99, Math.max(doc.aiScore || 70, doc.aiScore + 8));
      doc.aiLabel = doc.aiScore >= 80 ? 'Hot' : doc.aiScore >= 58 ? 'Warm' : 'Cold';
    }
    doc.activities = [
      {
        id: randomBytes(6).toString('hex'),
        type: 'ai_score',
        description: `GSTIN Trust Check (${profile.gstin}): ${profile.status} · Score ${profile.trustScore}/100 · ${profile.entityType || 'Business'} (${profile.stateName || 'India'}). ${profile.creditAdvice}`,
        authorName: auth.email.split('@')[0],
        createdAt: new Date().toISOString(),
      },
      ...(doc.activities || []),
    ];
    doc.markModified('gstinProfile');
    await doc.save();

    const maskPhones = this.auditService
      ? await this.auditService.shouldMaskViewerPhones(auth.tenantId, auth.userId)
      : false;

    return {
      profile,
      lead: this.toDto(doc, maskPhones),
    };
  }
}
