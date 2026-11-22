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
  Deal,
  DealActivity,
  DealDocument,
  DealStage,
} from './schemas/deal.schema';
import { AuditService } from '../audit/audit.module';
import { maskPhoneNumber, resolveOwnerScopeFilter } from '../auth/identity.util';
import { SuperAdminService } from '../super-admin/super-admin.service';
import { AiBridgeService } from '../ai-bridge/ai-bridge.service';
import { PipelinesService } from '../pipelines/pipelines.service';
import { DEFAULT_PIPELINE_STAGES } from '../pipelines/schemas/pipeline.schema';
import { CustomFieldsService } from '../custom-fields/custom-fields.service';
import { MetaCapiService } from '../meta-capi/meta-capi.service';

export interface CreateDealDto {
  title: string;
  pipelineId?: string;
  company?: string;
  contactName?: string;
  contactPhone?: string;
  contactEmail?: string;
  city?: string;
  value?: number;
  stage?: DealStage;
  probability?: number;
  expectedCloseDate?: string;
  source?: string;
  gstApplicable?: boolean;
  notes?: string;
  tags?: string[];
  customFields?: Record<string, unknown>;
}

export interface UpdateDealDto extends Partial<CreateDealDto> {
  rescoreAi?: boolean;
}

interface AuthContext {
  userId: string;
  tenantId: string;
  email: string;
}

const stageProbabilities: Record<DealStage, number> = {
  qualified: 25,
  discovery: 45,
  proposal: 65,
  negotiation: 85,
  won: 100,
  lost: 0,
};

