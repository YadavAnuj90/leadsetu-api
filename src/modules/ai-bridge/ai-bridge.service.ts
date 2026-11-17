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
  ): Promise<AiGatewayResponse<T> | null> {
    const tenantId = typeof payload.tenantId === 'string' ? payload.tenantId : '';
    const userId = typeof payload.userId === 'string' ? payload.userId : '';
    const pillarKey = this.resolvePillarFeatureKey(path);
    if (tenantId || userId) {
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
      if (tenantId || userId) {
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
  ): Promise<Array<{ entityType: string; entityId: string; text: string }>> {
    const tenantFilterValues: Array<string | Types.ObjectId> = [tenantId];
    if (Types.ObjectId.isValid(tenantId)) {
      tenantFilterValues.push(new Types.ObjectId(tenantId));
    }
    const ownerScope = await resolveOwnerScopeFilter(this.tenantModel.db, {
      userId,
      tenantId,
    });
    const query = { tenantId: { $in: tenantFilterValues }, ...ownerScope };

    const sources: Array<{
      collection: string;
      entityType: string;
      format: (doc: Record<string, unknown>) => string;
    }> = [
      {
        collection: 'leads',
        entityType: 'lead',
        format: (d) =>
          `Lead ${d.name || ''} (${d.company || 'N/A'}) | City: ${d.city || 'N/A'} | Status: ${d.status || 'new'} | AI Score: ${d.aiScore ?? 'N/A'} | Est Value: ₹${Number(d.estimatedValue || 0).toLocaleString('en-IN')}`,
      },
      {
        collection: 'deals',
        entityType: 'deal',
        format: (d) =>
          `Deal ${d.title || d.company || ''} | Company: ${d.company || 'N/A'} | Stage: ${d.stage || 'qualified'} | Value: ₹${Number(d.value || 0).toLocaleString('en-IN')} | City: ${d.city || 'N/A'}`,
      },
      {
        collection: 'invoices',
        entityType: 'invoice',
        format: (d) =>
          `Invoice ${d.invoiceNumber || ''} | Client: ${d.clientName || d.clientCompany || 'N/A'} | Status: ${d.status || 'sent'} | Total: ₹${Number(d.grandTotal || 0).toLocaleString('en-IN')} | Paid: ₹${Number(d.amountPaid || 0).toLocaleString('en-IN')} | Due Date: ${d.dueDate || 'N/A'}`,
      },
      {
        collection: 'contacts',
        entityType: 'contact',
        format: (d) =>
          `Contact ${d.name || ''} (${d.company || 'N/A'}) | City: ${d.city || 'N/A'} | GSTIN: ${d.gstin || 'N/A'} | Credit Limit: ₹${Number(d.creditLimit || 0).toLocaleString('en-IN')}`,
      },
      {
        collection: 'tasks',
        entityType: 'task',
        format: (d) =>
          `Task "${d.title || ''}" | Status: ${d.status || 'pending'} | Priority: ${d.priority || 'medium'} | Due: ${d.dueDate || 'N/A'} | Buyer: ${d.relatedCompany || d.relatedName || 'N/A'}`,
      },
    ];

    const records: Array<{ entityType: string; entityId: string; text: string }> =
      [];

    await Promise.all(
      sources.map(async (src) => {
        try {
          const docs = await this.tenantModel.db
            .collection(src.collection)
            .find(query)
            .sort({ updatedAt: -1, createdAt: -1 })
            .limit(5)
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

    return records.slice(0, 25);
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

    return this.postAi('/ai/chat', {
      ...input,
      context: {
        ...input.context,
        records,
      },
    });
  }
}
