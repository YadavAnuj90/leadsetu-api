import {
  ForbiddenException,
  Injectable,
  Logger,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { timingSafeEqual } from 'crypto';
import axios from 'axios';
import { Tenant, TenantDocument } from '../auth/schemas/tenant.schema';
import { User, UserDocument } from '../auth/schemas/user.schema';
import { resolveOwnerScopeFilter } from '../auth/identity.util';
import { SuperAdminService } from '../super-admin/super-admin.service';
import type { FeatureKey } from '../super-admin/schemas/platform-config.schema';

export interface AiGatewayResponse<T = Record<string, unknown>> {
  requestId: string;
  task: string;
  result: string;
  structured?: T;
  sources?: Array<{ entityType: string; entityId: string; excerpt: string }>;
  model: string;
  provider?: string;
  tokensUsed: number;
  durationMs: number;
}

@Injectable()
export class AiBridgeService {
  private readonly logger = new Logger(AiBridgeService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly jwtService: JwtService,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(Tenant.name)
    private readonly tenantModel: Model<TenantDocument>,
    @Optional() private readonly superAdminService?: SuperAdminService,
  ) {}

  private getAiUrl(): string {
    return (
      this.configService.get<string>('AI_SERVICE_URL') ||
      'http://localhost:3002'
    ).replace(/\/+$/, '');
  }

  private getInternalSecret(): string {
    return (
      this.configService.get<string>('AI_INTERNAL_SECRET') ||
      this.configService.get<string>('INTERNAL_API_SECRET') ||
      ''
    ).trim();
  }

  verifyInternalSecret(provided?: string): boolean {
    const expected = this.getInternalSecret();
    if (!expected || !provided) return false;
    const a = Buffer.from(provided.trim());
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  async checkInternalPermission(input: {
    tenantId?: string;
    userId?: string;
    task?: string;
  }): Promise<{ allowed: boolean; reason?: string }> {
    const tenantId = input.tenantId?.trim();
    const userId = input.userId?.trim();

    if (tenantId && Types.ObjectId.isValid(tenantId)) {
      const tenant = await this.tenantModel
        .findById(tenantId)
        .select('status')
        .lean();
      if (!tenant) {
        return { allowed: false, reason: 'Workspace tenant not found.' };
      }
      if (tenant.status === 'suspended') {
        return { allowed: false, reason: 'Workspace account is suspended.' };
      }
    }

    if (userId && Types.ObjectId.isValid(userId)) {
      const user = await this.userModel
        .findById(userId)
        .select('isActive role featureAccess')
        .lean();
      if (!user) {
        return { allowed: false, reason: 'User account not found.' };
      }
      if (!user.isActive) {
        return { allowed: false, reason: 'User account is inactive.' };
      }
      if (input.task === 'workflow_draft' && user.role === 'agent') {
        return {
          allowed: false,
          reason: `Role '${user.role}' cannot generate workflows.`,
        };
      }
      if (user.featureAccess && user.featureAccess['ai'] === false) {
        return {
          allowed: false,
          reason: 'AI features are disabled for this user by workspace admin.',
        };
      }
    }

    return { allowed: true };
  }

  async verifyAuth(authHeader?: string): Promise<{
    userId: string;
    tenantId: string;
    email: string;
    role?: string;
  }> {
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
        role?: string;
      }>(token, { secret });
      return {
        userId: payload.sub,
        tenantId: payload.tenantId,
        email: payload.email,
        role: payload.role,
      };
    } catch {
      throw new UnauthorizedException('Invalid or expired session.');
    }
  }

  private resolvePillarFeatureKey(path: string): FeatureKey {
    if (path.includes('credit-udhaar')) return 'aiCreditRisk';
    if (path.includes('voice-crm')) return 'aiVoiceCrm';
    if (path.includes('dealer-desk')) return 'aiDealerDesk';
    if (path.includes('/chat')) return 'aiCopilot';
    return 'aiScoring';
  }

  private async assertTenantAiBalanceAvailable(
    tenantId: string,
    userId: string,
    pillarKey: FeatureKey,
  ): Promise<void> {
    if (tenantId && Types.ObjectId.isValid(tenantId)) {
      await this.superAdminService?.assertFeatureEnabled(tenantId, 'aiScoring');
      if (pillarKey !== 'aiScoring') {
        await this.superAdminService?.assertFeatureEnabled(tenantId, pillarKey);
      }

      const tenant = await this.tenantModel
        .findById(tenantId)
        .select('isPlatformHq plan quotas featureOverrides')
        .lean();
      if (tenant && !tenant.isPlatformHq) {
        if (
          tenant.featureOverrides &&
          (tenant.featureOverrides['aiScoring'] === false ||
            tenant.featureOverrides[pillarKey] === false)
        ) {
          throw new ForbiddenException(
            'This AI feature has been disabled for your workspace by Super Admin.',
          );
        }

        const planDefaultCap =
          tenant.plan === 'starter' ? 500 : tenant.plan === 'enterprise' ? 50000 : 5000;
        const maxCalls = tenant.quotas?.maxMonthlyAiCalls ?? planDefaultCap;
        const usedCalls = tenant.quotas?.aiCallsUsed ?? 0;

        if (maxCalls <= 0 || usedCalls >= maxCalls) {
          throw new ForbiddenException(
            `Workspace AI balance is exhausted or removed by Super Admin (${usedCalls}/${maxCalls} AI calls used).`,
          );
        }
      }
    }

    if (userId && Types.ObjectId.isValid(userId)) {
      const user = await this.userModel
        .findById(userId)
        .select('role featureAccess aiDailyCallLimit aiCallsToday aiCallsDayKey')
        .lean();
      if (user && (user.role === 'manager' || user.role === 'agent')) {
        const fa = (user.featureAccess || {}) as Record<string, boolean | undefined>;
        if (fa['aiScoring'] === false || fa[pillarKey] === false) {
          throw new ForbiddenException(
            'This AI feature is turned off for your account by your Workspace Admin.',
          );
        }
        const dailyLimit = Number(user.aiDailyCallLimit || 0);
        if (dailyLimit > 0) {
          const todayKey = new Date().toISOString().slice(0, 10);
          const todayUsed = user.aiCallsDayKey === todayKey ? Number(user.aiCallsToday || 0) : 0;
          if (todayUsed >= dailyLimit) {
            throw new ForbiddenException(
              `Your daily AI call limit (${dailyLimit}) set by your Workspace Admin is reached.`,
            );
          }
        }
      }
    }
  }

  private async incrementTenantAiUsage(tenantId: string, userId: string): Promise<void> {
    if (tenantId && Types.ObjectId.isValid(tenantId)) {
      try {
        await this.tenantModel
          .updateOne(
            { _id: new Types.ObjectId(tenantId) },
            { $inc: { 'quotas.aiCallsUsed': 1, 'quotas.aiCostInr': 0.35 } },
          )
          .exec();
      } catch {
        // ignore usage metering write errors so primary AI result is returned
      }
    }

    if (userId && Types.ObjectId.isValid(userId)) {
      try {
        const todayKey = new Date().toISOString().slice(0, 10);
        const u = await this.userModel
          .findById(userId)
          .select('aiCallsDayKey aiCallsToday')
          .lean();
        if (u) {
          const nextCount = u.aiCallsDayKey === todayKey ? Number(u.aiCallsToday || 0) + 1 : 1;
          await this.userModel
            .updateOne(
              { _id: new Types.ObjectId(userId) },
              { $set: { aiCallsDayKey: todayKey, aiCallsToday: nextCount } },
            )
            .exec();
        }
      } catch {
        // ignore per-user metering errors
      }
    }
  }

  private async postAi<T = Record<string, unknown>>(
    path: string,
    payload: Record<string, unknown>,
    timeoutMs = 15000,
    options?: { skipMetering?: boolean },
  ): Promise<AiGatewayResponse<T> | null> {
    const tenantId = typeof payload.tenantId === 'string' ? payload.tenantId : '';
    const userId = typeof payload.userId === 'string' ? payload.userId : '';
    const pillarKey = this.resolvePillarFeatureKey(path);
    if (!options?.skipMetering && (tenantId || userId)) {
      await this.assertTenantAiBalanceAvailable(tenantId, userId, pillarKey);
    }

    const secret = this.getInternalSecret();
    try {
      const res = await axios.post<AiGatewayResponse<T>>(
        `${this.getAiUrl()}${path}`,
        payload,
        {
          headers: {
            'Content-Type': 'application/json',
            ...(secret ? { 'x-internal-secret': secret } : {}),
          },
          timeout: timeoutMs,
        },
      );
      if (!options?.skipMetering && (tenantId || userId)) {
        await this.incrementTenantAiUsage(tenantId, userId);
      }
      return res.data;
    } catch (err) {
      this.logger.warn(
        `leadsetu-ai call ${path} unavailable (${err instanceof Error ? err.message : String(err)})`,
      );
      return null;
    }
  }

  async getHealth(): Promise<{
    connected: boolean;
    aiUrl: string;
    details?: Record<string, unknown>;
  }> {
    const aiUrl = this.getAiUrl();
    try {
      const res = await axios.get<Record<string, unknown>>(
        `${aiUrl}/ai/health`,
        { timeout: 2500 },
      );
      return { connected: true, aiUrl, details: res.data };
    } catch {
      return { connected: false, aiUrl };
    }
  }

  async scoreCreditRisk(input: {
    tenantId: string;
    userId: string;
    userRole?: string;
    context: Record<string, unknown>;
  }) {
    return this.postAi('/ai/pillars/credit-udhaar', {
      ...input,
      mode: 'score',
    });
  }

  async draftUdhaarReminder(input: {
    tenantId: string;
    userId: string;
    userRole?: string;
    context: Record<string, unknown>;
  }) {
    return this.postAi('/ai/pillars/credit-udhaar', {
      ...input,
      mode: 'reminder',
    });
  }

  async draftWhatsAppReply(input: {
    tenantId: string;
    userId: string;
    userRole?: string;
    context: Record<string, unknown>;
  }) {
    return this.postAi<{ proposedToolCall?: Record<string, unknown> }>(
      '/ai/reply-draft',
      {
        ...input,
        task: 'reply_draft',
      },
    );
  }

  async summarizeConversation(input: {
    tenantId: string;
    userId: string;
    userRole?: string;
    context: Record<string, unknown>;
  }) {
    return this.postAi('/ai/summarize', {
      ...input,
      task: 'conversation_summary',
    });
  }

  async scoreLeadIntent(
    input: {
      tenantId: string;
      userId: string;
      userRole?: string;
      context: Record<string, unknown>;
    },
    options?: { skipMetering?: boolean; timeoutMs?: number },
  ) {
    return this.postAi<{
      aiScore?: number;
      aiLabel?: 'Hot' | 'Warm' | 'Cold';
      aiInsight?: string;
      reasons?: string[];
    }>(
      '/ai/score',
      {
        ...input,
        task: 'lead_score',
      },
      options?.timeoutMs ?? 8000,
      { skipMetering: options?.skipMetering },
    );
  }

  async summarizeLeadOrDeal(
    input: {
      tenantId: string;
      userId: string;
      userRole?: string;
      context: Record<string, unknown>;
    },
    options?: { skipMetering?: boolean; timeoutMs?: number },
  ) {
    return this.postAi(
      '/ai/summarize',
      {
        ...input,
        task: 'lead_summary',
      },
      options?.timeoutMs ?? 8000,
      { skipMetering: options?.skipMetering },
    );
  }

  async recommendNextBestAction(
    input: {
      tenantId: string;
      userId: string;
      userRole?: string;
      context: Record<string, unknown>;
    },
    options?: { skipMetering?: boolean; timeoutMs?: number },
  ) {
    return this.postAi<{ proposedToolCall?: Record<string, unknown> }>(
      '/ai/actions',
      {
        ...input,
        task: 'next_action',
      },
      options?.timeoutMs ?? 8000,
      { skipMetering: options?.skipMetering },
    );
  }

  async draftWorkflowRule(
    input: {
      tenantId: string;
      userId: string;
      userRole?: string;
      context: Record<string, unknown>;
    },
    options?: { skipMetering?: boolean; timeoutMs?: number },
  ) {
    return this.postAi<{
      name?: string;
      description?: string;
      triggerType?: string;
      sourceFilter?: string;
      staleStage?: string;
      staleHours?: number;
      conditionSummary?: string;
      actionType?: string;
      actionSummary?: string;
      whatsappTemplateBody?: string;
      trigger?: string;
      conditions?: string[];
      actions?: string[];
    }>(
      '/ai/actions',
      {
        ...input,
        task: 'workflow_draft',
      },
      options?.timeoutMs ?? 8000,
      { skipMetering: options?.skipMetering },
    );
  }

  async extractVoiceToCrm(input: {
    tenantId: string;
    userId: string;
    userRole?: string;
    context: Record<string, unknown>;
  }) {
    return this.postAi('/ai/pillars/voice-crm', {
      ...input,
      mode: 'extract',
    });
  }

  async auditCall(input: {
    tenantId: string;
    userId: string;
    userRole?: string;
    context: Record<string, unknown>;
  }) {
    return this.postAi('/ai/pillars/voice-crm', {
      ...input,
      mode: 'audit',
    });
  }

  async processWhatsappCallAudio(input: {
    tenantId: string;
    userId: string;
    userRole?: string;
    context: {
      recordingUrl?: string;
      audioDataUrl?: string;
      transcript?: string;
      buyerName?: string;
      company?: string;
      agentName?: string;
      direction?: 'inbound' | 'outbound';
      durationSeconds?: number;
    };
  }) {
    return this.postAi<{
      transcript?: string;
      sttProvider?: string;
      languageDetected?: string;
      summaryBullets?: string[];
      aiSummary?: string;
      bantUpdates?: {
        budget?: string | null;
        authority?: string | null;
        need?: string | null;
        timeline?: string | null;
        nextFollowUpDate?: string | null;
        sentiment?: string;
        objections?: string[];
        commitments?: string[];
      };
    }>(
      '/ai/pillars/whatsapp-call-postprocess',
      input as unknown as Record<string, unknown>,
      45000,
    );
  }

  async parseDealerRfq(input: {
    tenantId: string;
    userId: string;
    userRole?: string;
    context: Record<string, unknown>;
  }) {
    return this.postAi('/ai/pillars/dealer-desk', {
      ...input,
      mode: 'rfq',
    });
  }

  async buildBeatPlan(input: {
    tenantId: string;
    userId: string;
    userRole?: string;
    context: Record<string, unknown>;
  }) {
    return this.postAi('/ai/pillars/dealer-desk', {
      ...input,
      mode: 'beat_plan',
    });
  }

  async getTenantUsage(tenantId: string) {
    let workspaceAiBalance: {
      maxMonthlyAiCalls: number;
      aiCallsUsed: number;
      aiBalanceRemaining: number;
      addonAiCalls: number;
      aiEnabled: boolean;
    } | null = null;

    if (Types.ObjectId.isValid(tenantId)) {
      const tenant = await this.tenantModel
        .findById(tenantId)
        .select('plan quotas featureOverrides')
        .lean();
      if (tenant) {
        const planDefaultCap =
          tenant.plan === 'starter' ? 500 : tenant.plan === 'enterprise' ? 50000 : 5000;
        const maxMonthlyAiCalls = tenant.quotas?.maxMonthlyAiCalls ?? planDefaultCap;
        const aiCallsUsed = tenant.quotas?.aiCallsUsed ?? 0;
        workspaceAiBalance = {
          maxMonthlyAiCalls,
          aiCallsUsed,
          aiBalanceRemaining: Math.max(0, maxMonthlyAiCalls - aiCallsUsed),
          addonAiCalls: tenant.quotas?.addonAiCalls ?? 0,
          aiEnabled: tenant.featureOverrides?.['aiScoring'] !== false,
        };
      }
    }

    const secret = this.getInternalSecret();
    try {
      const res = await axios.get<Record<string, unknown>>(
        `${this.getAiUrl()}/ai/usage/${encodeURIComponent(tenantId)}`,
        {
          headers: secret ? { 'x-internal-secret': secret } : undefined,
          timeout: 5000,
        },
      );
      return {
        ...res.data,
        ...(workspaceAiBalance ? { workspaceAiBalance } : {}),
      };
    } catch (err) {
      this.logger.warn(
        `leadsetu-ai usage unavailable (${err instanceof Error ? err.message : String(err)})`,
      );
      return {
        tenantId,
        dailyTokensUsed: 0,
        dailyTokenLimit: 50000,
        monthlyTokensUsed: 0,
        monthlyTokenLimit: 500000,
        dailyCalls: 0,
        monthlyCalls: 0,
        estimatedCostUsd: 0,
        recentRecords: [],
        ...(workspaceAiBalance ? { workspaceAiBalance } : {}),
      };
    }
  }

  private async loadTenantRagRecords(
    tenantId: string,
    userId?: string,
  ): Promise<
    Array<{
      entityType: string;
      entityId: string;
      text: string;
      metadata?: Record<string, unknown>;
    }>
  > {
    const tenantFilterValues: Array<string | Types.ObjectId> = [tenantId];
    if (Types.ObjectId.isValid(tenantId)) {
      tenantFilterValues.push(new Types.ObjectId(tenantId));
    }
    const ownerScope = await resolveOwnerScopeFilter(this.tenantModel.db, {
      userId,
      tenantId,
    });
    const scopedQuery = { tenantId: { $in: tenantFilterValues }, ...ownerScope };
    const tenantWideQuery = { tenantId: { $in: tenantFilterValues } };

    const sources: Array<{
      collection: string;
      entityType: string;
      tenantWide?: boolean;
      limit?: number;
      format: (doc: Record<string, unknown>) => string;
    }> = [
      {
        collection: 'products',
        entityType: 'product',
        tenantWide: true,
        limit: 15,
        format: (d) =>
          `Product SKU ${d.sku || 'N/A'} — ${d.name || ''} | Category: ${
            d.category || 'Industrial Goods'
          } | HSN/SAC: ${d.hsnSac || '850440'} | Unit Price: ₹${Number(
            d.unitPrice ?? d.price ?? 0,
          ).toLocaleString('en-IN')} + ${d.gstRate ?? 18}% GST | MOQ: ${
            d.moq || 1
          } ${d.unit || 'pcs'} | Specs: ${
            d.description || 'Standard B2B supply'
          }${d.brochureUrl ? ` | Brochure: ${d.brochureUrl}` : ''}`,
      },
      {
        collection: 'documents',
        entityType: 'document',
        tenantWide: true,
        limit: 12,
        format: (d) =>
          `Document Vault [${d.docCode || 'DOC'}] ${d.title || ''} (${
            d.category || 'brochure'
          }) | Doc/GST No: ${d.documentNumber || 'N/A'} | Customer: ${
            d.linkedCustomerName || 'Workspace'
          } | Summary: ${d.description || ''} | Tags: ${
            Array.isArray(d.tags) ? d.tags.join(', ') : ''
          }`,
      },
      {
        collection: 'leads',
        entityType: 'lead',
        limit: 6,
        format: (d) =>
          `Lead ${d.name || ''} (${d.company || 'N/A'}) | City: ${d.city || 'N/A'} | Status: ${d.status || 'new'} | AI Score: ${d.aiScore ?? 'N/A'} | Est Value: ₹${Number(d.estimatedValue || 0).toLocaleString('en-IN')}`,
      },
      {
        collection: 'deals',
        entityType: 'deal',
        limit: 6,
        format: (d) =>
          `Deal ${d.title || d.company || ''} | Company: ${d.company || 'N/A'} | Stage: ${d.stage || 'qualified'} | Value: ₹${Number(d.value || 0).toLocaleString('en-IN')} | City: ${d.city || 'N/A'}`,
      },
      {
        collection: 'invoices',
        entityType: 'invoice',
        limit: 6,
        format: (d) =>
          `Invoice ${d.invoiceNumber || ''} | Client: ${d.clientName || d.clientCompany || 'N/A'} | Status: ${d.status || 'sent'} | Total: ₹${Number(d.grandTotal || 0).toLocaleString('en-IN')} | Paid: ₹${Number(d.amountPaid || 0).toLocaleString('en-IN')} | Due Date: ${d.dueDate || 'N/A'}`,
      },
      {
        collection: 'contacts',
        entityType: 'contact',
        limit: 5,
        format: (d) =>
          `Contact ${d.name || ''} (${d.company || 'N/A'}) | City: ${d.city || 'N/A'} | GSTIN: ${d.gstin || 'N/A'} | Credit Limit: ₹${Number(d.creditLimit || 0).toLocaleString('en-IN')}`,
      },
      {
        collection: 'tasks',
        entityType: 'task',
        limit: 5,
        format: (d) =>
          `Task "${d.title || ''}" | Status: ${d.status || 'pending'} | Priority: ${d.priority || 'medium'} | Due: ${d.dueDate || 'N/A'} | Buyer: ${d.relatedCompany || d.relatedName || 'N/A'}`,
      },
    ];

    const records: Array<{
      entityType: string;
      entityId: string;
      text: string;
    }> = [];

    await Promise.all(
      sources.map(async (src) => {
        try {
          const docs = await this.tenantModel.db
            .collection(src.collection)
            .find(src.tenantWide ? tenantWideQuery : scopedQuery)
            .sort({ updatedAt: -1, createdAt: -1 })
            .limit(src.limit ?? 5)
            .toArray();
          for (const doc of docs) {
            records.push({
              entityType: src.entityType,
              entityId: String(doc._id || ''),
              text: src.format(doc as Record<string, unknown>),
            });
          }
        } catch (err) {
          this.logger.debug(
            `Skipped RAG collection ${src.collection}: ${err instanceof Error ? err.message : 'unavailable'}`,
          );
        }
      }),
    );

    return records.slice(0, 50);
  }

  async syncTenantKnowledgeIndex(
    tenantId: string,
    userId?: string,
  ): Promise<{
    synced: boolean;
    tenantId: string;
    totalIndexedChunks: number;
    breakdown: {
      products: number;
      documents: number;
      crmRecords: number;
    };
  }> {
    const records = await this.loadTenantRagRecords(tenantId, userId);
    const productsCount = records.filter((r) => r.entityType === 'product').length;
    const documentsCount = records.filter((r) => r.entityType === 'document').length;
    const crmRecordsCount = records.length - productsCount - documentsCount;

    const secret = this.getInternalSecret();
    let totalIndexedChunks = records.length;
    let synced = false;
    try {
      const res = await axios.post<{
        tenantId: string;
        totalIndexedChunks: number;
      }>(
        `${this.getAiUrl()}/ai/knowledge/index`,
        {
          tenantId,
          chunks: records,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            ...(secret ? { 'x-internal-secret': secret } : {}),
          },
          timeout: 8000,
        },
      );
      totalIndexedChunks = res.data?.totalIndexedChunks ?? records.length;
      synced = true;
    } catch (err) {
      this.logger.debug(
        `leadsetu-ai /ai/knowledge/index offline (${
          err instanceof Error ? err.message : String(err)
        })`,
      );
    }

    return {
      synced,
      tenantId,
      totalIndexedChunks,
      breakdown: {
        products: productsCount,
        documents: documentsCount,
        crmRecords: crmRecordsCount,
      },
    };
  }

  async chat(input: {
    tenantId: string;
    userId: string;
    userRole?: string;
    context: Record<string, unknown>;
  }) {
    const existingRecords = input.context?.records;
    const records =
      Array.isArray(existingRecords) && existingRecords.length > 0
        ? existingRecords
        : await this.loadTenantRagRecords(input.tenantId, input.userId);

    // Ensure Product Catalogue & Document Vault chunks are indexed in leadsetu-ai
    const secret = this.getInternalSecret();
    await axios
      .post(
        `${this.getAiUrl()}/ai/knowledge/index`,
        {
          tenantId: input.tenantId,
          chunks: records,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            ...(secret ? { 'x-internal-secret': secret } : {}),
          },
          timeout: 4500,
        },
      )
      .catch(() => null);

    return this.postAi<{
      proposedActions?: Array<{
        actionId: string;
        type:
          | 'create_task'
          | 'schedule_call'
          | 'create_quotation'
          | 'send_whatsapp_draft';
        label: string;
        summary: string;
        payload: Record<string, unknown>;
      }>;
    }>('/ai/chat', {
      ...input,
      context: {
        ...input.context,
        records,
      },
    });
  }

  async executeCopilotAction(
    auth: { userId: string; tenantId: string; email: string; role?: string },
    body: {
      type:
        | 'create_task'
        | 'schedule_call'
        | 'create_quotation'
        | 'send_whatsapp_draft';
      payload?: Record<string, unknown>;
    },
  ) {
    const actionType = body?.type;
    const payload = (body?.payload || {}) as Record<string, unknown>;
    const tenantObjectId = new Types.ObjectId(auth.tenantId);
    const ownerObjectId = new Types.ObjectId(auth.userId);
    const now = new Date();
    const tomorrowIso = new Date(Date.now() + 86400000)
      .toISOString()
      .slice(0, 10);

    if (actionType === 'create_task' || actionType === 'schedule_call') {
      const title = String(
        payload.title ||
          (actionType === 'schedule_call'
            ? 'Schedule B2B Closing Call (SetuAI Copilot)'
            : 'Follow up with buyer (SetuAI Copilot)'),
      ).trim();
      const description = String(
        payload.description || 'Created via SetuAI Transactional Copilot.',
      ).trim();
      const priority =
        payload.priority === 'low' ||
        payload.priority === 'medium' ||
        payload.priority === 'high'
          ? payload.priority
          : 'high';
      const dueDate = String(payload.dueDate || tomorrowIso);
      const relatedName = String(payload.relatedName || '');
      const relatedCompany = String(payload.relatedCompany || '');

      const insertRes = await this.tenantModel.db.collection('tasks').insertOne({
        tenantId: tenantObjectId,
        ownerId: ownerObjectId,
        title,
        description,
        priority,
        status: 'pending',
        category: actionType === 'schedule_call' ? 'call' : 'follow_up',
        dueDate,
        relatedName,
        relatedCompany,
        createdAt: now,
        updatedAt: now,
      });

      const taskId = insertRes.insertedId.toString();
      return {
        executed: true,
        actionType,
        entityType: 'task',
        entityId: taskId,
        entityLabel: title,
        summary: `${
          actionType === 'schedule_call' ? 'Scheduled Call Task' : 'Created Follow-Up Task'
        }: "${title}" (Due ${dueDate})`,
        redirectPath: '/tasks',
        record: {
          id: taskId,
          title,
          description,
          priority,
          status: 'pending',
          dueDate,
          relatedName,
          relatedCompany,
        },
      };
    }

    if (actionType === 'create_quotation') {
      const clientName = String(
        payload.clientName || payload.company || 'B2B Prospect Account',
      ).trim();
      const contactPerson = String(
        payload.contactPerson || payload.buyerName || clientName,
      ).trim();
      const phone = String(payload.phone || '').trim();
      const gstRate = Number(payload.gstRate ?? 18);

      let items = Array.isArray(payload.items)
        ? (payload.items as Array<{
            description?: string;
            sku?: string;
            hsnSac?: string;
            quantity?: number;
            unitPrice?: number;
          }>)
        : [];

      if (items.length === 0) {
        const firstProduct = await this.tenantModel.db
          .collection('products')
          .findOne({ tenantId: tenantObjectId }, { sort: { updatedAt: -1 } });
        items = [
          {
            description: firstProduct
              ? `${firstProduct.name} (SKU: ${firstProduct.sku})`
              : 'Industrial B2B Supply Item',
            sku: String(firstProduct?.sku || 'LS-SKU-101'),
            hsnSac: String(firstProduct?.hsnSac || '850440'),
            quantity: Number(firstProduct?.moq || 1),
            unitPrice: Number(firstProduct?.unitPrice || 100000),
          },
        ];
      }

      const normalizedItems = items.map((it) => {
        const qty = Math.max(1, Number(it.quantity || 1));
        const unitPrice = Math.max(0, Number(it.unitPrice || 0));
        return {
          description: String(it.description || 'Industrial Supply Item'),
          sku: String(it.sku || ''),
          hsnSac: String(it.hsnSac || '850440'),
          quantity: qty,
          unitPrice,
          amount: qty * unitPrice,
        };
      });

      const subTotal = normalizedItems.reduce((s, it) => s + it.amount, 0);
      const taxAmount = Math.round((subTotal * gstRate) / 100);
      const grandTotal = subTotal + taxAmount;
      const invoiceNumber = `QT-AI-${String(Date.now()).slice(-6)}`;

      const insertRes = await this.tenantModel.db
        .collection('invoices')
        .insertOne({
          tenantId: tenantObjectId,
          ownerId: ownerObjectId,
          docType: 'proforma_quote',
          invoiceNumber,
          clientName,
          contactPerson,
          phone,
          taxType: 'igst',
          gstRate,
          items: normalizedItems,
          subTotal,
          taxAmount,
          grandTotal,
          amountPaid: 0,
          balanceDue: grandTotal,
          status: 'draft',
          issueDate: now.toISOString().slice(0, 10),
          dueDate: tomorrowIso,
          notes: 'Auto-drafted by SetuAI Transactional Copilot from Product Catalogue RAG.',
          createdAt: now,
          updatedAt: now,
        });

      const quoteId = insertRes.insertedId.toString();
      return {
        executed: true,
        actionType,
        entityType: 'quotation',
        entityId: quoteId,
        entityLabel: invoiceNumber,
        summary: `Drafted Proforma Quotation ${invoiceNumber} for ${clientName} — ₹${grandTotal.toLocaleString('en-IN')} (incl. ${gstRate}% GST)`,
        redirectPath: '/quotations',
        record: {
          id: quoteId,
          invoiceNumber,
          clientName,
          contactPerson,
          grandTotal,
          gstRate,
          items: normalizedItems,
        },
      };
    }

    throw new ForbiddenException(
      `Unsupported Copilot action type: ${String(actionType)}`,
    );
  }
}