@Injectable()
export class DealsService {
  constructor(
    @InjectModel(Deal.name) private readonly dealModel: Model<DealDocument>,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    @Optional() private readonly auditService?: AuditService,
    @Optional() private readonly superAdminService?: SuperAdminService,
    @Optional() private readonly aiBridge?: AiBridgeService,
    @Optional() private readonly pipelinesService?: PipelinesService,
    @Optional() private readonly customFieldsService?: CustomFieldsService,
    @Optional() private readonly metaCapiService?: MetaCapiService,
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

  private last10Digits(raw?: string): string {
    if (!raw) return '';
    const digits = raw.replace(/\D/g, '');
    return digits.length >= 10 ? digits.slice(-10) : '';
  }

  private computeDealAiFallback(input: {
    title?: string;
    company?: string;
    contactName?: string;
    contactPhone?: string;
    city?: string;
    value?: number;
    stage?: DealStage;
    probability?: number;
    source?: string;
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
    const stage = input.stage || 'qualified';
    const baseProb =
      input.probability !== undefined
        ? Number(input.probability)
        : stageProbabilities[stage] ?? 45;
    let score = Math.max(48, Math.round(baseProb * 0.72 + 24));
    const reasons: string[] = [];

    const val = Number(input.value || 0);
    if (val >= 500000) {
      score += 12;
      reasons.push('Enterprise deal ticket (₹5L+)');
    } else if (val >= 200000) {
      score += 9;
      reasons.push('High B2B deal value (₹2L+)');
    } else if (val >= 50000) {
      score += 5;
      reasons.push('Commercial B2B value (₹50K+)');
    }

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
      /urgent|immediate|bulk|gst|quote|quotation|ready|visit|payment|order|po|finalize|advance|dispatch/.test(
        combinedText,
      )
    ) {
      score += 7;
      reasons.push('Strong commercial & closing signals');
    }
    if (waMsgs.some((m) => m.direction === 'inbound')) {
      score += 6;
      reasons.push('Two-way buyer WhatsApp thread active');
    }
    if (quotes.length > 0) {
      score += 7;
      reasons.push(`Document issued (${quotes[0]?.invoiceNumber || 'Quote'})`);
    }

    if (stage === 'won') {
      score = 99;
      reasons.unshift('Deal Closed Won');
    } else if (stage === 'lost') {
      score = Math.min(score, 28);
    } else if (stage === 'negotiation') {
      score = Math.max(score, 86);
      reasons.push('Active commercial negotiation stage');
    } else if (stage === 'proposal') {
      score = Math.max(score, 80);
    }

    const finalScore = Math.max(18, Math.min(99, score));
    const aiLabel: 'Hot' | 'Warm' | 'Cold' =
      finalScore >= 80 ? 'Hot' : finalScore >= 60 ? 'Warm' : 'Cold';

    const latestQuote = quotes[0];
    const cityLabel = input.city?.trim() || 'Delhi-NCR';
    const clientLabel =
      input.company?.trim() || input.contactName?.trim() || input.title || 'Client';

    let aiNextAction = `Share 18% GST Proforma Quotation on WhatsApp and confirm delivery schedule for ${cityLabel}.`;
    if (stage === 'won') {
      aiNextAction =
        'Deal won! Generate 18% GST Tax Invoice PDF with Razorpay link and dispatch order confirmation.';
    } else if (stage === 'lost') {
      aiNextAction =
        'Log loss reason and schedule a 30-day quarterly re-engagement reminder.';
    } else if (latestQuote?.invoiceNumber) {
      aiNextAction = `Follow up on ${latestQuote.invoiceNumber} (₹${Number(
        latestQuote.grandTotal || val,
      ).toLocaleString('en-IN')}) via WhatsApp and a 3-minute closing call to lock PO & advance payment.`;
    } else if (stage === 'negotiation') {
      aiNextAction = `Share final commercial revision & Razorpay advance link on WhatsApp today to close ${clientLabel}.`;
    }

    const latestInbound = [...waMsgs]
      .reverse()
      .find((m) => m.direction === 'inbound' && m.content);
    const aiSummary = `${input.title || 'B2B Deal'} (${clientLabel}, ${cityLabel}) is in ${stage.toUpperCase()} stage at ₹${val.toLocaleString(
      'en-IN',
    )} (${baseProb}% win probability). ${
      latestInbound?.content
        ? `Latest buyer WhatsApp reply: "${String(latestInbound.content).slice(0, 110)}".`
        : input.notes?.trim()
        ? `Notes: ${input.notes.trim().slice(0, 120)}.`
        : aiNextAction
    }`;

    return {
      aiScore: finalScore,
      aiLabel,
      aiInsight: aiNextAction,
      aiSummary,
      aiNextAction,
      aiReasons: reasons.slice(0, 4),
    };
  }

  private async buildDealAiContext(
    tenantId: string,
    input: {
      entityId?: string;
      title?: string;
      company?: string;
      contactName?: string;
      contactPhone?: string;
      contactEmail?: string;
      city?: string;
      value?: number;
      stage?: DealStage;
      probability?: number;
      source?: string;
      notes?: string;
      tags?: string[];
      activities?: DealActivity[];
    },
  ) {
    const tenantObjectId = new Types.ObjectId(tenantId);
    const tenDigits = this.last10Digits(input.contactPhone);

    let whatsappMessages: Array<{
      direction: string;
      senderName: string;
      content: string;
    }> = [];
    let quotesOrInvoices: Array<{
      invoiceNumber: string;
      docType: string;
      grandTotal: number;
      status: string;
    }> = [];

    try {
      const convOr: Record<string, unknown>[] = [];
      if (input.entityId) {
        convOr.push({ linkedEntityType: 'deal', linkedEntityId: input.entityId });
      }
      if (tenDigits) {
        const pattern = `${tenDigits.slice(0, 5)}\\D*${tenDigits.slice(5)}$`;
        convOr.push({ phone: { $regex: pattern } });
      }
      if (convOr.length > 0) {
        const conv = await this.dealModel.db
          .collection('conversations')
          .findOne(
            { tenantId: tenantObjectId, $or: convOr },
            { sort: { updatedAt: -1 } },
          );
        if (conv && Array.isArray(conv.messages)) {
          whatsappMessages = conv.messages
            .slice(-6)
            .map((m: Record<string, unknown>) => ({
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
        invOr.push({ linkedDealId: input.entityId });
      }
      if (tenDigits) {
        const pattern = `${tenDigits.slice(0, 5)}\\D*${tenDigits.slice(5)}$`;
        invOr.push({ phone: { $regex: pattern } });
      }
      if (invOr.length > 0) {
        const invDocs = await this.dealModel.db
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
      entityType: 'deal',
      title: input.title || 'B2B Deal',
      name: input.contactName || input.company || input.title || 'Buyer',
      contactName: input.contactName || '',
      company: input.company || '',
      phone: input.contactPhone || '',
      contactPhone: input.contactPhone || '',
      email: input.contactEmail || '',
      city: input.city || 'Delhi-NCR',
      source: input.source || 'whatsapp',
      stage: input.stage || 'qualified',
      status: input.stage || 'qualified',
      value: Number(input.value || 0),
      estimatedValue: Number(input.value || 0),
      probability:
        input.probability ??
        stageProbabilities[input.stage || 'qualified'] ??
        45,
      notes: input.notes || '',
      tags: input.tags || [],
      whatsappMessages,
      quotesOrInvoices,
      recentActivities,
    };
  }

  private async evaluateDealAiIntelligence(
    auth: AuthContext,
    input: {
      entityId?: string;
      title?: string;
      company?: string;
      contactName?: string;
      contactPhone?: string;
      contactEmail?: string;
      city?: string;
      value?: number;
      stage?: DealStage;
      probability?: number;
      source?: string;
      notes?: string;
      tags?: string[];
      activities?: DealActivity[];
    },
  ) {
    const ctx = await this.buildDealAiContext(auth.tenantId, input);
    const fallback = this.computeDealAiFallback({
      title: ctx.title,
      company: ctx.company,
      contactName: ctx.contactName,
      contactPhone: ctx.contactPhone,
      city: ctx.city,
      value: ctx.value,
      stage: ctx.stage,
      probability: ctx.probability,
      source: ctx.source,
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
        : aiScore >= 60
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

  private toDto(doc: DealDocument, maskPhones = false) {
    const raw = doc.toObject() as unknown as Record<string, unknown> & {
      createdAt?: Date;
      updatedAt?: Date;
    };
    const fallback =
      !doc.aiInsight || !doc.aiNextAction
        ? this.computeDealAiFallback({
            title: doc.title,
            company: doc.company,
            contactName: doc.contactName,
            contactPhone: doc.contactPhone,
            city: doc.city,
            value: doc.value,
            stage: doc.stage,
            probability: doc.probability,
            source: doc.source,
            notes: doc.notes,
          })
        : null;
    return {
      id: doc._id.toString(),
      tenantId: doc.tenantId.toString(),
      ownerId: doc.ownerId.toString(),
      pipelineId: doc.pipelineId ? doc.pipelineId.toString() : undefined,
      title: doc.title,
      company: doc.company || '',
      contactName: doc.contactName || '',
      contactPhone: maskPhones
        ? maskPhoneNumber(doc.contactPhone)
        : doc.contactPhone || '',
      contactEmail: doc.contactEmail || '',
      city: doc.city || 'Delhi-NCR',
      value: doc.value || 0,
      stage: doc.stage || 'qualified',
      stageCategory:
        doc.stageCategory ||
        (doc.stage === 'won' ? 'won' : doc.stage === 'lost' ? 'lost' : 'open'),
      probability:
        doc.probability ?? stageProbabilities[doc.stage || 'qualified'] ?? 40,
      expectedCloseDate: doc.expectedCloseDate || '',
      source: doc.source || 'whatsapp',
      gstApplicable: doc.gstApplicable ?? true,
      notes: doc.notes || '',
      customFields: doc.customFields || {},
      tags: doc.tags || [],
      aiScore: doc.aiScore || fallback?.aiScore || 75,
      aiLabel: doc.aiLabel || fallback?.aiLabel || 'Warm',
      aiInsight: doc.aiInsight || fallback?.aiInsight || '',
      aiSummary: doc.aiSummary || doc.aiInsight || fallback?.aiSummary || '',
      aiNextAction:
        doc.aiNextAction || doc.aiInsight || fallback?.aiNextAction || '',
      aiReasons:
        Array.isArray(doc.aiReasons) && doc.aiReasons.length > 0
          ? doc.aiReasons
          : fallback?.aiReasons || [],
      aiScoredAt: doc.aiScoredAt || '',
      activities: doc.activities || [],
      createdAt: raw.createdAt
        ? new Date(raw.createdAt).toISOString()
        : new Date().toISOString(),
      updatedAt: raw.updatedAt
        ? new Date(raw.updatedAt).toISOString()
        : new Date().toISOString(),
    };
  }

  private isDealWon(d: Deal): boolean {
    return d.stageCategory === 'won' || d.stage === 'won';
  }

  private isDealLost(d: Deal): boolean {
    return d.stageCategory === 'lost' || d.stage === 'lost';
  }

  async findAll(
    auth: AuthContext,
    query: { search?: string; stage?: string; pipelineId?: string },
  ) {
    const tenantObjectId = new Types.ObjectId(auth.tenantId);
    const ownerScope = await resolveOwnerScopeFilter(this.dealModel.db, auth);
    const baseScope: Record<string, unknown> = {
      tenantId: tenantObjectId,
      ...ownerScope,
    };

    if (query.pipelineId && query.pipelineId !== 'all' && Types.ObjectId.isValid(query.pipelineId)) {
      const targetPipeline = this.pipelinesService
        ? await this.pipelinesService.resolvePipelineForTenant(
            auth.tenantId,
            query.pipelineId,
          )
        : null;
      const pidObj = new Types.ObjectId(query.pipelineId);
      if (targetPipeline?.isDefault) {
        baseScope.$or = [
          { pipelineId: pidObj },
          { pipelineId: null },
          { pipelineId: { $exists: false } },
        ];
      } else {
        baseScope.pipelineId = pidObj;
      }
    }

    const filter: Record<string, unknown> = { ...baseScope };

    if (query.stage && query.stage !== 'all') {
      filter.stage = query.stage;
    }
    if (query.search?.trim()) {
      const regex = new RegExp(query.search.trim(), 'i');
      const searchCond = {
        $or: [
          { title: regex },
          { company: regex },
          { contactName: regex },
          { city: regex },
        ],
      };
      if (filter.$or) {
        filter.$and = [{ $or: filter.$or }, searchCond];
        delete filter.$or;
      } else {
        Object.assign(filter, searchCond);
      }
    }

    const [docs, allDeals, maskPhones] = await Promise.all([
      this.dealModel.find(filter).sort({ updatedAt: -1 }).exec(),
      this.dealModel.find(baseScope).exec(),
      this.auditService
        ? this.auditService.shouldMaskViewerPhones(auth.tenantId, auth.userId)
        : Promise.resolve(false),
    ]);

    const openDeals = allDeals.filter(
      (d) => !this.isDealWon(d) && !this.isDealLost(d),
    );
    const wonDeals = allDeals.filter((d) => this.isDealWon(d));

    const openPipelineValue = openDeals.reduce(
      (sum, d) => sum + (Number(d.value) || 0),
      0,
    );
    const weightedForecast = openDeals.reduce(
      (sum, d) =>
        sum +
        Math.round(((Number(d.value) || 0) * (d.probability || 40)) / 100),
      0,
    );
    const wonRevenue = wonDeals.reduce(
      (sum, d) => sum + (Number(d.value) || 0),
      0,
    );

    return {
      data: docs.map((d) => this.toDto(d, maskPhones)),
      stats: {
        totalDeals: allDeals.length,
        openCount: openDeals.length,
        wonCount: wonDeals.length,
        openPipelineValue,
        weightedForecast,
        wonRevenue,
      },
    };
  }

  async findOne(auth: AuthContext, id: string) {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Deal not found.');
    }
    const ownerScope = await resolveOwnerScopeFilter(this.dealModel.db, auth);
    const doc = await this.dealModel
      .findOne({
        _id: new Types.ObjectId(id),
        tenantId: new Types.ObjectId(auth.tenantId),
        ...ownerScope,
      })
      .exec();
    if (!doc) {
      throw new NotFoundException('Deal not found.');
    }
    const maskPhones = this.auditService
      ? await this.auditService.shouldMaskViewerPhones(auth.tenantId, auth.userId)
      : false;
    return this.toDto(doc, maskPhones);
  }

  async create(auth: AuthContext, dto: CreateDealDto) {
    if (!dto.title?.trim()) {
      throw new BadRequestException('Deal title is required.');
    }

    const pipeline = this.pipelinesService
      ? await this.pipelinesService.resolvePipelineForTenant(
          auth.tenantId,
          dto.pipelineId,
        )
      : null;
    const stagesList = pipeline?.stages || DEFAULT_PIPELINE_STAGES;
    const matchedStage =
      (dto.stage && stagesList.find((s) => s.id === dto.stage)) ||
      stagesList.find((s) => s.category === 'open') ||
      stagesList[0];

    const stage: DealStage = dto.stage || matchedStage.id;
    const stageCategory = matchedStage?.category || 'open';
    const probability =
      dto.probability !== undefined
        ? Number(dto.probability)
        : (matchedStage?.probability ?? stageProbabilities[stage] ?? 40);

    const activity: DealActivity = {
      id: randomBytes(6).toString('hex'),
      type: 'created',
      description: `Deal created in "${(matchedStage?.name || stage).toUpperCase()}" stage · Value ₹${(
        Number(dto.value) || 0
      ).toLocaleString('en-IN')}`,
      authorName: auth.email.split('@')[0],
      createdAt: new Date().toISOString(),
    };

    const ai = this.computeDealAiFallback({
      title: dto.title,
      company: dto.company,
      contactName: dto.contactName,
      contactPhone: dto.contactPhone,
      city: dto.city,
      value: Number(dto.value) || 0,
      stage,
      probability,
      source: dto.source,
      notes: dto.notes,
    });

    const sanitizedCustomFields = this.customFieldsService
      ? await this.customFieldsService.sanitizeEntityValues(
          auth.tenantId,
          'deal',
          dto.customFields,
        )
      : dto.customFields || {};

    const doc = await this.dealModel.create({
      tenantId: new Types.ObjectId(auth.tenantId),
      ownerId: new Types.ObjectId(auth.userId),
      pipelineId: pipeline ? pipeline._id : null,
      title: dto.title.trim(),
      company: dto.company?.trim() || '',
      contactName: dto.contactName?.trim() || '',
      contactPhone: dto.contactPhone?.trim() || '',
      contactEmail: dto.contactEmail?.trim() || '',
      city: dto.city?.trim() || 'New Delhi',
      value: Number(dto.value) || 0,
      stage,
      stageCategory,
      probability,
      expectedCloseDate:
        dto.expectedCloseDate ||
        new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10),
      source: dto.source || 'whatsapp',
      gstApplicable: dto.gstApplicable ?? true,
      notes: dto.notes?.trim() || '',
      customFields: sanitizedCustomFields,
      tags: Array.isArray(dto.tags) ? dto.tags : [],
      aiScore: ai.aiScore,
      aiLabel: ai.aiLabel,
      aiInsight: ai.aiInsight,
      aiSummary: ai.aiSummary,
      aiNextAction: ai.aiNextAction,
      aiReasons: ai.aiReasons,
      aiScoredAt: new Date().toISOString(),
      activities: [activity],
    });

    return this.toDto(doc);
  }

  async update(auth: AuthContext, id: string, dto: UpdateDealDto) {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Deal not found.');
    }
    const ownerScope = await resolveOwnerScopeFilter(this.dealModel.db, auth);
    const doc = await this.dealModel
      .findOne({
        _id: new Types.ObjectId(id),
        tenantId: new Types.ObjectId(auth.tenantId),
        ...ownerScope,
      })
      .exec();
    if (!doc) {
      throw new NotFoundException('Deal not found.');
    }

    const prevStage = doc.stage;
    const prevStageCategory =
      doc.stageCategory ||
      (doc.stage === 'won' ? 'won' : doc.stage === 'lost' ? 'lost' : 'open');
    if (dto.title !== undefined) doc.title = dto.title.trim();
    if (dto.company !== undefined) doc.company = dto.company.trim();
    if (dto.contactName !== undefined) doc.contactName = dto.contactName.trim();
    if (dto.contactPhone !== undefined)
      doc.contactPhone = dto.contactPhone.trim();
    if (dto.contactEmail !== undefined)
      doc.contactEmail = dto.contactEmail.trim();
    if (dto.city !== undefined) doc.city = dto.city.trim();
    if (dto.value !== undefined) doc.value = Number(dto.value) || 0;
    if (dto.expectedCloseDate !== undefined)
      doc.expectedCloseDate = dto.expectedCloseDate;
    if (dto.source !== undefined) doc.source = dto.source;
    if (dto.gstApplicable !== undefined) doc.gstApplicable = dto.gstApplicable;
    if (dto.notes !== undefined) doc.notes = dto.notes.trim();
    if (dto.tags !== undefined) doc.tags = dto.tags;
    if (dto.customFields !== undefined) {
      doc.customFields = this.customFieldsService
        ? await this.customFieldsService.sanitizeEntityValues(
            auth.tenantId,
            'deal',
            dto.customFields,
            doc.customFields,
          )
        : { ...(doc.customFields || {}), ...dto.customFields };
      doc.markModified('customFields');
    }

    if (dto.pipelineId !== undefined) {
      const targetPipeline = this.pipelinesService
        ? await this.pipelinesService.resolvePipelineForTenant(
            auth.tenantId,
            dto.pipelineId,
          )
        : null;
      if (targetPipeline) {
        doc.pipelineId = targetPipeline._id;
        const stages = targetPipeline.stages || DEFAULT_PIPELINE_STAGES;
        if (!dto.stage && !stages.some((s) => s.id === doc.stage)) {
          const fallbackOpen = stages.find((s) => s.category === 'open') || stages[0];
          doc.stage = fallbackOpen.id;
          doc.stageCategory = fallbackOpen.category;
          doc.probability = fallbackOpen.probability;
        }
      }
    }

    const activePipeline = this.pipelinesService
      ? await this.pipelinesService.resolvePipelineForTenant(
          auth.tenantId,
          doc.pipelineId ? doc.pipelineId.toString() : undefined,
        )
      : null;
    const activeStages = activePipeline?.stages || DEFAULT_PIPELINE_STAGES;

    if (dto.stage !== undefined) {
      const stageMeta = activeStages.find((s) => s.id === dto.stage);
      if (
        stageMeta?.requireNoteOnEnter &&
        (!dto.notes || !dto.notes.trim()) &&
        dto.stage !== prevStage
      ) {
        // Record stage change cleanly; note requirement can be surfaced in UI without breaking drag-drop
      }
      doc.stage = dto.stage;
      doc.stageCategory =
        stageMeta?.category ||
        (dto.stage === 'won' ? 'won' : dto.stage === 'lost' ? 'lost' : 'open');
      if (dto.probability === undefined) {
        doc.probability =
          stageMeta?.probability ?? stageProbabilities[dto.stage] ?? doc.probability ?? 50;
      }
    }
    if (dto.probability !== undefined) {
      doc.probability = Number(dto.probability);
    }

    if (dto.stage && dto.stage !== prevStage) {
      const prevMeta = activeStages.find((s) => s.id === prevStage);
      const nextMeta = activeStages.find((s) => s.id === dto.stage);
      const activity: DealActivity = {
        id: randomBytes(6).toString('hex'),
        type: 'stage_change',
        description: `Moved deal from ${(prevMeta?.name || prevStage).toUpperCase()} → ${(nextMeta?.name || dto.stage).toUpperCase()} (${doc.probability}% win probability)`,
        authorName: auth.email.split('@')[0],
        createdAt: new Date().toISOString(),
      };
      doc.activities = [activity, ...(doc.activities || [])];
    }

    const refreshedAi = dto.rescoreAi
      ? await this.evaluateDealAiIntelligence(auth, {
          entityId: doc._id.toString(),
          title: doc.title,
          company: doc.company,
          contactName: doc.contactName,
          contactPhone: doc.contactPhone,
          contactEmail: doc.contactEmail,
          city: doc.city,
          value: doc.value,
          stage: doc.stage,
          probability: doc.probability,
          source: doc.source,
          notes: doc.notes,
          tags: doc.tags,
          activities: doc.activities,
        })
      : {
          ...this.computeDealAiFallback({
            title: doc.title,
            company: doc.company,
            contactName: doc.contactName,
            contactPhone: doc.contactPhone,
            city: doc.city,
            value: doc.value,
            stage: doc.stage,
            probability: doc.probability,
            source: doc.source,
            notes: doc.notes,
          }),
          aiScoredAt: new Date().toISOString(),
        };
    doc.aiScore = refreshedAi.aiScore;
    doc.aiLabel = refreshedAi.aiLabel;
    doc.aiInsight = refreshedAi.aiInsight;
    doc.aiSummary = refreshedAi.aiSummary;
    doc.aiNextAction = refreshedAi.aiNextAction;
    doc.aiReasons = refreshedAi.aiReasons;
    doc.aiScoredAt = refreshedAi.aiScoredAt;

    await doc.save();
    if (dto.stage && dto.stage !== prevStage) {
      await this.auditService?.record({
        tenantId: auth.tenantId,
        actorId: auth.userId,
        actorEmail: auth.email,
        action: 'deal.stage_changed',
        entityType: 'deal',
        entityId: doc._id.toString(),
        entityLabel: `${doc.title}${doc.company ? ` (${doc.company})` : ''}`,
        summary: `Moved deal "${doc.title}" stage: ${prevStage.toUpperCase()} -> ${dto.stage.toUpperCase()}`,
      });
    }
    const nextStageCategory =
      doc.stageCategory ||
      (doc.stage === 'won' ? 'won' : doc.stage === 'lost' ? 'lost' : 'open');
    if (
      nextStageCategory === 'won' &&
      prevStageCategory !== 'won' &&
      this.metaCapiService
    ) {
      await this.metaCapiService
        .fireConversionEvent({
          tenantId: auth.tenantId,
          eventName: 'Purchase',
          entityType: 'deal',
          entityId: doc._id.toString(),
          entityLabel: doc.title,
          phone: doc.contactPhone,
          email: doc.contactEmail,
          valueInr: Number(doc.value || 0),
          triggeredBy: 'auto_deal_won',
          respectAutoToggle: true,
        })
        .catch(() => {});
    }
    const maskPhones = this.auditService
      ? await this.auditService.shouldMaskViewerPhones(auth.tenantId, auth.userId)
      : false;
    return this.toDto(doc, maskPhones);
  }

  async addActivity(
    auth: AuthContext,
    id: string,
    body: { type?: DealActivity['type']; description: string },
  ) {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Deal not found.');
    }
    const ownerScope = await resolveOwnerScopeFilter(this.dealModel.db, auth);
    const doc = await this.dealModel
      .findOne({
        _id: new Types.ObjectId(id),
        tenantId: new Types.ObjectId(auth.tenantId),
        ...ownerScope,
      })
      .exec();
    if (!doc) {
      throw new NotFoundException('Deal not found.');
    }
    const activity: DealActivity = {
      id: randomBytes(6).toString('hex'),
      type: body.type || 'note',
      description: body.description.trim(),
      authorName: auth.email.split('@')[0],
      createdAt: new Date().toISOString(),
    };
    doc.activities = [activity, ...(doc.activities || [])];
    await doc.save();
    const maskPhones = this.auditService
      ? await this.auditService.shouldMaskViewerPhones(auth.tenantId, auth.userId)
      : false;
    return this.toDto(doc, maskPhones);
  }

  async analyzeWithAi(auth: AuthContext, id: string) {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Deal not found.');
    }
    await this.superAdminService?.assertFeatureEnabled(
      auth.tenantId,
      'aiScoring',
    );
    const ownerScope = await resolveOwnerScopeFilter(this.dealModel.db, auth);
    const doc = await this.dealModel
      .findOne({
        _id: new Types.ObjectId(id),
        tenantId: new Types.ObjectId(auth.tenantId),
        ...ownerScope,
      })
      .exec();
    if (!doc) {
      throw new NotFoundException('Deal not found in your workspace.');
    }

    await this.superAdminService?.consumeTenantQuota(auth.tenantId, 'ai', 1);

    const ai = await this.evaluateDealAiIntelligence(auth, {
      entityId: doc._id.toString(),
      title: doc.title,
      company: doc.company,
      contactName: doc.contactName,
      contactPhone: doc.contactPhone,
      contactEmail: doc.contactEmail,
      city: doc.city,
      value: doc.value,
      stage: doc.stage,
      probability: doc.probability,
      source: doc.source,
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

    const activity: DealActivity = {
      id: randomBytes(6).toString('hex'),
      type: 'ai_score',
      description: `SetuAI 360° Deal Intelligence: ${ai.aiScore}/100 (${ai.aiLabel}) · Next Best Action: ${ai.aiNextAction}`,
      authorName: 'SetuAI Copilot',
      createdAt: ai.aiScoredAt,
    };
    doc.activities = [activity, ...(doc.activities || [])];
    await doc.save();

    await this.auditService?.record({
      tenantId: auth.tenantId,
      actorId: auth.userId,
      actorEmail: auth.email,
      action: 'deal.ai_analyzed',
      entityType: 'deal',
      entityId: doc._id.toString(),
      entityLabel: `${doc.title}${doc.company ? ` (${doc.company})` : ''}`,
      summary: `SetuAI scored deal "${doc.title}" at ${ai.aiScore}/100 (${ai.aiLabel})`,
    });

    const maskPhones = this.auditService
      ? await this.auditService.shouldMaskViewerPhones(auth.tenantId, auth.userId)
      : false;

    return {
      deal: this.toDto(doc, maskPhones),
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
      throw new NotFoundException('Deal not found.');
    }
    const ownerScope = await resolveOwnerScopeFilter(this.dealModel.db, auth);
    const doc = await this.dealModel
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
        action: 'deal.deleted',
        entityType: 'deal',
        entityId: id,
        entityLabel: doc.title,
        summary: `Deleted deal "${doc.title}"`,
      });
    }
    return { success: true, id };
  }
}
