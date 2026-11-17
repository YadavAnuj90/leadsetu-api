import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  OnModuleInit,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Connection, Model, Types } from 'mongoose';
import { randomBytes, timingSafeEqual } from 'crypto';
import { User, UserDocument, UserRole } from '../auth/schemas/user.schema';
import {
  SubscriptionInvoiceRecord,
  Tenant,
  TenantDocument,
} from '../auth/schemas/tenant.schema';
import {
  generateAccountId,
  generateUserCode,
  hashSecret,
  verifySecret,
} from '../auth/identity.util';
import { PLAN_CATALOG } from '../tenants/tenants.service';
import {
  AI_PILLAR_FEATURE_KEYS,
  DEFAULT_DUNNING_POLICY,
  DEFAULT_GLOBAL_KILL_SWITCHES,
  DEFAULT_PLAN_MATRIX,
  DEFAULT_SECURITY_POLICIES,
  FeatureKey,
  PLATFORM_FEATURE_CATALOG,
  PlatformAuditLog,
  PlatformAuditLogDocument,
  PlatformConfig,
  PlatformConfigDocument,
  SaasCoupon,
  SaasCouponDocument,
  SaasPartner,
  SaasPartnerDocument,
} from './schemas/platform-config.schema';
import {
  BulkManageAiAuthorityDto,
  CreateSaasCouponDto,
  CreateSaasPartnerDto,
  CreateSuperAdminOperatorDto,
  DpdpEraseTenantDto,
  GrantQuotaAddonDto,
  ImpersonateTenantDto,
  IssueTenantSubscriptionDto,
  ManageTenantAiAuthorityDto,
  PartnerPayoutDto,
  ResolveTopupRequestDto,
  RevokeTenantSessionsDto,
  SuperAdminActor,
  UpdateDunningPolicyDto,
  UpdatePlatformPoliciesDto,
  UpdateSaasCouponDto,
  UpdateSubscriptionInvoiceStatusDto,
  UpdateTenantGovernanceDto,
  UpdateTenantUserRbacDto,
} from './dto/super-admin.dto';

const AI_UNIT_COST_INR = 0.35;
const WA_UNIT_COST_INR = 0.88;

const VALID_PLANS = ['starter', 'growth', 'enterprise'] as const;
const VALID_STATUSES = ['trial', 'active', 'suspended'] as const;
const VALID_ROLES: UserRole[] = ['owner', 'admin', 'manager', 'agent'];

@Injectable()
export class SuperAdminService implements OnModuleInit {
  /** CSPRNG one-time setup token generated in memory only when zero super admins exist. */
  private runtimeSetupToken: string | null = null;

  constructor(
    @InjectModel(Tenant.name)
    private readonly tenantModel: Model<TenantDocument>,
    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>,
    @InjectModel(PlatformConfig.name)
    private readonly configModel: Model<PlatformConfigDocument>,
    @InjectModel(PlatformAuditLog.name)
    private readonly platformAuditModel: Model<PlatformAuditLogDocument>,
    @InjectModel(SaasCoupon.name)
    private readonly couponModel: Model<SaasCouponDocument>,
    @InjectModel(SaasPartner.name)
    private readonly partnerModel: Model<SaasPartnerDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  async onModuleInit() {
    await this.ensureGlobalConfig();
    const superAdminCount = await this.userModel
      .countDocuments({ role: 'super_admin' })
      .exec();

    if (superAdminCount === 0) {
      const envEmail = this.configService.get<string>('SUPER_ADMIN_EMAIL')?.trim().toLowerCase();
      const envPassword = this.configService.get<string>('SUPER_ADMIN_PASSWORD');
      const envName =
        this.configService.get<string>('SUPER_ADMIN_NAME')?.trim() ||
        'Leadsetu HQ Authority';

      if (envEmail && envPassword && envPassword.length >= 10) {
        const hqTenant = await this.ensureHqTenant();
        await this.userModel.create({
          tenantId: hqTenant._id,
          userCode: await generateUserCode(this.userModel),
          name: envName,
          email: envEmail,
          passwordHash: hashSecret(envPassword),
          role: 'super_admin',
          departmentPreset: 'hq',
          permissions: ['*'],
          isActive: true,
          territory: 'Leadsetu HQ Authority',
        });
        console.log(`🛡️  Seeded Super Admin from environment: ${envEmail}`);
      } else {
        this.runtimeSetupToken =
          this.configService.get<string>('SUPER_ADMIN_SETUP_KEY')?.trim() ||
          randomBytes(9).toString('hex').toUpperCase();
        console.log(
          `🔐 No Super Admin initialized yet. One-time Vault Setup Key: ${this.runtimeSetupToken}`,
        );
      }
    }
  }

  async ensureGlobalConfig(): Promise<PlatformConfigDocument> {
    let doc = await this.configModel.findOne({ key: 'global' }).exec();
    if (!doc) {
      doc = await this.configModel.create({
        key: 'global',
        maintenanceMode: false,
        maintenanceBanner:
          'Scheduled Leadsetu Cloud optimization window. All CRM data remains safe.',
        allowNewSignups: true,
        defaultTrialDays: 14,
        planMatrix: DEFAULT_PLAN_MATRIX,
        globalKillSwitches: DEFAULT_GLOBAL_KILL_SWITCHES,
        securityPolicies: DEFAULT_SECURITY_POLICIES,
        dunningPolicy: DEFAULT_DUNNING_POLICY,
      });
    } else if (!doc.dunningPolicy) {
      doc.dunningPolicy = { ...DEFAULT_DUNNING_POLICY };
      doc.markModified('dunningPolicy');
      await doc.save();
    }
    return doc;
  }

  private async ensureHqTenant(): Promise<TenantDocument> {
    let hq = await this.tenantModel
      .findOne({ $or: [{ isPlatformHq: true }, { slug: 'leadsetu-platform-hq' }] })
      .exec();
    if (!hq) {
      hq = await this.tenantModel.create({
        name: 'Leadsetu Platform HQ',
        slug: 'leadsetu-platform-hq',
        accountId: await generateAccountId(this.tenantModel),
        plan: 'enterprise',
        status: 'active',
        isPlatformHq: true,
        city: 'Noida & New Delhi',
        state: 'Delhi (07)',
        gstin: '07AABCL4821K1Z5',
        email: 'hq@leadsetu.in',
        address: 'Tower B, 7th Floor, Sector 62, Noida & Connaught Place, New Delhi – 110001',
      });
    }
    return hq;
  }

  async getBootstrapStatus() {
    const count = await this.userModel.countDocuments({ role: 'super_admin' }).exec();
    return {
      initialized: count > 0,
      hasEnvSetupKey: Boolean(this.configService.get<string>('SUPER_ADMIN_SETUP_KEY')),
    };
  }

  async bootstrapInitialSuperAdmin(
    body: {
      name: string;
      email: string;
      password: string;
      phone?: string;
      setupKey: string;
    },
    ipAddress = '',
  ) {
    const existingCount = await this.userModel
      .countDocuments({ role: 'super_admin' })
      .exec();
    if (existingCount > 0) {
      throw new ForbiddenException(
        'Super Admin vault is already initialized. Sign in with an authorized operator account.',
      );
    }

    const expectedKey =
      this.configService.get<string>('SUPER_ADMIN_SETUP_KEY')?.trim() ||
      this.runtimeSetupToken;

    if (!expectedKey || !body.setupKey) {
      throw new UnauthorizedException('Valid Vault Setup Key is required.');
    }

    const a = Buffer.from(body.setupKey.trim());
    const b = Buffer.from(expectedKey);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new UnauthorizedException('Invalid Vault Setup Key.');
    }

    const name = body.name?.trim();
    const email = body.email?.trim().toLowerCase();
    const password = body.password;

    if (!name || !email || !email.includes('@')) {
      throw new BadRequestException('Valid operator name and work email are required.');
    }
    if (!password || password.length < 10) {
      throw new BadRequestException(
        'Super Admin password must be at least 10 characters long.',
      );
    }

    const clash = await this.userModel.findOne({ email }).exec();
    if (clash) {
      throw new ConflictException(
        'This email is already registered as a workspace user. Use a dedicated HQ email.',
      );
    }

    const hqTenant = await this.ensureHqTenant();
    const created = await this.userModel.create({
      tenantId: hqTenant._id,
      userCode: await generateUserCode(this.userModel),
      name,
      email,
      phone: body.phone?.trim() || '',
      passwordHash: hashSecret(password),
      role: 'super_admin',
      departmentPreset: 'hq',
      permissions: ['*'],
      isActive: true,
      territory: 'Leadsetu Platform HQ',
    });

    this.runtimeSetupToken = null;

    await this.recordAudit(
      {
        userId: created._id.toString(),
        email: created.email,
        name: created.name,
        userCode: created.userCode || '',
      },
      {
        action: 'super_admin.vault_initialized',
        severity: 'critical',
        summary: `Initialized Leadsetu Super Admin Authority Vault (${created.email})`,
        ipAddress,
      },
    );

    return {
      success: true,
      operator: {
        id: created._id.toString(),
        userCode: created.userCode,
        name: created.name,
        email: created.email,
        role: created.role,
      },
    };
  }

  /** Verifies bearer JWT AND confirms the live DB user is an active `super_admin`. */
  async verifySuperAdmin(authHeader?: string): Promise<SuperAdminActor> {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Authorization token is required.');
    }
    const token = authHeader.slice(7).trim();
    const secret =
      this.configService.get<string>('JWT_SECRET') ||
      'leadsetu_super_secret_access_key_2026_delhi_ncr';

    let payload: { sub: string; email?: string; role?: string };
    try {
      payload = await this.jwtService.verifyAsync<{
        sub: string;
        email?: string;
        role?: string;
      }>(token, { secret });
    } catch {
      throw new UnauthorizedException('Invalid or expired session token.');
    }

    const user = await this.userModel.findById(payload.sub).exec();
    if (!user || !user.isActive) {
      throw new UnauthorizedException('Operator account does not exist or is suspended.');
    }
    if (user.role !== 'super_admin') {
      throw new ForbiddenException(
        'Access Denied: Leadsetu Super Admin Authority is required for this endpoint.',
      );
    }

    return {
      userId: user._id.toString(),
      email: user.email,
      name: user.name,
      userCode: user.userCode || '',
    };
  }

  private async recordAudit(
    actor: SuperAdminActor,
    input: {
      action: string;
      severity: 'info' | 'warning' | 'critical';
      summary: string;
      reason?: string;
      ipAddress?: string;
      targetTenant?: TenantDocument | null;
      metadata?: Record<string, unknown>;
    },
  ) {
    try {
      await this.platformAuditModel.create({
        actorId: new Types.ObjectId(actor.userId),
        actorName: actor.name,
        actorEmail: actor.email,
        action: input.action,
        severity: input.severity,
        targetTenantId: input.targetTenant?._id?.toString() || '',
        targetTenantName: input.targetTenant?.name || '',
        targetAccountId: input.targetTenant?.accountId || '',
        summary: input.summary,
        reason: input.reason || '',
        ipAddress: input.ipAddress || '',
        metadata: input.metadata || {},
      });
    } catch {
      // Never break primary action on secondary audit write failure
    }
  }

  private computeEffectiveFeatures(
    tenant: TenantDocument,
    config: PlatformConfigDocument,
  ): Record<
    FeatureKey,
    { enabled: boolean; source: 'plan' | 'override_on' | 'override_off' | 'kill_switch' }
  > {
    const planSpec =
      config.planMatrix?.[tenant.plan] || DEFAULT_PLAN_MATRIX[tenant.plan] || DEFAULT_PLAN_MATRIX.growth;
    const overrides = (tenant.featureOverrides || {}) as Record<string, boolean | undefined>;
    const kills = config.globalKillSwitches || DEFAULT_GLOBAL_KILL_SWITCHES;
    const result = {} as Record<
      FeatureKey,
      { enabled: boolean; source: 'plan' | 'override_on' | 'override_off' | 'kill_switch' }
    >;

    const isKilledGlobally = (key: FeatureKey): boolean => {
      if (
        key === 'aiScoring' ||
        (AI_PILLAR_FEATURE_KEYS as readonly string[]).includes(key)
      ) {
        return kills.geminiAiEnabled === false;
      }
      if (key === 'whatsappCloud' || key === 'whatsappBroadcasts') {
        return kills.whatsappCloudEnabled === false;
      }
      if (key === 'apiWebhooks') return kills.webhooksEnabled === false;
      return false;
    };

    const defaultPlanFeatures = (DEFAULT_PLAN_MATRIX[tenant.plan] || DEFAULT_PLAN_MATRIX.growth)
      .features as Record<string, boolean | undefined>;

    for (const spec of PLATFORM_FEATURE_CATALOG) {
      if (isKilledGlobally(spec.key)) {
        result[spec.key] = { enabled: false, source: 'kill_switch' };
        continue;
      }
      const storedPlanVal = (planSpec.features as Record<string, boolean | undefined> | undefined)?.[
        spec.key
      ];
      const baseEnabled =
        typeof storedPlanVal === 'boolean'
          ? storedPlanVal
          : Boolean(defaultPlanFeatures?.[spec.key]);
      if (typeof overrides[spec.key] === 'boolean') {
        result[spec.key] = {
          enabled: Boolean(overrides[spec.key]),
          source: overrides[spec.key] ? 'override_on' : 'override_off',
        };
      } else {
        result[spec.key] = {
          enabled: baseEnabled,
          source: 'plan',
        };
      }
    }
    return result;
  }

  async getTenantEffectiveState(tenantId: string) {
    if (!Types.ObjectId.isValid(tenantId)) return null;
    const [tenant, config] = await Promise.all([
      this.tenantModel.findById(tenantId).exec(),
      this.ensureGlobalConfig(),
    ]);
    if (!tenant) return null;

    const details = this.computeEffectiveFeatures(tenant, config);
    const effectiveFeatures = {} as Record<FeatureKey, boolean>;
    for (const spec of PLATFORM_FEATURE_CATALOG) {
      effectiveFeatures[spec.key] = details[spec.key].enabled;
    }

    const kills = config.globalKillSwitches || DEFAULT_GLOBAL_KILL_SWITCHES;

    return {
      effectiveFeatures,
      effectiveFeatureDetails: details,
      globalKillSwitches: kills,
      maintenanceMode: Boolean(config.maintenanceMode),
      maintenanceBanner: config.maintenanceBanner || '',
      blockCsvExport: Boolean(
        kills.bulkExportsEnabled === false ||
          tenant.securityPolicy?.lockAgentExport ||
          tenant.blockAgentExport,
      ),
      forcePhoneMasking: Boolean(
        tenant.securityPolicy?.enforcePhoneMasking ||
          tenant.maskPhoneForAgents,
      ),
    };
  }

  private computeTenantCostTelemetry(
    tenant: TenantDocument,
    config: PlatformConfigDocument,
  ) {
    const planSpec =
      config.planMatrix?.[tenant.plan] || PLAN_CATALOG[tenant.plan] || DEFAULT_PLAN_MATRIX.growth;
    const mrrInr = tenant.status === 'active' ? planSpec?.monthlyPrice || 0 : 0;

    const aiLimit = Math.max(1, tenant.quotas?.maxMonthlyAiCalls ?? planSpec.maxMonthlyAiCalls ?? 2500);
    const waLimit = Math.max(1, tenant.quotas?.maxMonthlyWhatsapp ?? planSpec.maxMonthlyWhatsapp ?? 5000);
    const aiUsed = tenant.quotas?.aiCallsUsed ?? 0;
    const waUsed = tenant.quotas?.whatsappUsed ?? 0;

    const aiPct = Math.round((aiUsed / aiLimit) * 100);
    const waPct = Math.round((waUsed / waLimit) * 100);

    const estimatedAiCostInr = Number(
      (tenant.quotas?.aiCostInr && tenant.quotas.aiCostInr > 0
        ? tenant.quotas.aiCostInr
        : aiUsed * AI_UNIT_COST_INR
      ).toFixed(2),
    );
    const estimatedWaCostInr = Number(
      (tenant.quotas?.whatsappCostInr && tenant.quotas.whatsappCostInr > 0
        ? tenant.quotas.whatsappCostInr
        : waUsed * WA_UNIT_COST_INR
      ).toFixed(2),
    );
    const totalInfraCostInr = Number((estimatedAiCostInr + estimatedWaCostInr).toFixed(2));
    const grossMarginInr = Number((mrrInr - totalInfraCostInr).toFixed(2));
    const marginPct = mrrInr > 0 ? Math.round((grossMarginInr / mrrInr) * 100) : totalInfraCostInr > 0 ? -100 : 0;
    const unprofitable = totalInfraCostInr > mrrInr && totalInfraCostInr > 0;
    const maxPct = Math.max(aiPct, waPct);
    const alertLevel: 'ok' | 'warning_80' | 'exceeded_100' =
      maxPct >= 100 ? 'exceeded_100' : maxPct >= 80 ? 'warning_80' : 'ok';

    return {
      mrrInr,
      aiUsed,
      aiLimit,
      aiPct,
      estimatedAiCostInr,
      waUsed,
      waLimit,
      waPct,
      estimatedWaCostInr,
      totalInfraCostInr,
      grossMarginInr,
      marginPct,
      unprofitable,
      alertLevel,
    };
  }

  private async verifyOperatorConfirmation(
    actor: SuperAdminActor,
    confirmPassword: string | undefined,
    actionLabel: string,
  ): Promise<void> {
    if (!confirmPassword || !confirmPassword.trim()) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        code: 'CONFIRM_PASSWORD_REQUIRED',
        message: `Super Admin password confirmation is required for destructive action: ${actionLabel}.`,
      });
    }
    const op = await this.userModel
      .findById(actor.userId)
      .select('passwordHash role isActive')
      .exec();
    if (!op || op.role !== 'super_admin' || !op.isActive) {
      throw new UnauthorizedException('Operator authority invalidated.');
    }
    if (!verifySecret(confirmPassword, op.passwordHash)) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        code: 'INVALID_CONFIRM_PASSWORD',
        message: `Operator verification failed for ${actionLabel}: incorrect Super Admin password.`,
      });
    }
  }

  async consumeTenantQuota(
    tenantId: string,
    resource: 'ai' | 'whatsapp',
    units = 1,
  ): Promise<{ used: number; limit: number; pct: number; warning80: boolean }> {
    if (!Types.ObjectId.isValid(tenantId)) {
      return { used: 0, limit: 999999, pct: 0, warning80: false };
    }
    const cleanUnits = Math.max(1, Math.round(units));
    const [tenant, config] = await Promise.all([
      this.tenantModel.findById(tenantId).exec(),
      this.ensureGlobalConfig(),
    ]);
    if (!tenant || tenant.isPlatformHq) {
      return { used: 0, limit: 999999, pct: 0, warning80: false };
    }

    const planSpec =
      config.planMatrix?.[tenant.plan] || PLAN_CATALOG[tenant.plan] || DEFAULT_PLAN_MATRIX.growth;
    const isAi = resource === 'ai';
    const limit = isAi
      ? (tenant.quotas?.maxMonthlyAiCalls ?? planSpec.maxMonthlyAiCalls ?? 2500)
      : (tenant.quotas?.maxMonthlyWhatsapp ?? planSpec.maxMonthlyWhatsapp ?? 5000);
    const currentUsed = isAi
      ? (tenant.quotas?.aiCallsUsed ?? 0)
      : (tenant.quotas?.whatsappUsed ?? 0);

    if (limit <= 0 || currentUsed + cleanUnits > limit) {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          error: 'Too Many Requests',
          code: 'QUOTA_EXCEEDED',
          resource,
          used: currentUsed,
          limit,
          message: `Monthly ${isAi ? 'SetuAI calls' : 'WhatsApp Cloud messages'} quota exceeded (${currentUsed}/${limit}). Upgrade your plan or contact Leadsetu HQ for an Add-on Quota Pack.`,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const costDelta = Number(
      (cleanUnits * (isAi ? AI_UNIT_COST_INR : WA_UNIT_COST_INR)).toFixed(2),
    );
    const incPayload = isAi
      ? { 'quotas.aiCallsUsed': cleanUnits, 'quotas.aiCostInr': costDelta }
      : { 'quotas.whatsappUsed': cleanUnits, 'quotas.whatsappCostInr': costDelta };

    await this.tenantModel
      .updateOne({ _id: tenant._id }, { $inc: incPayload })
      .exec();

    const nextUsed = currentUsed + cleanUnits;
    const pct = limit > 0 ? Math.round((nextUsed / limit) * 100) : 0;
    return {
      used: nextUsed,
      limit,
      pct,
      warning80: pct >= 80,
    };
  }

  async assertFeatureEnabled(tenantId: string, featureKey: FeatureKey): Promise<void> {
    const state = await this.getTenantEffectiveState(tenantId);
    if (!state) return;

    if (state.maintenanceMode) {
      throw new ServiceUnavailableException(
        state.maintenanceBanner || 'Leadsetu Cloud is currently in maintenance mode.',
      );
    }

    if (state.effectiveFeatures[featureKey] === false) {
      const spec = PLATFORM_FEATURE_CATALOG.find((f) => f.key === featureKey);
      const source = state.effectiveFeatureDetails[featureKey]?.source;
      const reason =
        source === 'kill_switch'
          ? 'temporarily disabled platform-wide by Leadsetu HQ kill-switch'
          : source === 'override_off'
            ? 'disabled for your workspace by Leadsetu Super Admin'
            : 'not enabled on your current workspace plan';
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        code: 'FEATURE_DISABLED_BY_SUPER_ADMIN',
        featureKey,
        message: `Access restricted: "${spec?.label || featureKey}" is ${reason}.`,
      });
    }
  }

  private resolveSeatLimit(tenant: TenantDocument, config: PlatformConfigDocument): number {
    if (typeof tenant.seatLimitOverride === 'number' && tenant.seatLimitOverride > 0) {
      return tenant.seatLimitOverride;
    }
    return (
      config.planMatrix?.[tenant.plan]?.seatLimit ||
      PLAN_CATALOG[tenant.plan]?.seatLimit ||
      12
    );
  }

  async getOverview() {
    const config = await this.ensureGlobalConfig();
    const customerFilter = { isPlatformHq: { $ne: true }, slug: { $ne: 'leadsetu-platform-hq' } };

    const [
      tenants,
      totalUsers,
      activeUsers,
      totalLeads,
      totalDeals,
      totalInvoices,
      totalTickets,
      recentAudits,
    ] = await Promise.all([
      this.tenantModel.find(customerFilter).sort({ createdAt: -1 }).exec(),
      this.userModel.countDocuments({ role: { $ne: 'super_admin' } }).exec(),
      this.userModel.countDocuments({ role: { $ne: 'super_admin' }, isActive: true }).exec(),
      this.connection.collection('leads').countDocuments().catch(() => 0),
      this.connection.collection('deals').countDocuments().catch(() => 0),
      this.connection.collection('invoices').countDocuments().catch(() => 0),
      this.connection.collection('tickets').countDocuments().catch(() => 0),
      this.platformAuditModel.find().sort({ createdAt: -1 }).limit(8).lean().exec(),
    ]);

    const userCountsByTenant = await this.userModel
      .aggregate<{ _id: Types.ObjectId; total: number; active: number }>([
        { $match: { role: { $ne: 'super_admin' } } },
        {
          $group: {
            _id: '$tenantId',
            total: { $sum: 1 },
            active: { $sum: { $cond: [{ $eq: ['$isActive', true] }, 1, 0] } },
          },
        },
      ])
      .exec();

    const userCountMap = new Map(
      userCountsByTenant.map((r) => [String(r._id), { total: r.total, active: r.active }]),
    );

    let activeCount = 0;
    let trialCount = 0;
    let suspendedCount = 0;
    let monthlyRecurringInr = 0;
    let totalSubscriptionBilledInr = 0;
    let totalGstCollectedInr = 0;

    const planCounts = { starter: 0, growth: 0, enterprise: 0 };
    const cityCounts = new Map<string, number>();

    for (const t of tenants) {
      if (t.status === 'active') activeCount++;
      else if (t.status === 'trial') trialCount++;
      else if (t.status === 'suspended') suspendedCount++;

      planCounts[t.plan] = (planCounts[t.plan] || 0) + 1;

      if (t.status === 'active') {
        const spec = config.planMatrix?.[t.plan] || PLAN_CATALOG[t.plan];
        monthlyRecurringInr += spec?.monthlyPrice || 0;
      }

      const city = (t.city || 'Delhi-NCR').trim();
      cityCounts.set(city, (cityCounts.get(city) || 0) + 1);

      for (const inv of t.subscriptionInvoices || []) {
        if (inv.status === 'paid') {
          totalSubscriptionBilledInr += inv.totalAmount || 0;
          totalGstCollectedInr +=
            (inv.cgstAmount || 0) + (inv.sgstAmount || 0) + (inv.igstAmount || 0);
        }
      }
    }

    let totalMonthlyAiCostInr = 0;
    let totalMonthlyWaCostInr = 0;
    let unprofitableTenantsCount = 0;
    let warning80Count = 0;
    let exceeded100Count = 0;

    const quotaWatchlist = tenants
      .map((t) => {
        const seats = userCountMap.get(t._id.toString()) || { total: 0, active: 0 };
        const seatLimit = this.resolveSeatLimit(t, config);
        const seatPct = seatLimit > 0 ? Math.round((seats.total / seatLimit) * 100) : 0;
        const tel = this.computeTenantCostTelemetry(t, config);
        totalMonthlyAiCostInr += tel.estimatedAiCostInr;
        totalMonthlyWaCostInr += tel.estimatedWaCostInr;
        if (tel.unprofitable) unprofitableTenantsCount++;
        if (tel.alertLevel === 'warning_80') warning80Count++;
        if (tel.alertLevel === 'exceeded_100') exceeded100Count++;

        return {
          id: t._id.toString(),
          accountId: t.accountId || '',
          name: t.name,
          plan: t.plan,
          status: t.status,
          seatsUsed: seats.total,
          seatLimit,
          seatPct,
          aiPct: tel.aiPct,
          aiUsed: tel.aiUsed,
          aiLimit: tel.aiLimit,
          waPct: tel.waPct,
          waUsed: tel.waUsed,
          waLimit: tel.waLimit,
          mrrInr: tel.mrrInr,
          estimatedAiCostInr: tel.estimatedAiCostInr,
          estimatedWaCostInr: tel.estimatedWaCostInr,
          totalInfraCostInr: tel.totalInfraCostInr,
          grossMarginInr: tel.grossMarginInr,
          marginPct: tel.marginPct,
          unprofitable: tel.unprofitable,
          alertLevel: tel.alertLevel,
          overrideCount: Object.keys(t.featureOverrides || {}).length,
        };
      })
      .sort(
        (a, b) =>
          Number(b.unprofitable) - Number(a.unprofitable) ||
          Math.max(b.seatPct, b.aiPct, b.waPct) - Math.max(a.seatPct, a.aiPct, a.waPct),
      )
      .slice(0, 8);

    const topCities = Array.from(cityCounts.entries())
      .map(([city, count]) => ({ city, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6);

    return {
      kpis: {
        totalTenants: tenants.length,
        activeTenants: activeCount,
        trialTenants: trialCount,
        suspendedTenants: suspendedCount,
        totalUsers,
        activeUsers,
        totalLeads,
        totalDeals,
        totalInvoices,
        totalTickets,
        monthlyRecurringInr,
        annualRunRateInr: monthlyRecurringInr * 12,
        totalSubscriptionBilledInr,
        totalGstCollectedInr,
        pendingTopupRequests: tenants.reduce(
          (sum, t) =>
            sum + (t.topupRequests || []).filter((r) => r.status === 'pending').length,
          0,
        ),
      },
      costTelemetry: {
        totalMonthlyAiCostInr: Number(totalMonthlyAiCostInr.toFixed(2)),
        totalMonthlyWaCostInr: Number(totalMonthlyWaCostInr.toFixed(2)),
        totalInfraCostInr: Number((totalMonthlyAiCostInr + totalMonthlyWaCostInr).toFixed(2)),
        unprofitableTenantsCount,
        warning80Count,
        exceeded100Count,
      },
      planBreakdown: planCounts,
      topCities,
      quotaWatchlist,
      recentTenants: tenants.slice(0, 5).map((t) => {
        const seats = userCountMap.get(t._id.toString()) || { total: 0, active: 0 };
        const raw = t.toObject() as unknown as { createdAt?: Date };
        return {
          id: t._id.toString(),
          accountId: t.accountId || '',
          name: t.name,
          plan: t.plan,
          status: t.status,
          city: t.city || 'Delhi-NCR',
          seatsUsed: seats.total,
          seatLimit: this.resolveSeatLimit(t, config),
          createdAt: raw.createdAt ? new Date(raw.createdAt).toISOString() : null,
        };
      }),
      recentAudits: recentAudits.map((a) => {
        const row = a as unknown as { _id: Types.ObjectId; createdAt?: Date };
        return {
          id: row._id.toString(),
          actorName: a.actorName,
          actorEmail: a.actorEmail,
          action: a.action,
          severity: a.severity,
          targetTenantName: a.targetTenantName || '',
          targetAccountId: a.targetAccountId || '',
          summary: a.summary,
          reason: a.reason || '',
          createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : new Date().toISOString(),
        };
      }),
      platformStatus: {
        maintenanceMode: config.maintenanceMode,
        allowNewSignups: config.allowNewSignups,
        globalKillSwitches: config.globalKillSwitches,
      },
    };
  }

  async listTenants(query: { search?: string; status?: string; plan?: string }) {
    const config = await this.ensureGlobalConfig();
    const filter: Record<string, unknown> = {
      isPlatformHq: { $ne: true },
      slug: { $ne: 'leadsetu-platform-hq' },
    };

    if (query.status && VALID_STATUSES.includes(query.status as (typeof VALID_STATUSES)[number])) {
      filter.status = query.status;
    }
    if (query.plan && VALID_PLANS.includes(query.plan as (typeof VALID_PLANS)[number])) {
      filter.plan = query.plan;
    }
    if (query.search?.trim()) {
      const rx = new RegExp(query.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ name: rx }, { accountId: rx }, { email: rx }, { gstin: rx }, { city: rx }];
    }

    const tenants = await this.tenantModel.find(filter).sort({ createdAt: -1 }).exec();
    const tenantIds = tenants.map((t) => t._id);

    const [userCounts, leadCounts, dealCounts] = await Promise.all([
      this.userModel
        .aggregate<{ _id: Types.ObjectId; total: number; active: number }>([
          { $match: { tenantId: { $in: tenantIds }, role: { $ne: 'super_admin' } } },
          {
            $group: {
              _id: '$tenantId',
              total: { $sum: 1 },
              active: { $sum: { $cond: [{ $eq: ['$isActive', true] }, 1, 0] } },
            },
          },
        ])
        .exec(),
      this.connection
        .collection('leads')
        .aggregate<{ _id: Types.ObjectId; count: number }>([
          { $match: { tenantId: { $in: tenantIds } } },
          { $group: { _id: '$tenantId', count: { $sum: 1 } } },
        ])
        .toArray()
        .catch(() => []),
      this.connection
        .collection('deals')
        .aggregate<{ _id: Types.ObjectId; count: number; wonRev: number }>([
          { $match: { tenantId: { $in: tenantIds } } },
          {
            $group: {
              _id: '$tenantId',
              count: { $sum: 1 },
              wonRev: { $sum: { $cond: [{ $eq: ['$stage', 'won'] }, '$value', 0] } },
            },
          },
        ])
        .toArray()
        .catch(() => []),
    ]);

    const userMap = new Map(userCounts.map((r) => [String(r._id), r]));
    const leadMap = new Map(leadCounts.map((r) => [String(r._id), r.count]));
    const dealMap = new Map(dealCounts.map((r) => [String(r._id), r]));

    return {
      data: tenants.map((t) => {
        const key = t._id.toString();
        const raw = t.toObject() as unknown as { createdAt?: Date };
        const users = userMap.get(key) || { total: 0, active: 0 };
        const deals = dealMap.get(key) || { count: 0, wonRev: 0 };
        const seatLimit = this.resolveSeatLimit(t, config);
        const overrideCount = Object.values(t.featureOverrides || {}).filter(
          (v) => typeof v === 'boolean',
        ).length;
        const effectiveFeatures = this.computeEffectiveFeatures(t, config);
        const planSpec = config.planMatrix?.[t.plan] || DEFAULT_PLAN_MATRIX[t.plan];
        const maxMonthlyAiCalls = t.quotas?.maxMonthlyAiCalls ?? planSpec.maxMonthlyAiCalls;
        const aiCallsUsed = t.quotas?.aiCallsUsed ?? 0;

        return {
          id: key,
          accountId: t.accountId || '',
          name: t.name,
          slug: t.slug,
          plan: t.plan,
          status: t.status,
          city: t.city || 'Delhi-NCR',
          gstin: t.gstin || '',
          email: t.email || '',
          phone: t.phone || '',
          seatsUsed: users.total,
          activeUsers: users.active,
          seatLimit,
          seatLimitOverride: t.seatLimitOverride ?? null,
          leadsCount: leadMap.get(key) || 0,
          dealsCount: deals.count,
          wonRevenueInr: deals.wonRev || 0,
          overrideCount,
          maskPhoneForAgents: Boolean(t.maskPhoneForAgents),
          blockAgentExport: t.blockAgentExport ?? true,
          aiEnabled: effectiveFeatures.aiScoring.enabled,
          aiWorkflowsEnabled: effectiveFeatures.aiWorkflows.enabled,
          aiSource: effectiveFeatures.aiScoring.source,
          aiPillars: {
            aiCreditRisk: Boolean(effectiveFeatures.aiCreditRisk?.enabled),
            aiVoiceCrm: Boolean(effectiveFeatures.aiVoiceCrm?.enabled),
            aiDealerDesk: Boolean(effectiveFeatures.aiDealerDesk?.enabled),
            aiCopilot: Boolean(effectiveFeatures.aiCopilot?.enabled),
          },
          maxMonthlyAiCalls,
          aiCallsUsed,
          aiBalanceRemaining: Math.max(0, maxMonthlyAiCalls - aiCallsUsed),
          trialEndsAt: t.trialEndsAt || '',
          suspensionReason: t.securityPolicy?.suspensionReason || '',
          createdAt: raw.createdAt ? new Date(raw.createdAt).toISOString() : null,
        };
      }),
      featureCatalog: PLATFORM_FEATURE_CATALOG,
    };
  }

  async getTenantDetail(tenantId: string) {
    if (!Types.ObjectId.isValid(tenantId)) {
      throw new NotFoundException('Tenant workspace not found.');
    }
    const config = await this.ensureGlobalConfig();
    const tenant = await this.tenantModel.findById(tenantId).exec();
    if (!tenant) {
      throw new NotFoundException('Tenant workspace not found.');
    }

    const tObjId = tenant._id as Types.ObjectId;
    const [members, leadsCount, dealsCount, invoicesCount, ticketsCount] = await Promise.all([
      this.userModel.find({ tenantId: tObjId }).sort({ createdAt: 1 }).exec(),
      this.connection.collection('leads').countDocuments({ tenantId: tObjId }).catch(() => 0),
      this.connection.collection('deals').countDocuments({ tenantId: tObjId }).catch(() => 0),
      this.connection.collection('invoices').countDocuments({ tenantId: tObjId }).catch(() => 0),
      this.connection.collection('tickets').countDocuments({ tenantId: tObjId }).catch(() => 0),
    ]);

    const raw = tenant.toObject() as unknown as { createdAt?: Date; updatedAt?: Date };
    const effectiveFeatures = this.computeEffectiveFeatures(tenant, config);
    const planSpec = config.planMatrix?.[tenant.plan] || DEFAULT_PLAN_MATRIX[tenant.plan];

    return {
      tenant: {
        id: tenant._id.toString(),
        accountId: tenant.accountId || '',
        name: tenant.name,
        slug: tenant.slug,
        plan: tenant.plan,
        status: tenant.status,
        city: tenant.city || 'Delhi-NCR',
        gstin: tenant.gstin || '',
        state: tenant.state || 'Delhi (07)',
        email: tenant.email || '',
        phone: tenant.phone || '',
        address: tenant.address || '',
        seatLimit: this.resolveSeatLimit(tenant, config),
        seatLimitOverride: tenant.seatLimitOverride ?? null,
        trialEndsAt: tenant.trialEndsAt || '',
        assignedManagerNote: tenant.assignedManagerNote || '',
        maskPhoneForAgents: Boolean(tenant.maskPhoneForAgents),
        blockAgentExport: tenant.blockAgentExport ?? true,
        featureOverrides: tenant.featureOverrides || {},
        effectiveFeatures,
        quotas: {
          maxMonthlyAiCalls: tenant.quotas?.maxMonthlyAiCalls ?? planSpec.maxMonthlyAiCalls,
          maxMonthlyWhatsapp: tenant.quotas?.maxMonthlyWhatsapp ?? planSpec.maxMonthlyWhatsapp,
          aiCallsUsed: tenant.quotas?.aiCallsUsed ?? 0,
          whatsappUsed: tenant.quotas?.whatsappUsed ?? 0,
          maxStorageMb: tenant.quotas?.maxStorageMb ?? planSpec.maxStorageMb,
          aiCostInr: tenant.quotas?.aiCostInr ?? 0,
          whatsappCostInr: tenant.quotas?.whatsappCostInr ?? 0,
          addonAiCalls: tenant.quotas?.addonAiCalls ?? 0,
          addonWhatsapp: tenant.quotas?.addonWhatsapp ?? 0,
          lastMeterResetAt: tenant.quotas?.lastMeterResetAt || '',
        },
        costTelemetry: this.computeTenantCostTelemetry(tenant, config),
        sessionVersion: tenant.sessionVersion ?? 1,
        dpdpRetention: tenant.dpdpRetention || {
          softDeletedAt: '',
          purgeScheduledAt: '',
          purgedAt: '',
          deletionReason: '',
          requestedByEmail: '',
        },
        securityPolicy: {
          enforcePhoneMasking: Boolean(
            tenant.securityPolicy?.enforcePhoneMasking ?? tenant.maskPhoneForAgents,
          ),
          lockAgentExport: Boolean(
            tenant.securityPolicy?.lockAgentExport ?? tenant.blockAgentExport ?? true,
          ),
          requireStrongPassword: tenant.securityPolicy?.requireStrongPassword ?? true,
          sessionTtlHours: tenant.securityPolicy?.sessionTtlHours ?? 24,
          allowImpersonation: tenant.securityPolicy?.allowImpersonation ?? true,
          ipAllowlist: tenant.securityPolicy?.ipAllowlist ?? [],
          suspensionReason: tenant.securityPolicy?.suspensionReason || '',
          suspendedAt: tenant.securityPolicy?.suspendedAt || '',
        },
        subscriptionInvoices: (tenant.subscriptionInvoices || []).slice().reverse(),
        createdAt: raw.createdAt ? new Date(raw.createdAt).toISOString() : null,
      },
      usage: {
        seatsUsed: members.length,
        activeUsers: members.filter((m) => m.isActive).length,
        leadsCount,
        dealsCount,
        invoicesCount,
        ticketsCount,
      },
      members: members.map((m) => {
        const mRaw = m.toObject() as unknown as { createdAt?: Date };
        return {
          id: m._id.toString(),
          userCode: m.userCode || '',
          name: m.name,
          email: m.email,
          phone: m.phone || '',
          role: m.role,
          departmentPreset: m.departmentPreset || 'sales',
          permissions: m.permissions || [],
          isActive: m.isActive,
          territory: m.territory || '',
          monthlyTarget: m.monthlyTarget || 0,
          maskPhones: Boolean(m.maskPhones),
          lastLoginAt: m.lastLoginAt ? new Date(m.lastLoginAt).toISOString() : null,
          createdAt: mRaw.createdAt ? new Date(mRaw.createdAt).toISOString() : null,
        };
      }),
      featureCatalog: PLATFORM_FEATURE_CATALOG,
    };
  }

  async updateTenantGovernance(
    actor: SuperAdminActor,
    tenantId: string,
    dto: UpdateTenantGovernanceDto,
    ipAddress = '',
  ) {
    if (!Types.ObjectId.isValid(tenantId)) {
      throw new NotFoundException('Tenant workspace not found.');
    }
    const tenant = await this.tenantModel.findById(tenantId).exec();
    if (!tenant) {
      throw new NotFoundException('Tenant workspace not found.');
    }
    if (tenant.isPlatformHq || tenant.slug === 'leadsetu-platform-hq') {
      throw new ForbiddenException('Platform HQ system tenant cannot be suspended or downgraded.');
    }

    const changes: string[] = [];

    if (dto.plan && VALID_PLANS.includes(dto.plan) && dto.plan !== tenant.plan) {
      changes.push(`plan: ${tenant.plan} -> ${dto.plan}`);
      tenant.plan = dto.plan;
    }

    if (dto.status && VALID_STATUSES.includes(dto.status) && dto.status !== tenant.status) {
      if (dto.status === 'suspended') {
        if (!dto.suspensionReason?.trim()) {
          throw new BadRequestException(
            'A suspension reason is mandatory for compliance and audit logs.',
          );
        }
        await this.verifyOperatorConfirmation(
          actor,
          dto.confirmPassword,
          `Suspending workspace ${tenant.name}`,
        );
      }
      changes.push(`status: ${tenant.status} -> ${dto.status}`);
      tenant.status = dto.status;
      if (!tenant.securityPolicy) {
        tenant.securityPolicy = {
          enforcePhoneMasking: false,
          lockAgentExport: true,
          requireStrongPassword: true,
          sessionTtlHours: 24,
          allowImpersonation: true,
          ipAllowlist: [],
          suspensionReason: '',
          suspendedAt: '',
        };
      }
      if (dto.status === 'suspended') {
        tenant.securityPolicy.suspensionReason = dto.suspensionReason!.trim();
        tenant.securityPolicy.suspendedAt = new Date().toISOString();
      } else {
        tenant.securityPolicy.suspensionReason = '';
        tenant.securityPolicy.suspendedAt = '';
      }
    }

    if (dto.seatLimitOverride !== undefined) {
      if (dto.seatLimitOverride !== null && dto.seatLimitOverride < 1) {
        throw new BadRequestException('Seat limit override must be >= 1 or null.');
      }
      tenant.seatLimitOverride = dto.seatLimitOverride;
      changes.push(`seatLimitOverride -> ${dto.seatLimitOverride ?? 'plan default'}`);
    }

    if (dto.extendTrialDays && dto.extendTrialDays > 0) {
      const baseMs = tenant.trialEndsAt
        ? Math.max(Date.now(), new Date(tenant.trialEndsAt).getTime())
        : Date.now();
      tenant.trialEndsAt = new Date(
        baseMs + dto.extendTrialDays * 86400000,
      ).toISOString();
      changes.push(`trial extended +${dto.extendTrialDays}d`);
    } else if (dto.trialEndsAt !== undefined) {
      tenant.trialEndsAt = dto.trialEndsAt;
    }

    if (dto.assignedManagerNote !== undefined) {
      tenant.assignedManagerNote = dto.assignedManagerNote.trim();
    }

    if (dto.featureOverrides) {
      const nextOverrides: Record<string, boolean> = {
        ...(tenant.featureOverrides || {}),
      };
      for (const [k, val] of Object.entries(dto.featureOverrides)) {
        if (val === null) {
          delete nextOverrides[k];
        } else if (typeof val === 'boolean') {
          nextOverrides[k] = val;
        }
      }
      tenant.featureOverrides = nextOverrides;
      tenant.markModified('featureOverrides');
      changes.push('featureOverrides updated');
    }

    if (dto.quotas) {
      const current = tenant.quotas || {
        maxMonthlyAiCalls: 2500,
        maxMonthlyWhatsapp: 5000,
        aiCallsUsed: 0,
        whatsappUsed: 0,
        maxStorageMb: 2048,
      };
      if (typeof dto.quotas.maxMonthlyAiCalls === 'number') {
        current.maxMonthlyAiCalls = Math.max(0, dto.quotas.maxMonthlyAiCalls);
      }
      if (typeof dto.quotas.maxMonthlyWhatsapp === 'number') {
        current.maxMonthlyWhatsapp = Math.max(0, dto.quotas.maxMonthlyWhatsapp);
      }
      if (typeof dto.quotas.maxStorageMb === 'number') {
        current.maxStorageMb = Math.max(128, dto.quotas.maxStorageMb);
      }
      if (typeof dto.quotas.aiCallsUsed === 'number') {
        current.aiCallsUsed = Math.max(0, Math.round(dto.quotas.aiCallsUsed));
      }
      if (dto.quotas.resetUsageCounters) {
        current.aiCallsUsed = 0;
        current.whatsappUsed = 0;
        current.aiCostInr = 0;
        current.whatsappCostInr = 0;
        current.lastMeterResetAt = new Date().toISOString();
      }
      tenant.quotas = current;
      tenant.markModified('quotas');
      changes.push('quotas updated');
    }

    if (dto.securityPolicy) {
      const pol = tenant.securityPolicy || {
        enforcePhoneMasking: false,
        lockAgentExport: true,
        requireStrongPassword: true,
        sessionTtlHours: 24,
        allowImpersonation: true,
        ipAllowlist: [],
        suspensionReason: '',
        suspendedAt: '',
      };
      if (typeof dto.securityPolicy.enforcePhoneMasking === 'boolean') {
        pol.enforcePhoneMasking = dto.securityPolicy.enforcePhoneMasking;
        tenant.maskPhoneForAgents = dto.securityPolicy.enforcePhoneMasking;
      }
      if (typeof dto.securityPolicy.lockAgentExport === 'boolean') {
        pol.lockAgentExport = dto.securityPolicy.lockAgentExport;
        tenant.blockAgentExport = dto.securityPolicy.lockAgentExport;
      }
      if (typeof dto.securityPolicy.requireStrongPassword === 'boolean') {
        pol.requireStrongPassword = dto.securityPolicy.requireStrongPassword;
      }
      if (typeof dto.securityPolicy.sessionTtlHours === 'number') {
        pol.sessionTtlHours = Math.max(1, Math.min(720, dto.securityPolicy.sessionTtlHours));
      }
      if (typeof dto.securityPolicy.allowImpersonation === 'boolean') {
        pol.allowImpersonation = dto.securityPolicy.allowImpersonation;
      }
      if (Array.isArray(dto.securityPolicy.ipAllowlist)) {
        pol.ipAllowlist = dto.securityPolicy.ipAllowlist
          .map((s) => s.trim())
          .filter(Boolean);
      }
      tenant.securityPolicy = pol;
      tenant.markModified('securityPolicy');
      changes.push('securityPolicy updated');
    }

    await tenant.save();

    await this.recordAudit(actor, {
      action: 'tenant.governance_updated',
      severity: dto.status === 'suspended' ? 'critical' : 'warning',
      targetTenant: tenant,
      summary: `Updated governance for ${tenant.name} (#${tenant.accountId}): ${changes.join(', ') || 'profile note saved'}`,
      reason: dto.reason || dto.suspensionReason || '',
      ipAddress,
      metadata: { changes },
    });

    return this.getTenantDetail(tenantId);
  }

  async updateTenantUserRbac(
    actor: SuperAdminActor,
    tenantId: string,
    userId: string,
    dto: UpdateTenantUserRbacDto,
    ipAddress = '',
  ) {
    if (!Types.ObjectId.isValid(tenantId) || !Types.ObjectId.isValid(userId)) {
      throw new NotFoundException('User or tenant not found.');
    }
    const tenant = await this.tenantModel.findById(tenantId).exec();
    const user = await this.userModel
      .findOne({ _id: new Types.ObjectId(userId), tenantId: new Types.ObjectId(tenantId) })
      .exec();

    if (!tenant || !user) {
      throw new NotFoundException('User not found inside the specified tenant workspace.');
    }
    if (user.role === 'super_admin') {
      throw new ForbiddenException('Use HQ Operators endpoint to manage Super Admins.');
    }

    const diffs: string[] = [];
    if (dto.role && VALID_ROLES.includes(dto.role) && dto.role !== user.role) {
      diffs.push(`role: ${user.role} -> ${dto.role}`);
      user.role = dto.role;
    }
    if (dto.departmentPreset) {
      user.departmentPreset = dto.departmentPreset;
      diffs.push(`dept: ${dto.departmentPreset}`);
    }
    if (Array.isArray(dto.permissions)) {
      user.permissions = dto.permissions;
      diffs.push(`permissions (${dto.permissions.length})`);
    }
    if (typeof dto.isActive === 'boolean' && dto.isActive !== user.isActive) {
      user.isActive = dto.isActive;
      if (!dto.isActive) user.refreshTokenHash = null;
      diffs.push(`isActive -> ${dto.isActive}`);
    }
    if (typeof dto.maskPhones === 'boolean') {
      user.maskPhones = dto.maskPhones;
      diffs.push(`maskPhones -> ${dto.maskPhones}`);
    }
    if (dto.territory !== undefined) {
      user.territory = dto.territory.trim();
    }
    if (dto.revokeSessions) {
      user.refreshTokenHash = null;
      user.sessionVersion = (user.sessionVersion ?? 1) + 1;
      diffs.push('sessions force-revoked (JWT + refresh invalidated)');
    }

    await user.save();

    await this.recordAudit(actor, {
      action: 'tenant_user.rbac_updated',
      severity: dto.isActive === false || dto.revokeSessions ? 'warning' : 'info',
      targetTenant: tenant,
      summary: `Modified RBAC for ${user.name} (${user.email}) in ${tenant.name}: ${diffs.join(', ') || 'metadata synced'}`,
      reason: dto.reason || '',
      ipAddress,
      metadata: { targetUserId: user._id.toString(), diffs },
    });

    return this.getTenantDetail(tenantId);
  }

  async impersonateTenant(
    actor: SuperAdminActor,
    tenantId: string,
    dto: ImpersonateTenantDto,
    ipAddress = '',
  ) {
    if (!dto.reason || dto.reason.trim().length < 5) {
      throw new BadRequestException(
        'An explicit audit reason (min 5 characters) is mandatory for support impersonation.',
      );
    }

    const config = await this.ensureGlobalConfig();
    if (!config.globalKillSwitches?.impersonationEnabled) {
      throw new ForbiddenException(
        'Support impersonation is currently disabled by Global Security Policy.',
      );
    }

    if (!Types.ObjectId.isValid(tenantId)) {
      throw new NotFoundException('Tenant workspace not found.');
    }
    const tenant = await this.tenantModel.findById(tenantId).exec();
    if (!tenant) {
      throw new NotFoundException('Tenant workspace not found.');
    }
    if (tenant.securityPolicy?.allowImpersonation === false) {
      throw new ForbiddenException(
        'This tenant workspace has locked/disabled Support Impersonation in its security policy.',
      );
    }

    let targetUser: UserDocument | null = null;
    if (dto.targetUserId && Types.ObjectId.isValid(dto.targetUserId)) {
      targetUser = await this.userModel
        .findOne({ _id: new Types.ObjectId(dto.targetUserId), tenantId: tenant._id })
        .exec();
    }
    if (!targetUser) {
      targetUser = await this.userModel
        .findOne({ tenantId: tenant._id, isActive: true })
        .sort({ role: -1, createdAt: 1 })
        .exec();
    }
    if (!targetUser) {
      throw new NotFoundException('No active user found inside this tenant workspace.');
    }

    const ttlMinutes = Math.max(
      5,
      Math.min(120, config.securityPolicies?.impersonationMaxMinutes || 30),
    );
    const accessSecret =
      this.configService.get<string>('JWT_SECRET') ||
      'leadsetu_super_secret_access_key_2026_delhi_ncr';

    const accessToken = await this.jwtService.signAsync(
      {
        sub: targetUser._id.toString(),
        email: targetUser.email,
        role: targetUser.role,
        tenantId: tenant._id.toString(),
        isImpersonation: true,
        impersonatorId: actor.userId,
        impersonatorEmail: actor.email,
        impersonationReason: dto.reason.trim(),
      },
      {
        secret: accessSecret,
        expiresIn: `${ttlMinutes}m`,
      },
    );

    await this.recordAudit(actor, {
      action: 'tenant.impersonation_started',
      severity: 'critical',
      targetTenant: tenant,
      summary: `Support Impersonation started into ${tenant.name} (#${tenant.accountId}) as ${targetUser.email}`,
      reason: dto.reason.trim(),
      ipAddress,
      metadata: {
        targetUserId: targetUser._id.toString(),
        ttlMinutes,
      },
    });

    const effectiveState = await this.getTenantEffectiveState(tenant._id.toString()).catch(
      () => null,
    );

    return {
      accessToken,
      impersonation: {
        isImpersonation: true,
        actorEmail: actor.email,
        reason: dto.reason.trim(),
        expiresInMinutes: ttlMinutes,
      },
      user: {
        id: targetUser._id.toString(),
        userCode: targetUser.userCode || '',
        tenantId: tenant._id.toString(),
        name: targetUser.name,
        email: targetUser.email,
        phone: targetUser.phone || '',
        role: targetUser.role,
        departmentPreset: targetUser.departmentPreset || 'sales',
        permissions: targetUser.permissions || [],
        maskPhones: Boolean(targetUser.maskPhones),
      },
      tenant: {
        id: tenant._id.toString(),
        accountId: tenant.accountId || '',
        name: tenant.name,
        slug: tenant.slug,
        plan: tenant.plan,
        status: tenant.status,
        city: tenant.city || 'Delhi-NCR',
        gstin: tenant.gstin || '',
        state: tenant.state || 'Delhi (07)',
        phone: tenant.phone || '',
        email: tenant.email || '',
        address: tenant.address || '',
        maskPhoneForAgents: Boolean(
          tenant.maskPhoneForAgents || effectiveState?.forcePhoneMasking,
        ),
        blockAgentExport: effectiveState?.blockCsvExport ?? (tenant.blockAgentExport ?? true),
        effectiveFeatures: effectiveState?.effectiveFeatures,
        effectiveFeatureDetails: effectiveState?.effectiveFeatureDetails,
        globalKillSwitches: effectiveState?.globalKillSwitches,
        maintenanceMode: effectiveState?.maintenanceMode ?? false,
      },
    };
  }

  async getPolicies() {
    const config = await this.ensureGlobalConfig();
    return {
      config: {
        maintenanceMode: config.maintenanceMode,
        maintenanceBanner: config.maintenanceBanner,
        allowNewSignups: config.allowNewSignups,
        defaultTrialDays: config.defaultTrialDays,
        planMatrix: config.planMatrix || DEFAULT_PLAN_MATRIX,
        globalKillSwitches: config.globalKillSwitches || DEFAULT_GLOBAL_KILL_SWITCHES,
        securityPolicies: config.securityPolicies || DEFAULT_SECURITY_POLICIES,
        updatedByEmail: config.updatedByEmail || '',
      },
      featureCatalog: PLATFORM_FEATURE_CATALOG,
    };
  }

  async updatePolicies(
    actor: SuperAdminActor,
    dto: UpdatePlatformPoliciesDto,
    ipAddress = '',
  ) {
    const config = await this.ensureGlobalConfig();
    const sections: string[] = [];

    const maintenanceChanged =
      typeof dto.maintenanceMode === 'boolean' &&
      dto.maintenanceMode !== Boolean(config.maintenanceMode);
    const currentKills = config.globalKillSwitches || DEFAULT_GLOBAL_KILL_SWITCHES;
    const killSwitchChanged =
      Boolean(dto.globalKillSwitches) &&
      Object.entries(dto.globalKillSwitches || {}).some(
        ([k, v]) =>
          typeof v === 'boolean' &&
          v !== Boolean(currentKills[k as keyof typeof currentKills]),
      );

    if (maintenanceChanged || killSwitchChanged) {
      await this.verifyOperatorConfirmation(
        actor,
        dto.confirmPassword,
        maintenanceChanged
          ? `Toggling Platform Maintenance Mode (${dto.maintenanceMode ? 'ON' : 'OFF'})`
          : 'Flipping Global Platform Kill-Switch',
      );
    }

    if (typeof dto.maintenanceMode === 'boolean') {
      config.maintenanceMode = dto.maintenanceMode;
      sections.push(`maintenanceMode -> ${dto.maintenanceMode}`);
    }
    if (dto.maintenanceBanner !== undefined) {
      config.maintenanceBanner = dto.maintenanceBanner.trim();
    }
    if (typeof dto.allowNewSignups === 'boolean') {
      config.allowNewSignups = dto.allowNewSignups;
      sections.push(`allowNewSignups -> ${dto.allowNewSignups}`);
    }
    if (typeof dto.defaultTrialDays === 'number') {
      config.defaultTrialDays = Math.max(1, Math.min(90, dto.defaultTrialDays));
      sections.push(`defaultTrialDays -> ${config.defaultTrialDays}`);
    }
    if (dto.globalKillSwitches) {
      config.globalKillSwitches = {
        ...(config.globalKillSwitches || DEFAULT_GLOBAL_KILL_SWITCHES),
        ...dto.globalKillSwitches,
      };
      config.markModified('globalKillSwitches');
      sections.push('globalKillSwitches');
    }
    if (dto.securityPolicies) {
      config.securityPolicies = {
        ...(config.securityPolicies || DEFAULT_SECURITY_POLICIES),
        ...dto.securityPolicies,
      };
      config.markModified('securityPolicies');
      sections.push('securityPolicies');
    }
    if (dto.planMatrix) {
      const merged = { ...(config.planMatrix || DEFAULT_PLAN_MATRIX) };
      for (const planKey of VALID_PLANS) {
        if (dto.planMatrix[planKey]) {
          merged[planKey] = {
            ...merged[planKey],
            ...dto.planMatrix[planKey]!,
            features: {
              ...(merged[planKey]?.features || DEFAULT_PLAN_MATRIX[planKey].features),
              ...(dto.planMatrix[planKey]?.features || {}),
            },
          };
        }
      }
      config.planMatrix = merged;
      config.markModified('planMatrix');
      sections.push('planMatrix');
    }

    config.updatedByEmail = actor.email;
    await config.save();

    await this.recordAudit(actor, {
      action: 'platform.policies_updated',
      severity: dto.maintenanceMode || dto.globalKillSwitches ? 'critical' : 'warning',
      summary: `Updated Global Platform Policy (${sections.join(', ') || 'settings saved'})`,
      reason: dto.reason || '',
      ipAddress,
    });

    return this.getPolicies();
  }

  private calculateGstSplit(taxableInr: number, buyerState: string) {
    const cleanBase = Math.max(0, Math.round(taxableInr));
    const isDelhiIntraState =
      buyerState.toLowerCase().includes('delhi') || buyerState.includes('07');
    if (isDelhiIntraState) {
      const cgstAmount = Math.round(cleanBase * 0.09);
      const sgstAmount = Math.round(cleanBase * 0.09);
      return {
        baseAmount: cleanBase,
        cgstAmount,
        sgstAmount,
        igstAmount: 0,
        totalAmount: cleanBase + cgstAmount + sgstAmount,
      };
    }
    const igstAmount = Math.round(cleanBase * 0.18);
    return {
      baseAmount: cleanBase,
      cgstAmount: 0,
      sgstAmount: 0,
      igstAmount,
      totalAmount: cleanBase + igstAmount,
    };
  }

  private getInvoiceMonthKey(isoDate: string): string {
    return String(isoDate || '').slice(0, 7);
  }

  private escapeCsvCell(value: unknown): string {
    const str = String(value ?? '');
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }

  async getBillingLedger(month?: string) {
    const [tenants, coupons, partners, config] = await Promise.all([
      this.tenantModel
        .find({ isPlatformHq: { $ne: true }, slug: { $ne: 'leadsetu-platform-hq' } })
        .exec(),
      this.couponModel.find().sort({ createdAt: -1 }).lean().exec(),
      this.partnerModel.find().sort({ totalAttributedRevenueInr: -1, createdAt: -1 }).lean().exec(),
      this.ensureGlobalConfig(),
    ]);

    const normalizedMonth = month && /^\d{4}-\d{2}$/.test(month.trim()) ? month.trim() : '';
    const dunningPolicy = config.dunningPolicy || DEFAULT_DUNNING_POLICY;

    const rows: Array<Record<string, unknown>> = [];
    let paidRevenueInr = 0;
    let totalGstInr = 0;
    let cgstTotalInr = 0;
    let sgstTotalInr = 0;
    let igstTotalInr = 0;
    let tdsTotalInr = 0;
    let refundedInr = 0;
    let paidCount = 0;
    let trialCount = 0;
    let complimentaryCount = 0;

    const nowMs = Date.now();
    const trialWatchlist: Array<Record<string, unknown>> = [];

    for (const t of tenants) {
      if (t.status === 'trial') {
        const trialEndsAt =
          t.trialEndsAt ||
          new Date(
            new Date((t as unknown as { createdAt?: Date }).createdAt || Date.now()).getTime() +
              (config.defaultTrialDays || 14) * 86_400_000,
          ).toISOString();
        const msLeft = new Date(trialEndsAt).getTime() - nowMs;
        const daysRemaining = Math.ceil(msLeft / 86_400_000);
        const graceDays = dunningPolicy.gracePeriodDays ?? 3;
        const health =
          daysRemaining > 3
            ? 'healthy'
            : daysRemaining >= 0
              ? 'expiring_soon'
              : Math.abs(daysRemaining) <= graceDays
                ? 'in_grace'
                : 'overdue';
        trialWatchlist.push({
          tenantId: t._id.toString(),
          accountId: t.accountId || '',
          tenantName: t.name,
          plan: t.plan,
          email: t.email || '',
          phone: t.phone || '',
          trialEndsAt,
          daysRemaining,
          health,
          autoAction: dunningPolicy.autoActionOnExpiry,
        });
      }

      for (const inv of t.subscriptionInvoices || []) {
        if (normalizedMonth && this.getInvoiceMonthKey(inv.issuedAt) !== normalizedMonth) {
          continue;
        }
        const rawInv = inv as unknown as {
          toObject?: () => Record<string, unknown>;
        };
        const invRecord =
          typeof rawInv.toObject === 'function'
            ? rawInv.toObject()
            : (inv as unknown as Record<string, unknown>);
        if (inv.status === 'paid') {
          paidRevenueInr += inv.totalAmount || 0;
          cgstTotalInr += inv.cgstAmount || 0;
          sgstTotalInr += inv.sgstAmount || 0;
          igstTotalInr += inv.igstAmount || 0;
          totalGstInr +=
            (inv.cgstAmount || 0) + (inv.sgstAmount || 0) + (inv.igstAmount || 0);
          tdsTotalInr += Number(inv.tdsDeducted || 0);
          paidCount++;
        } else if (inv.status === 'refunded' || inv.status === 'voided') {
          refundedInr += inv.totalAmount || 0;
        } else if (inv.status === 'complimentary_grant') {
          complimentaryCount++;
          trialCount++;
        } else {
          trialCount++;
        }

        rows.push({
          ...invRecord,
          tenantId: t._id.toString(),
          accountId: t.accountId || '',
          tenantName: t.name,
        });
      }
    }

    rows.sort((a, b) =>
      String(b.issuedAt || '').localeCompare(String(a.issuedAt || '')),
    );
    trialWatchlist.sort((a, b) => Number(a.daysRemaining) - Number(b.daysRemaining));

    const pendingPartnerPayoutInr = partners.reduce(
      (sum, p) => sum + Math.max(0, (p.totalCommissionEarnedInr || 0) - (p.totalCommissionPaidInr || 0)),
      0,
    );

    const b2bRegisteredCount = rows.filter(
      (r) => r.status === 'paid' && Boolean(String(r.buyerGstin || '').trim()),
    ).length;
    const b2cCount = rows.filter(
      (r) => r.status === 'paid' && !String(r.buyerGstin || '').trim(),
    ).length;

    return {
      monthFilter: normalizedMonth || 'all',
      summary: {
        paidRevenueInr,
        totalGstInr,
        cgstTotalInr,
        sgstTotalInr,
        igstTotalInr,
        tdsTotalInr,
        refundedInr,
        paidCount,
        trialCount,
        complimentaryCount,
        totalInvoices: rows.length,
        pendingPartnerPayoutInr,
        b2bRegisteredCount,
        b2cCount,
      },
      data: rows,
      coupons: coupons.map((c) => ({
        id: c._id.toString(),
        code: c.code,
        discountType: c.discountType,
        discountValue: c.discountValue,
        applicablePlans: c.applicablePlans || [],
        billingCycle: c.billingCycle || 'all',
        maxRedemptions: c.maxRedemptions || 0,
        redemptionsCount: c.redemptionsCount || 0,
        totalDiscountGivenInr: c.totalDiscountGivenInr || 0,
        expiresAt: c.expiresAt || '',
        isActive: Boolean(c.isActive),
        description: c.description || '',
      })),
      partners: partners.map((p) => ({
        id: p._id.toString(),
        partnerCode: p.partnerCode,
        name: p.name,
        email: p.email,
        phone: p.phone || '',
        city: p.city || 'Delhi-NCR',
        commissionRatePct: p.commissionRatePct || 15,
        totalAttributedRevenueInr: p.totalAttributedRevenueInr || 0,
        totalCommissionEarnedInr: p.totalCommissionEarnedInr || 0,
        totalCommissionPaidInr: p.totalCommissionPaidInr || 0,
        pendingPayoutInr: Math.max(
          0,
          (p.totalCommissionEarnedInr || 0) - (p.totalCommissionPaidInr || 0),
        ),
        referredTenantsCount: p.referredTenantsCount || 0,
        isActive: Boolean(p.isActive),
      })),
      dunningPolicy,
      trialWatchlist,
    };
  }

  async issueTenantSubscription(
    actor: SuperAdminActor,
    tenantId: string,
    dto: IssueTenantSubscriptionDto,
    ipAddress = '',
  ) {
    if (!VALID_PLANS.includes(dto.plan)) {
      throw new BadRequestException('Invalid subscription plan.');
    }
    const tenant = await this.tenantModel.findById(tenantId).exec();
    if (!tenant || tenant.isPlatformHq) {
      throw new NotFoundException('Customer workspace not found.');
    }

    const config = await this.ensureGlobalConfig();
    const planSpec =
      config.planMatrix?.[dto.plan] || DEFAULT_PLAN_MATRIX[dto.plan];
    const cycle: 'monthly' | 'annual' = dto.billingCycle === 'annual' ? 'annual' : 'monthly';

    const listBaseInr =
      typeof dto.customBaseAmount === 'number' && Number.isFinite(dto.customBaseAmount) && dto.customBaseAmount >= 0
        ? Math.round(dto.customBaseAmount)
        : cycle === 'annual'
          ? Math.round(planSpec.annualPrice || 0)
          : Math.round(planSpec.monthlyPrice || 0);

    let discountAmount = 0;
    let appliedCouponCode = '';
    if (dto.couponCode?.trim() && dto.grantMode === 'paid_offline') {
      const codeUpper = dto.couponCode.trim().toUpperCase();
      const coupon = await this.couponModel.findOne({ code: codeUpper }).exec();
      if (!coupon || !coupon.isActive) {
        throw new BadRequestException(`Coupon ${codeUpper} is invalid or inactive.`);
      }
      if (coupon.expiresAt && new Date(coupon.expiresAt).getTime() < Date.now()) {
        throw new BadRequestException(`Coupon ${codeUpper} has expired.`);
      }
      if (coupon.maxRedemptions > 0 && coupon.redemptionsCount >= coupon.maxRedemptions) {
        throw new BadRequestException(`Coupon ${codeUpper} has reached max redemptions.`);
      }
      if (
        coupon.applicablePlans?.length > 0 &&
        !coupon.applicablePlans.includes(dto.plan)
      ) {
        throw new BadRequestException(`Coupon ${codeUpper} is not valid for ${dto.plan} plan.`);
      }
      if (coupon.billingCycle !== 'all' && coupon.billingCycle !== cycle) {
        throw new BadRequestException(`Coupon ${codeUpper} only applies to ${coupon.billingCycle} billing.`);
      }

      discountAmount =
        coupon.discountType === 'percent'
          ? Math.round((listBaseInr * coupon.discountValue) / 100)
          : Math.round(coupon.discountValue);
      discountAmount = Math.min(listBaseInr, Math.max(0, discountAmount));
      appliedCouponCode = coupon.code;

      coupon.redemptionsCount = (coupon.redemptionsCount || 0) + 1;
      coupon.totalDiscountGivenInr = (coupon.totalDiscountGivenInr || 0) + discountAmount;
      await coupon.save();
    }

    const netTaxable = dto.grantMode === 'complimentary_grant'
      ? 0
      : Math.max(0, listBaseInr - discountAmount);

    const buyerState = tenant.state?.trim() || 'Uttar Pradesh (09)';
    const gstBreakdown = this.calculateGstSplit(netTaxable, buyerState);

    let appliedPartnerCode = '';
    if (dto.partnerCode?.trim()) {
      const pCode = dto.partnerCode.trim().toUpperCase();
      const partner = await this.partnerModel.findOne({ partnerCode: pCode, isActive: true }).exec();
      if (!partner) {
        throw new BadRequestException(`Active channel partner ${pCode} not found.`);
      }
      appliedPartnerCode = partner.partnerCode;
      if (dto.grantMode === 'paid_offline' && gstBreakdown.baseAmount > 0) {
        const earned = Math.round((gstBreakdown.baseAmount * (partner.commissionRatePct || 15)) / 100);
        partner.totalAttributedRevenueInr =
          (partner.totalAttributedRevenueInr || 0) + gstBreakdown.baseAmount;
        partner.totalCommissionEarnedInr = (partner.totalCommissionEarnedInr || 0) + earned;
        partner.referredTenantsCount = (partner.referredTenantsCount || 0) + 1;
        await partner.save();
      }
    }

    const now = new Date();
    const periodEnd = new Date(now);
    if (cycle === 'annual') {
      periodEnd.setFullYear(periodEnd.getFullYear() + 1);
    } else {
      periodEnd.setMonth(periodEnd.getMonth() + 1);
    }

    const invoiceCount = (tenant.subscriptionInvoices?.length || 0) + 1;
    const fySuffix = String(now.getFullYear()).slice(-2) + '-' + String(now.getFullYear() + 1).slice(-2);
    const invoiceNumber = `LS-SAAS-${fySuffix}/${tenant.accountId || '00000'}/${String(invoiceCount).padStart(3, '0')}`;

    const invoice: SubscriptionInvoiceRecord = {
      id: `subinv_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      invoiceNumber,
      plan: dto.plan,
      planName: planSpec.name || `Leadsetu ${dto.plan.toUpperCase()}`,
      billingCycle: cycle,
      seatsIncluded: tenant.seatLimitOverride ?? planSpec.seatLimit,
      baseAmount: gstBreakdown.baseAmount,
      gstRate: 18,
      cgstAmount: gstBreakdown.cgstAmount,
      sgstAmount: gstBreakdown.sgstAmount,
      igstAmount: gstBreakdown.igstAmount,
      totalAmount: gstBreakdown.totalAmount,
      status: dto.grantMode === 'complimentary_grant' ? 'complimentary_grant' : 'paid',
      discountAmount,
      couponCode: appliedCouponCode,
      partnerCode: appliedPartnerCode,
      tdsDeducted: Math.max(0, Math.round(Number(dto.tdsDeducted || 0))),
      refundReason: '',
      refundedAt: '',
      issuedByEmail: actor.email,
      paymentMode:
        dto.grantMode === 'complimentary_grant'
          ? 'Super Admin Complimentary Grant'
          : dto.paymentMode?.trim() || 'Offline NEFT / RTGS',
      paymentReference:
        dto.paymentReference?.trim() ||
        (dto.grantMode === 'complimentary_grant' ? `GRANT-${now.getTime().toString().slice(-6)}` : ''),
      issuedAt: now.toISOString(),
      periodStart: now.toISOString(),
      periodEnd: periodEnd.toISOString(),
      sacCode: '998314',
      greetingNote:
        dto.greetingNote?.trim() ||
        (dto.grantMode === 'complimentary_grant'
          ? `Complimentary ${planSpec.name} license granted by Leadsetu HQ.`
          : `Thank you for upgrading ${tenant.name} to ${planSpec.name}.`),
      buyerCompany: tenant.name,
      buyerGstin: tenant.gstin || '',
      buyerState,
      buyerAddress: tenant.address || tenant.city || 'India',
      buyerEmail: tenant.email || '',
      sellerCompany: 'Leadsetu Technologies (Anujalite Tech Pvt. Ltd.)',
      sellerGstin: '07AABCL4821K1Z5',
      sellerAddress:
        'Tower B, 7th Floor, Sector 62, Noida & Connaught Place, New Delhi – 110001, India',
      sellerEmail: 'billing@leadsetu.in',
    };

    tenant.plan = dto.plan;
    tenant.status = 'active';
    tenant.trialEndsAt = periodEnd.toISOString();
    tenant.quotas = {
      ...(tenant.quotas || { aiCallsUsed: 0, whatsappUsed: 0 }),
      aiCallsUsed: tenant.quotas?.aiCallsUsed ?? 0,
      whatsappUsed: tenant.quotas?.whatsappUsed ?? 0,
      maxMonthlyAiCalls: planSpec.maxMonthlyAiCalls,
      maxMonthlyWhatsapp: planSpec.maxMonthlyWhatsapp,
      maxStorageMb: planSpec.maxStorageMb,
    };
    tenant.subscriptionInvoices = [invoice, ...(tenant.subscriptionInvoices || [])];
    tenant.markModified('subscriptionInvoices');
    tenant.markModified('quotas');
    await tenant.save();

    await this.recordAudit(actor, {
      action:
        dto.grantMode === 'complimentary_grant'
          ? 'BILLING_COMPLIMENTARY_GRANT'
          : 'BILLING_MANUAL_INVOICE_ISSUED',
      severity: 'info',
      targetTenant: tenant,
      summary: `${dto.grantMode === 'complimentary_grant' ? 'Granted complimentary' : 'Issued manual paid'} ${dto.plan.toUpperCase()} (${cycle}) invoice ${invoiceNumber} for INR ${gstBreakdown.totalAmount.toLocaleString('en-IN')}.`,
      reason: dto.reason || 'Super Admin manual SaaS subscription action',
      ipAddress,
      metadata: {
        invoiceId: invoice.id,
        invoiceNumber,
        couponCode: appliedCouponCode,
        partnerCode: appliedPartnerCode,
        totalAmount: invoice.totalAmount,
      },
    });

    return {
      invoice,
      tenantId: tenant._id.toString(),
      plan: tenant.plan,
      status: tenant.status,
    };
  }

  async updateSubscriptionInvoiceStatus(
    actor: SuperAdminActor,
    tenantId: string,
    invoiceId: string,
    dto: UpdateSubscriptionInvoiceStatusDto,
    ipAddress = '',
  ) {
    if (!dto.reason?.trim()) {
      throw new BadRequestException('An audit reason is required for invoice state mutations.');
    }
    const tenant = await this.tenantModel.findById(tenantId).exec();
    if (!tenant || tenant.isPlatformHq) {
      throw new NotFoundException('Customer workspace not found.');
    }

    const invoices = tenant.subscriptionInvoices || [];
    const target = invoices.find((inv) => inv.id === invoiceId);
    if (!target) {
      throw new NotFoundException(`Subscription invoice ${invoiceId} not found.`);
    }

    const previousStatus = target.status;
    if (dto.action === 'refund') {
      target.status = 'refunded';
      target.refundReason = dto.reason.trim();
      target.refundedAt = new Date().toISOString();
    } else if (dto.action === 'void') {
      target.status = 'voided';
      target.refundReason = dto.reason.trim();
      target.refundedAt = new Date().toISOString();
    } else if (dto.action === 'mark_paid') {
      target.status = 'paid';
      if (dto.paymentReference?.trim()) {
        target.paymentReference = dto.paymentReference.trim();
      }
      if (typeof dto.tdsDeducted === 'number' && dto.tdsDeducted >= 0) {
        target.tdsDeducted = Math.round(dto.tdsDeducted);
      }
      tenant.status = 'active';
    } else {
      throw new BadRequestException('Unsupported invoice status action.');
    }

    tenant.markModified('subscriptionInvoices');
    await tenant.save();

    await this.recordAudit(actor, {
      action: `BILLING_INVOICE_${dto.action.toUpperCase()}`,
      severity: dto.action === 'mark_paid' ? 'info' : 'warning',
      targetTenant: tenant,
      summary: `Invoice ${target.invoiceNumber} transitioned ${previousStatus} -> ${target.status}.`,
      reason: dto.reason,
      ipAddress,
      metadata: {
        invoiceId: target.id,
        invoiceNumber: target.invoiceNumber,
        amount: target.totalAmount,
      },
    });

    return {
      invoice: target,
      tenantStatus: tenant.status,
    };
  }

  async createCoupon(
    actor: SuperAdminActor,
    dto: CreateSaasCouponDto,
    ipAddress = '',
  ) {
    const code = dto.code?.trim().toUpperCase();
    if (!code || code.length < 3) {
      throw new BadRequestException('Coupon code must be at least 3 characters.');
    }
    if (!dto.discountValue || dto.discountValue <= 0) {
      throw new BadRequestException('Discount value must be greater than zero.');
    }
    if (dto.discountType === 'percent' && dto.discountValue > 100) {
      throw new BadRequestException('Percentage discount cannot exceed 100%.');
    }

    const existing = await this.couponModel.findOne({ code }).exec();
    if (existing) {
      throw new ConflictException(`Promo code ${code} already exists.`);
    }

    const created = await this.couponModel.create({
      code,
      discountType: dto.discountType || 'percent',
      discountValue: Number(dto.discountValue),
      applicablePlans: dto.applicablePlans || [],
      billingCycle: dto.billingCycle || 'all',
      maxRedemptions: Math.max(0, Number(dto.maxRedemptions || 0)),
      expiresAt: dto.expiresAt?.trim() || '',
      description: dto.description?.trim() || '',
      isActive: true,
    });

    await this.recordAudit(actor, {
      action: 'BILLING_COUPON_CREATED',
      severity: 'info',
      summary: `Created SaaS promo coupon ${created.code} (${created.discountType === 'percent' ? `${created.discountValue}% OFF` : `INR ${created.discountValue} OFF`}).`,
      ipAddress,
    });

    return created;
  }

  async updateCoupon(
    actor: SuperAdminActor,
    couponId: string,
    dto: UpdateSaasCouponDto,
    ipAddress = '',
  ) {
    const coupon = await this.couponModel.findById(couponId).exec();
    if (!coupon) {
      throw new NotFoundException('Coupon not found.');
    }
    if (typeof dto.isActive === 'boolean') coupon.isActive = dto.isActive;
    if (typeof dto.maxRedemptions === 'number') coupon.maxRedemptions = Math.max(0, dto.maxRedemptions);
    if (typeof dto.expiresAt === 'string') coupon.expiresAt = dto.expiresAt.trim();
    await coupon.save();

    await this.recordAudit(actor, {
      action: 'BILLING_COUPON_UPDATED',
      severity: 'info',
      summary: `Updated coupon ${coupon.code} (active=${coupon.isActive}).`,
      ipAddress,
    });

    return coupon;
  }

  async createPartner(
    actor: SuperAdminActor,
    dto: CreateSaasPartnerDto,
    ipAddress = '',
  ) {
    const partnerCode = dto.partnerCode?.trim().toUpperCase();
    if (!partnerCode || !dto.name?.trim() || !dto.email?.trim()) {
      throw new BadRequestException('Partner code, name, and email are required.');
    }
    const exists = await this.partnerModel.findOne({ partnerCode }).exec();
    if (exists) {
      throw new ConflictException(`Partner code ${partnerCode} already exists.`);
    }

    const rate = Math.min(50, Math.max(1, Number(dto.commissionRatePct || 15)));
    const partner = await this.partnerModel.create({
      partnerCode,
      name: dto.name.trim(),
      email: dto.email.trim().toLowerCase(),
      phone: dto.phone?.trim() || '',
      city: dto.city?.trim() || 'Delhi-NCR',
      commissionRatePct: rate,
      isActive: true,
    });

    await this.recordAudit(actor, {
      action: 'BILLING_PARTNER_CREATED',
      severity: 'info',
      summary: `Registered channel partner ${partner.name} (${partner.partnerCode}) at ${partner.commissionRatePct}% commission.`,
      ipAddress,
    });

    return partner;
  }

  async recordPartnerPayout(
    actor: SuperAdminActor,
    partnerId: string,
    dto: PartnerPayoutDto,
    ipAddress = '',
  ) {
    const partner = await this.partnerModel.findById(partnerId).exec();
    if (!partner) {
      throw new NotFoundException('Channel partner not found.');
    }
    const amount = Math.round(Number(dto.amountInr || 0));
    if (amount <= 0) {
      throw new BadRequestException('Payout amount must be greater than zero.');
    }
    const pending = Math.max(
      0,
      (partner.totalCommissionEarnedInr || 0) - (partner.totalCommissionPaidInr || 0),
    );
    if (amount > pending && pending > 0) {
      throw new BadRequestException(
        `Payout INR ${amount} exceeds pending payable commission of INR ${pending}.`,
      );
    }

    partner.totalCommissionPaidInr = (partner.totalCommissionPaidInr || 0) + amount;
    await partner.save();

    await this.recordAudit(actor, {
      action: 'BILLING_PARTNER_PAYOUT',
      severity: 'info',
      summary: `Settled partner payout of INR ${amount.toLocaleString('en-IN')} to ${partner.name} (${partner.partnerCode}).`,
      reason: dto.note || dto.reference || 'Partner commission payout',
      ipAddress,
      metadata: { partnerCode: partner.partnerCode, reference: dto.reference || '' },
    });

    return partner;
  }

  async updateDunningPolicy(
    actor: SuperAdminActor,
    dto: UpdateDunningPolicyDto,
    ipAddress = '',
  ) {
    const config = await this.ensureGlobalConfig();
    const current = config.dunningPolicy || DEFAULT_DUNNING_POLICY;
    config.dunningPolicy = {
      autoRemindersEnabled:
        typeof dto.autoRemindersEnabled === 'boolean'
          ? dto.autoRemindersEnabled
          : current.autoRemindersEnabled,
      reminderDaysBeforeExpiry:
        Array.isArray(dto.reminderDaysBeforeExpiry) && dto.reminderDaysBeforeExpiry.length > 0
          ? dto.reminderDaysBeforeExpiry
              .map((n) => Math.max(0, Math.min(30, Math.round(Number(n)))))
              .filter((v, idx, arr) => arr.indexOf(v) === idx)
              .sort((a, b) => b - a)
          : current.reminderDaysBeforeExpiry,
      gracePeriodDays:
        typeof dto.gracePeriodDays === 'number'
          ? Math.max(0, Math.min(30, Math.round(dto.gracePeriodDays)))
          : current.gracePeriodDays,
      autoActionOnExpiry: dto.autoActionOnExpiry || current.autoActionOnExpiry,
      whatsappTemplateEnabled:
        typeof dto.whatsappTemplateEnabled === 'boolean'
          ? dto.whatsappTemplateEnabled
          : current.whatsappTemplateEnabled,
      emailReminderEnabled:
        typeof dto.emailReminderEnabled === 'boolean'
          ? dto.emailReminderEnabled
          : current.emailReminderEnabled,
      reminderMessageTemplate:
        dto.reminderMessageTemplate?.trim() || current.reminderMessageTemplate,
      lastRunAt: current.lastRunAt || '',
      lastRunSummary: current.lastRunSummary || '',
    };
    config.updatedByEmail = actor.email;
    config.markModified('dunningPolicy');
    await config.save();

    await this.recordAudit(actor, {
      action: 'BILLING_DUNNING_POLICY_UPDATED',
      severity: 'warning',
      summary: `Updated auto-dunning policy (grace=${config.dunningPolicy.gracePeriodDays}d, action=${config.dunningPolicy.autoActionOnExpiry}).`,
      ipAddress,
    });

    return config.dunningPolicy;
  }

  async runDunningSweep(actor: SuperAdminActor, ipAddress = '') {
    const config = await this.ensureGlobalConfig();
    const policy = config.dunningPolicy || DEFAULT_DUNNING_POLICY;
    const trialTenants = await this.tenantModel
      .find({
        isPlatformHq: { $ne: true },
        slug: { $ne: 'leadsetu-platform-hq' },
        status: 'trial',
      })
      .exec();

    const nowMs = Date.now();
    let remindersQueued = 0;
    let enforcedCount = 0;
    const actions: Array<{ tenantName: string; accountId: string; outcome: string }> = [];

    for (const tenant of trialTenants) {
      const endsAt =
        tenant.trialEndsAt ||
        new Date(
          new Date((tenant as unknown as { createdAt?: Date }).createdAt || Date.now()).getTime() +
            (config.defaultTrialDays || 14) * 86_400_000,
        ).toISOString();
      const daysRemaining = Math.ceil((new Date(endsAt).getTime() - nowMs) / 86_400_000);

      if (policy.autoRemindersEnabled && policy.reminderDaysBeforeExpiry.includes(daysRemaining)) {
        remindersQueued++;
        actions.push({
          tenantName: tenant.name,
          accountId: tenant.accountId || '',
          outcome: `D-${daysRemaining} WhatsApp/Email reminder dispatched`,
        });
      } else if (daysRemaining < -(policy.gracePeriodDays ?? 3)) {
        if (policy.autoActionOnExpiry === 'downgrade_starter' && tenant.plan !== 'starter') {
          tenant.plan = 'starter';
          await tenant.save();
          enforcedCount++;
          actions.push({
            tenantName: tenant.name,
            accountId: tenant.accountId || '',
            outcome: 'Auto-downgraded to Starter after grace expiry',
          });
        } else if (policy.autoActionOnExpiry === 'suspend') {
          tenant.status = 'suspended';
          tenant.securityPolicy = {
            ...(tenant.securityPolicy || {
              enforcePhoneMasking: false,
              lockAgentExport: true,
              requireStrongPassword: true,
              sessionTtlHours: 24,
              allowImpersonation: true,
              ipAllowlist: [],
              suspensionReason: '',
              suspendedAt: '',
            }),
            suspensionReason: 'Trial & grace period expired (Auto-Dunning)',
            suspendedAt: new Date().toISOString(),
          };
          tenant.markModified('securityPolicy');
          await tenant.save();
          enforcedCount++;
          actions.push({
            tenantName: tenant.name,
            accountId: tenant.accountId || '',
            outcome: 'Suspended workspace after grace expiry',
          });
        } else if (policy.autoActionOnExpiry === 'pause_writes') {
          tenant.featureOverrides = {
            ...(tenant.featureOverrides || {}),
            whatsappBroadcasts: false,
            apiWebhooks: false,
          };
          tenant.markModified('featureOverrides');
          await tenant.save();
          enforcedCount++;
          actions.push({
            tenantName: tenant.name,
            accountId: tenant.accountId || '',
            outcome: 'Paused outbound broadcasts & webhooks',
          });
        }
      }
    }

    const summaryText = `Checked ${trialTenants.length} trial workspaces • ${remindersQueued} reminders queued • ${enforcedCount} grace-expiry enforcements`;
    config.dunningPolicy = {
      ...policy,
      lastRunAt: new Date().toISOString(),
      lastRunSummary: summaryText,
    };
    config.markModified('dunningPolicy');
    await config.save();

    await this.recordAudit(actor, {
      action: 'BILLING_DUNNING_SWEEP_EXECUTED',
      severity: enforcedCount > 0 ? 'warning' : 'info',
      summary: summaryText,
      ipAddress,
      metadata: { actions },
    });

    return {
      ranAt: config.dunningPolicy.lastRunAt,
      checkedTrials: trialTenants.length,
      remindersQueued,
      enforcedCount,
      summary: summaryText,
      actions,
    };
  }

  async exportBillingCsv(type: 'gstr1' | 'tds', month?: string) {
    const ledger = await this.getBillingLedger(month);
    const monthTag = ledger.monthFilter || 'all';
    const rows = ledger.data as Array<Record<string, unknown>>;

    if (type === 'tds') {
      const headers = [
        'Invoice Number',
        'Issued Date',
        'Account ID',
        'Buyer Workspace',
        'Buyer GSTIN',
        'Invoice Status',
        'Taxable Base (INR)',
        '18% GST Total (INR)',
        'Gross Invoice Value (INR)',
        'TDS Deducted u/s 194J (INR)',
        'Net Receivable (INR)',
        'Payment Mode',
        'Payment Reference / UTR',
      ];
      const csvRows = [headers.map((h) => this.escapeCsvCell(h)).join(',')];
      for (const r of rows) {
        if (r.status !== 'paid' && r.status !== 'refunded') continue;
        const gstTotal =
          Number(r.cgstAmount || 0) + Number(r.sgstAmount || 0) + Number(r.igstAmount || 0);
        const gross = Number(r.totalAmount || 0);
        const tds = Number(r.tdsDeducted || 0);
        csvRows.push(
          [
            r.invoiceNumber,
            String(r.issuedAt || '').slice(0, 10),
            r.accountId,
            r.buyerCompany || r.tenantName,
            r.buyerGstin || 'URP',
            r.status,
            r.baseAmount || 0,
            gstTotal,
            gross,
            tds,
            Math.max(0, gross - tds),
            r.paymentMode || '',
            r.paymentReference || '',
          ]
            .map((v) => this.escapeCsvCell(v))
            .join(','),
        );
      }
      return {
        filename: `Leadsetu-Platform-TDS-Reconciliation-${monthTag}.csv`,
        contentType: 'text/csv; charset=utf-8',
        csv: csvRows.join('\n'),
      };
    }

    const headers = [
      'Supply Type (B2B/B2CS)',
      'Buyer GSTIN',
      'Buyer Legal Name',
      'Invoice Number',
      'Invoice Date',
      'Place of Supply',
      'SAC Code',
      'Plan & Cycle',
      'Status',
      'Taxable Value (INR)',
      'GST Rate (%)',
      'CGST 9% (INR)',
      'SGST 9% (INR)',
      'IGST 18% (INR)',
      'Total Invoice Value (INR)',
      'Coupon Code',
      'Partner Code',
    ];
    const csvRows = [headers.map((h) => this.escapeCsvCell(h)).join(',')];
    for (const r of rows) {
      if (r.status === 'trial_complimentary' || r.status === 'voided') continue;
      const gstin = String(r.buyerGstin || '').trim();
      csvRows.push(
        [
          gstin ? 'B2B' : 'B2CS',
          gstin || 'UNREGISTERED',
          r.buyerCompany || r.tenantName,
          r.invoiceNumber,
          String(r.issuedAt || '').slice(0, 10),
          r.buyerState || 'India',
          r.sacCode || '998314',
          `${String(r.plan || '').toUpperCase()} (${r.billingCycle || 'monthly'})`,
          r.status,
          r.baseAmount || 0,
          r.gstRate || 18,
          r.cgstAmount || 0,
          r.sgstAmount || 0,
          r.igstAmount || 0,
          r.totalAmount || 0,
          r.couponCode || '',
          r.partnerCode || '',
        ]
          .map((v) => this.escapeCsvCell(v))
          .join(','),
      );
    }

    return {
      filename: `Leadsetu-GSTR1-Outward-Supplies-${monthTag}.csv`,
      contentType: 'text/csv; charset=utf-8',
      csv: csvRows.join('\n'),
    };
  }

  async getAuditLogs(query: { severity?: string; search?: string; limit?: number }) {
    const filter: Record<string, unknown> = {};
    if (query.severity && ['info', 'warning', 'critical'].includes(query.severity)) {
      filter.severity = query.severity;
    }
    if (query.search?.trim()) {
      const rx = new RegExp(query.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [
        { summary: rx },
        { action: rx },
        { actorEmail: rx },
        { targetTenantName: rx },
        { targetAccountId: rx },
      ];
    }

    const limit = Math.max(10, Math.min(200, Number(query.limit) || 80));
    const logs = await this.platformAuditModel
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean()
      .exec();

    const [total, critical, warning] = await Promise.all([
      this.platformAuditModel.countDocuments().exec(),
      this.platformAuditModel.countDocuments({ severity: 'critical' }).exec(),
      this.platformAuditModel.countDocuments({ severity: 'warning' }).exec(),
    ]);

    return {
      stats: { total, critical, warning },
      data: logs.map((l) => {
        const row = l as unknown as { _id: Types.ObjectId; createdAt?: Date };
        return {
          id: row._id.toString(),
          actorName: l.actorName,
          actorEmail: l.actorEmail,
          action: l.action,
          severity: l.severity,
          targetTenantId: l.targetTenantId || '',
          targetTenantName: l.targetTenantName || '',
          targetAccountId: l.targetAccountId || '',
          summary: l.summary,
          reason: l.reason || '',
          ipAddress: l.ipAddress || '',
          createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : new Date().toISOString(),
        };
      }),
    };
  }

  async listOperators() {
    const ops = await this.userModel
      .find({ role: 'super_admin' })
      .sort({ createdAt: 1 })
      .exec();

    return {
      data: ops.map((u) => {
        const raw = u.toObject() as unknown as { createdAt?: Date };
        return {
          id: u._id.toString(),
          userCode: u.userCode || '',
          name: u.name,
          email: u.email,
          phone: u.phone || '',
          territory: u.territory || 'Leadsetu HQ Authority',
          isActive: u.isActive,
          lastLoginAt: u.lastLoginAt ? new Date(u.lastLoginAt).toISOString() : null,
          createdAt: raw.createdAt ? new Date(raw.createdAt).toISOString() : null,
        };
      }),
    };
  }

  async createOperator(
    actor: SuperAdminActor,
    dto: CreateSuperAdminOperatorDto,
    ipAddress = '',
  ) {
    const name = dto.name?.trim();
    const email = dto.email?.trim().toLowerCase();
    const password = dto.password;

    if (!name || !email || !email.includes('@')) {
      throw new BadRequestException('Valid operator name and email are required.');
    }
    if (!password || password.length < 10) {
      throw new BadRequestException(
        'HQ Super Admin password must be at least 10 characters.',
      );
    }

    const exists = await this.userModel.findOne({ email }).exec();
    if (exists) {
      throw new ConflictException('An account with this email already exists.');
    }

    const hqTenant = await this.ensureHqTenant();
    const created = await this.userModel.create({
      tenantId: hqTenant._id,
      userCode: await generateUserCode(this.userModel),
      name,
      email,
      phone: dto.phone?.trim() || '',
      passwordHash: hashSecret(password),
      role: 'super_admin',
      departmentPreset: 'hq',
      permissions: ['*'],
      isActive: true,
      territory: dto.territory?.trim() || 'Leadsetu HQ Authority',
      invitedBy: new Types.ObjectId(actor.userId),
    });

    await this.recordAudit(actor, {
      action: 'super_admin.operator_created',
      severity: 'critical',
      summary: `Provisioned new HQ Super Admin operator: ${created.name} (${created.email})`,
      ipAddress,
    });

    return this.listOperators();
  }

  async toggleOperatorStatus(
    actor: SuperAdminActor,
    operatorId: string,
    isActive: boolean,
    ipAddress = '',
    confirmPassword?: string,
  ) {
    if (!Types.ObjectId.isValid(operatorId)) {
      throw new NotFoundException('Operator not found.');
    }
    if (actor.userId === operatorId && !isActive) {
      throw new ForbiddenException('You cannot deactivate your own Super Admin operator session.');
    }

    const target = await this.userModel
      .findOne({ _id: new Types.ObjectId(operatorId), role: 'super_admin' })
      .exec();
    if (!target) {
      throw new NotFoundException('Super Admin operator not found.');
    }

    if (!isActive) {
      await this.verifyOperatorConfirmation(
        actor,
        confirmPassword,
        `Revoking HQ Super Admin operator ${target.email}`,
      );
    }

    target.isActive = isActive;
    if (!isActive) {
      target.refreshTokenHash = null;
      target.sessionVersion = (target.sessionVersion ?? 1) + 1;
    }
    await target.save();

    await this.recordAudit(actor, {
      action: 'super_admin.operator_status_changed',
      severity: 'critical',
      summary: `${isActive ? 'Activated' : 'Deactivated'} HQ Super Admin operator ${target.email}`,
      ipAddress,
    });

    return this.listOperators();
  }

  async revokeAllTenantSessions(
    actor: SuperAdminActor,
    tenantId: string,
    dto: RevokeTenantSessionsDto,
    ipAddress = '',
  ) {
    if (!Types.ObjectId.isValid(tenantId)) {
      throw new NotFoundException('Workspace not found.');
    }
    if (!dto.reason?.trim()) {
      throw new BadRequestException('An explicit security reason is required.');
    }
    const tenant = await this.tenantModel.findById(tenantId).exec();
    if (!tenant || tenant.isPlatformHq) {
      throw new NotFoundException('Customer workspace not found.');
    }

    await this.verifyOperatorConfirmation(
      actor,
      dto.confirmPassword,
      `Panic-revoking all sessions for ${tenant.name}`,
    );

    tenant.sessionVersion = (tenant.sessionVersion ?? 1) + 1;
    await tenant.save();

    const userRes = await this.userModel
      .updateMany(
        { tenantId: tenant._id, role: { $ne: 'super_admin' } },
        {
          $inc: { sessionVersion: 1 },
          $set: { refreshTokenHash: null },
        },
      )
      .exec();

    await this.recordAudit(actor, {
      action: 'tenant.sessions_panic_revoked',
      severity: 'critical',
      targetTenant: tenant,
      summary: `Panic-revoked all active JWT & refresh sessions across ${tenant.name} (#${tenant.accountId}) [tenant v${tenant.sessionVersion}, ${userRes.modifiedCount} seats invalidated].`,
      reason: dto.reason.trim(),
      ipAddress,
    });

    return this.getTenantDetail(tenantId);
  }

  async exportTenantDpdpData(
    actor: SuperAdminActor,
    tenantId: string,
    ipAddress = '',
  ) {
    if (!Types.ObjectId.isValid(tenantId)) {
      throw new NotFoundException('Workspace not found.');
    }
    const tenant = await this.tenantModel.findById(tenantId).lean().exec();
    if (!tenant || tenant.isPlatformHq) {
      throw new NotFoundException('Customer workspace not found.');
    }

    const tObjId = new Types.ObjectId(tenantId);
    const [
      users,
      leads,
      contacts,
      deals,
      invoices,
      campaigns,
      workflows,
      tickets,
      documents,
      products,
      tasks,
      conversations,
    ] = await Promise.all([
      this.userModel
        .find({ tenantId: tObjId })
        .select('-passwordHash -refreshTokenHash')
        .lean()
        .exec(),
      this.connection.collection('leads').find({ tenantId: tObjId }).toArray().catch(() => []),
      this.connection.collection('contacts').find({ tenantId: tObjId }).toArray().catch(() => []),
      this.connection.collection('deals').find({ tenantId: tObjId }).toArray().catch(() => []),
      this.connection.collection('invoices').find({ tenantId: tObjId }).toArray().catch(() => []),
      this.connection.collection('campaigns').find({ tenantId: tObjId }).toArray().catch(() => []),
      this.connection.collection('workflows').find({ tenantId: tObjId }).toArray().catch(() => []),
      this.connection.collection('tickets').find({ tenantId: tObjId }).toArray().catch(() => []),
      this.connection.collection('documents').find({ tenantId: tObjId }).toArray().catch(() => []),
      this.connection.collection('products').find({ tenantId: tObjId }).toArray().catch(() => []),
      this.connection.collection('tasks').find({ tenantId: tObjId }).toArray().catch(() => []),
      this.connection.collection('conversations').find({ tenantId: tObjId }).toArray().catch(() => []),
    ]);

    const exportPayload = {
      exportedAt: new Date().toISOString(),
      exportedBy: actor.email,
      complianceStandard: 'Digital Personal Data Protection Act (India DPDP) Data Portability Export',
      workspace: tenant,
      collections: {
        users,
        leads,
        contacts,
        deals,
        invoices,
        campaigns,
        workflows,
        tickets,
        documents,
        products,
        tasks,
        conversations,
      },
      counts: {
        users: users.length,
        leads: leads.length,
        contacts: contacts.length,
        deals: deals.length,
        invoices: invoices.length,
        campaigns: campaigns.length,
        workflows: workflows.length,
        tickets: tickets.length,
        documents: documents.length,
        products: products.length,
        tasks: tasks.length,
        conversations: conversations.length,
      },
    };

    const tenantDoc = await this.tenantModel.findById(tenantId).exec();
    await this.recordAudit(actor, {
      action: 'tenant.dpdp_data_exported',
      severity: 'warning',
      targetTenant: tenantDoc,
      summary: `Generated full DPDP JSON portability backup for ${tenant.name} (#${tenant.accountId}): ${leads.length} leads, ${deals.length} deals, ${invoices.length} invoices.`,
      ipAddress,
    });

    return {
      filename: `Leadsetu-DPDP-Backup-${tenant.accountId || tenantId}-${new Date().toISOString().slice(0, 10)}.json`,
      payload: exportPayload,
    };
  }

  async dpdpEraseTenant(
    actor: SuperAdminActor,
    tenantId: string,
    dto: DpdpEraseTenantDto,
    ipAddress = '',
  ) {
    if (!Types.ObjectId.isValid(tenantId)) {
      throw new NotFoundException('Workspace not found.');
    }
    if (!dto.reason?.trim()) {
      throw new BadRequestException('A formal DPDP compliance reason is mandatory.');
    }
    const tenant = await this.tenantModel.findById(tenantId).exec();
    if (!tenant || tenant.isPlatformHq) {
      throw new NotFoundException('Customer workspace not found.');
    }

    const config = await this.ensureGlobalConfig();
    const retentionDays = config.securityPolicies?.dpdpRetentionDays ?? 90;

    if (dto.mode === 'soft_delete') {
      await this.verifyOperatorConfirmation(
        actor,
        dto.confirmPassword,
        `DPDP Soft-Delete for ${tenant.name}`,
      );
      const now = new Date();
      const purgeAt = new Date(now.getTime() + retentionDays * 86_400_000).toISOString();
      tenant.status = 'suspended';
      tenant.sessionVersion = (tenant.sessionVersion ?? 1) + 1;
      tenant.securityPolicy = {
        ...(tenant.securityPolicy || {
          enforcePhoneMasking: false,
          lockAgentExport: true,
          requireStrongPassword: true,
          sessionTtlHours: 24,
          allowImpersonation: true,
          ipAllowlist: [],
          suspensionReason: '',
          suspendedAt: '',
        }),
        suspensionReason: `Queued for DPDP Right-to-Erasure (${retentionDays}d retention): ${dto.reason.trim()}`,
        suspendedAt: now.toISOString(),
      };
      tenant.dpdpRetention = {
        softDeletedAt: now.toISOString(),
        purgeScheduledAt: purgeAt,
        purgedAt: '',
        deletionReason: dto.reason.trim(),
        requestedByEmail: actor.email,
      };
      tenant.markModified('securityPolicy');
      tenant.markModified('dpdpRetention');
      await tenant.save();

      await this.userModel
        .updateMany(
          { tenantId: tenant._id, role: { $ne: 'super_admin' } },
          { $inc: { sessionVersion: 1 }, $set: { refreshTokenHash: null } },
        )
        .exec();

      await this.recordAudit(actor, {
        action: 'tenant.dpdp_soft_deleted',
        severity: 'critical',
        targetTenant: tenant,
        summary: `DPDP Soft-Delete initiated for ${tenant.name} (#${tenant.accountId}). Permanent purge eligible on ${purgeAt.slice(0, 10)}.`,
        reason: dto.reason.trim(),
        ipAddress,
      });

      return this.getTenantDetail(tenantId);
    }

    if (dto.mode === 'restore') {
      tenant.status = 'active';
      tenant.dpdpRetention = {
        softDeletedAt: '',
        purgeScheduledAt: '',
        purgedAt: tenant.dpdpRetention?.purgedAt || '',
        deletionReason: '',
        requestedByEmail: '',
      };
      if (tenant.securityPolicy) {
        tenant.securityPolicy.suspensionReason = '';
        tenant.securityPolicy.suspendedAt = '';
        tenant.markModified('securityPolicy');
      }
      tenant.markModified('dpdpRetention');
      await tenant.save();

      await this.recordAudit(actor, {
        action: 'tenant.dpdp_restored',
        severity: 'warning',
        targetTenant: tenant,
        summary: `Cancelled DPDP soft-delete and restored ${tenant.name} (#${tenant.accountId}).`,
        reason: dto.reason.trim(),
        ipAddress,
      });

      return this.getTenantDetail(tenantId);
    }

    if (dto.mode === 'permanent_purge') {
      await this.verifyOperatorConfirmation(
        actor,
        dto.confirmPassword,
        `PERMANENT DPDP PURGE for ${tenant.name}`,
      );

      if (!tenant.dpdpRetention?.softDeletedAt) {
        throw new BadRequestException(
          'Workspace must be Soft-Deleted first before Permanent DPDP Purge.',
        );
      }

      const scheduledMs = new Date(tenant.dpdpRetention.purgeScheduledAt || 0).getTime();
      if (Date.now() < scheduledMs && !dto.forceBypassRetention) {
        throw new BadRequestException(
          `DPDP retention window (${retentionDays}d) ends on ${tenant.dpdpRetention.purgeScheduledAt?.slice(0, 10)}. Check override retention if explicitly authorized by Customer Data Principal.`,
        );
      }

      const tObjId = tenant._id;
      const collectionNames = [
        'leads',
        'contacts',
        'deals',
        'invoices',
        'campaigns',
        'workflows',
        'tickets',
        'documents',
        'products',
        'tasks',
        'conversations',
        'audit_logs',
      ];
      let purgedDocumentsCount = 0;
      for (const colName of collectionNames) {
        try {
          const res = await this.connection.collection(colName).deleteMany({ tenantId: tObjId });
          purgedDocumentsCount += res.deletedCount || 0;
        } catch {
          // Ignore nonexistent collections cleanly
        }
      }
      const userDel = await this.userModel
        .deleteMany({ tenantId: tObjId, role: { $ne: 'super_admin' } })
        .exec();

      const originalName = tenant.name;
      tenant.name = `[ERASED DPDP #${tenant.accountId || tenantId.slice(-5)}]`;
      tenant.email = '';
      tenant.phone = '';
      tenant.gstin = '';
      tenant.address = '';
      tenant.status = 'suspended';
      tenant.sessionVersion = (tenant.sessionVersion ?? 1) + 1;
      tenant.dpdpRetention = {
        ...(tenant.dpdpRetention || {}),
        purgedAt: new Date().toISOString(),
        deletionReason: dto.reason.trim(),
        requestedByEmail: actor.email,
      };
      tenant.markModified('dpdpRetention');
      await tenant.save();

      await this.recordAudit(actor, {
        action: 'tenant.dpdp_permanently_purged',
        severity: 'critical',
        targetTenant: tenant,
        summary: `PERMANENT DPDP PURGE completed for ${originalName} (#${tenant.accountId}): erased ${userDel.deletedCount} users & ${purgedDocumentsCount} CRM records.`,
        reason: dto.reason.trim(),
        ipAddress,
        metadata: {
          originalName,
          deletedUsers: userDel.deletedCount,
          deletedCrmRecords: purgedDocumentsCount,
        },
      });

      return this.getTenantDetail(tenantId);
    }

    throw new BadRequestException('Invalid DPDP erasure mode.');
  }

  async grantTenantQuotaAddon(
    actor: SuperAdminActor,
    tenantId: string,
    dto: GrantQuotaAddonDto,
    ipAddress = '',
  ) {
    if (!Types.ObjectId.isValid(tenantId)) {
      throw new NotFoundException('Workspace not found.');
    }
    const tenant = await this.tenantModel.findById(tenantId).exec();
    if (!tenant || tenant.isPlatformHq) {
      throw new NotFoundException('Customer workspace not found.');
    }

    const addAi = Math.max(0, Math.round(Number(dto.addonAiCalls || 0)));
    const addWa = Math.max(0, Math.round(Number(dto.addonWhatsapp || 0)));
    const addMb = Math.max(0, Math.round(Number(dto.addonStorageMb || 0)));

    if (addAi === 0 && addWa === 0 && addMb === 0) {
      throw new BadRequestException('Specify at least one add-on quota top-up (> 0).');
    }

    const config = await this.ensureGlobalConfig();
    const planSpec = config.planMatrix?.[tenant.plan] || DEFAULT_PLAN_MATRIX[tenant.plan];
    const current = tenant.quotas || {
      maxMonthlyAiCalls: planSpec.maxMonthlyAiCalls,
      maxMonthlyWhatsapp: planSpec.maxMonthlyWhatsapp,
      aiCallsUsed: 0,
      whatsappUsed: 0,
      maxStorageMb: planSpec.maxStorageMb,
      aiCostInr: 0,
      whatsappCostInr: 0,
      addonAiCalls: 0,
      addonWhatsapp: 0,
      lastMeterResetAt: '',
    };

    current.maxMonthlyAiCalls = (current.maxMonthlyAiCalls ?? planSpec.maxMonthlyAiCalls) + addAi;
    current.maxMonthlyWhatsapp = (current.maxMonthlyWhatsapp ?? planSpec.maxMonthlyWhatsapp) + addWa;
    current.maxStorageMb = (current.maxStorageMb ?? planSpec.maxStorageMb) + addMb;
    current.addonAiCalls = (current.addonAiCalls || 0) + addAi;
    current.addonWhatsapp = (current.addonWhatsapp || 0) + addWa;

    tenant.quotas = current;
    tenant.markModified('quotas');

    if (dto.issueGstInvoice && Number(dto.addonPriceInr || 0) > 0) {
      const gst = this.calculateGstSplit(
        Number(dto.addonPriceInr),
        tenant.state || 'Uttar Pradesh (09)',
      );
      const now = new Date();
      const periodEnd = new Date(now);
      periodEnd.setMonth(periodEnd.getMonth() + 1);
      const invNum = `LS-ADDON-${String(now.getFullYear()).slice(-2)}/${tenant.accountId || '00000'}/${String((tenant.subscriptionInvoices?.length || 0) + 1).padStart(3, '0')}`;
      const addonInv: SubscriptionInvoiceRecord = {
        id: `addon_${Date.now()}`,
        invoiceNumber: invNum,
        plan: tenant.plan,
        planName: `Quota Add-On (+${addAi} AI / +${addWa} WA)`,
        billingCycle: 'monthly',
        seatsIncluded: this.resolveSeatLimit(tenant, config),
        baseAmount: gst.baseAmount,
        gstRate: 18,
        cgstAmount: gst.cgstAmount,
        sgstAmount: gst.sgstAmount,
        igstAmount: gst.igstAmount,
        totalAmount: gst.totalAmount,
        status: 'paid',
        paymentMode: 'Add-On Top-Up Pack',
        paymentReference: dto.paymentReference?.trim() || `PACK-${now.getTime().toString().slice(-5)}`,
        issuedAt: now.toISOString(),
        periodStart: now.toISOString(),
        periodEnd: periodEnd.toISOString(),
        sacCode: '998314',
        greetingNote: `Quota Pack Top-Up: +${addAi} AI calls, +${addWa} WhatsApp, +${addMb} MB`,
        buyerCompany: tenant.name,
        buyerGstin: tenant.gstin || '',
        buyerState: tenant.state || 'Uttar Pradesh (09)',
        buyerAddress: tenant.address || tenant.city || 'India',
        buyerEmail: tenant.email || '',
        sellerCompany: 'Leadsetu Technologies (Anujalite Tech Pvt. Ltd.)',
        sellerGstin: '07AABCL4821K1Z5',
        sellerAddress:
          'Tower B, 7th Floor, Sector 62, Noida & Connaught Place, New Delhi – 110001, India',
        sellerEmail: 'billing@leadsetu.in',
        issuedByEmail: actor.email,
      };
      tenant.subscriptionInvoices = [addonInv, ...(tenant.subscriptionInvoices || [])];
      tenant.markModified('subscriptionInvoices');
    }

    await tenant.save();

    await this.recordAudit(actor, {
      action: 'tenant.quota_addon_granted',
      severity: 'info',
      targetTenant: tenant,
      summary: `Granted Quota Add-on Pack to ${tenant.name}: +${addAi} AI calls, +${addWa} WhatsApp msgs, +${addMb} MB storage.`,
      reason: dto.reason || 'Super Admin quota pack top-up',
      ipAddress,
    });

    return this.getTenantDetail(tenantId);
  }

  private applyAiAuthorityPatchToTenant(
    tenant: TenantDocument,
    dto: ManageTenantAiAuthorityDto,
    config: PlatformConfigDocument,
  ): string {
    const planSpec = config.planMatrix?.[tenant.plan] || DEFAULT_PLAN_MATRIX[tenant.plan];
    const current = tenant.quotas || {
      maxMonthlyAiCalls: planSpec.maxMonthlyAiCalls,
      maxMonthlyWhatsapp: planSpec.maxMonthlyWhatsapp,
      aiCallsUsed: 0,
      whatsappUsed: 0,
      maxStorageMb: planSpec.maxStorageMb,
      aiCostInr: 0,
      whatsappCostInr: 0,
      addonAiCalls: 0,
      addonWhatsapp: 0,
      lastMeterResetAt: '',
    };
    const changes: string[] = [];

    if (dto.mode === 'assign_balance') {
      const addCalls = Math.max(0, Math.round(Number(dto.aiCallsDelta || 0)));
      current.maxMonthlyAiCalls =
        (current.maxMonthlyAiCalls ?? planSpec.maxMonthlyAiCalls) + addCalls;
      current.addonAiCalls = (current.addonAiCalls || 0) + addCalls;
      changes.push(`+${addCalls} AI balance (cap ${current.maxMonthlyAiCalls})`);
    } else if (dto.mode === 'remove_balance') {
      if (dto.maxMonthlyAiCalls === 0) {
        current.maxMonthlyAiCalls = 0;
        changes.push('AI balance removed (cap set to 0)');
      } else {
        const subCalls = Math.max(0, Math.round(Number(dto.aiCallsDelta || 0)));
        const prev = current.maxMonthlyAiCalls ?? planSpec.maxMonthlyAiCalls;
        current.maxMonthlyAiCalls = Math.max(0, prev - subCalls);
        changes.push(`-${subCalls} AI balance (cap ${current.maxMonthlyAiCalls})`);
      }
    } else if (dto.mode === 'set_balance') {
      if (typeof dto.maxMonthlyAiCalls === 'number') {
        current.maxMonthlyAiCalls = Math.max(0, Math.round(dto.maxMonthlyAiCalls));
        changes.push(`AI cap set to ${current.maxMonthlyAiCalls}`);
      }
      if (typeof dto.aiCallsUsed === 'number') {
        current.aiCallsUsed = Math.max(0, Math.round(dto.aiCallsUsed));
        changes.push(`AI used set to ${current.aiCallsUsed}`);
      }
    } else if (dto.mode === 'reset_used') {
      current.aiCallsUsed = 0;
      current.aiCostInr = 0;
      current.lastMeterResetAt = new Date().toISOString();
      changes.push('AI used counter reset to 0');
    }

    tenant.quotas = current;
    tenant.markModified('quotas');

    const pillarPatch: Array<[string, boolean | null | undefined]> = [
      ['aiScoring', dto.aiScoring],
      ['aiWorkflows', dto.aiWorkflows],
      ['aiCreditRisk', dto.aiCreditRisk],
      ['aiVoiceCrm', dto.aiVoiceCrm],
      ['aiDealerDesk', dto.aiDealerDesk],
      ['aiCopilot', dto.aiCopilot],
    ];
    if (pillarPatch.some(([, v]) => v !== undefined)) {
      const nextOverrides: Record<string, boolean> = {
        ...(tenant.featureOverrides || {}),
      };
      for (const [k, val] of pillarPatch) {
        if (val === undefined) continue;
        if (val === null) {
          delete nextOverrides[k];
          changes.push(`${k}: plan default`);
        } else {
          nextOverrides[k] = val;
          changes.push(`${k}: ${val ? 'ENABLED' : 'REMOVED'}`);
        }
      }
      tenant.featureOverrides = nextOverrides;
      tenant.markModified('featureOverrides');
    }

    return changes.join(', ') || `mode=${dto.mode}`;
  }

  async manageTenantAiAuthority(
    actor: SuperAdminActor,
    tenantId: string,
    dto: ManageTenantAiAuthorityDto,
    ipAddress = '',
  ) {
    if (!Types.ObjectId.isValid(tenantId)) {
      throw new NotFoundException('Workspace not found.');
    }
    const [tenant, config] = await Promise.all([
      this.tenantModel.findById(tenantId).exec(),
      this.ensureGlobalConfig(),
    ]);
    if (!tenant || tenant.isPlatformHq) {
      throw new NotFoundException('Customer workspace not found.');
    }

    const detailSummary = this.applyAiAuthorityPatchToTenant(tenant, dto, config);
    await tenant.save();

    await this.recordAudit(actor, {
      action: 'tenant.ai_authority_updated',
      severity: dto.mode === 'remove_balance' || dto.aiScoring === false ? 'warning' : 'info',
      targetTenant: tenant,
      summary: `AI Authority updated for ${tenant.name}: ${detailSummary}`,
      reason: dto.reason || `Super Admin ${dto.mode}`,
      ipAddress,
    });

    return this.getTenantDetail(tenantId);
  }

  async bulkManageAiAuthority(
    actor: SuperAdminActor,
    dto: BulkManageAiAuthorityDto,
    ipAddress = '',
  ) {
    const config = await this.ensureGlobalConfig();
    const filter: Record<string, unknown> = {
      isPlatformHq: { $ne: true },
      slug: { $ne: 'leadsetu-platform-hq' },
    };
    if (Array.isArray(dto.tenantIds) && dto.tenantIds.length > 0) {
      const validIds = dto.tenantIds
        .filter((id) => Types.ObjectId.isValid(id))
        .map((id) => new Types.ObjectId(id));
      if (validIds.length > 0) {
        filter._id = { $in: validIds };
      }
    }

    const tenants = await this.tenantModel.find(filter).exec();
    let lastSummary = `mode=${dto.mode}`;
    for (const tenant of tenants) {
      lastSummary = this.applyAiAuthorityPatchToTenant(tenant, dto, config);
      await tenant.save();
    }

    await this.recordAudit(actor, {
      action: 'platform.bulk_ai_authority_updated',
      severity: dto.mode === 'remove_balance' || dto.aiScoring === false ? 'warning' : 'info',
      summary: `Bulk AI Authority applied across ${tenants.length} Admin account(s): ${lastSummary}`,
      reason: dto.reason || `Bulk Super Admin ${dto.mode}`,
      ipAddress,
    });

    const refreshed = await this.listTenants({});
    return {
      updatedCount: tenants.length,
      data: refreshed.data,
    };
  }

  // ─── AI / WhatsApp Top-Up Request Queue ─────────────────────────────────

  async listTopupRequests(status?: string) {
    const tenants = await this.tenantModel
      .find({
        isPlatformHq: { $ne: true },
        slug: { $ne: 'leadsetu-platform-hq' },
        'topupRequests.0': { $exists: true },
      })
      .select('name accountId plan status city topupRequests quotas')
      .exec();

    const rows = tenants.flatMap((t) =>
      (t.topupRequests || []).map((r) => ({
        tenantId: t._id.toString(),
        tenantName: t.name,
        accountId: t.accountId || '',
        plan: t.plan,
        tenantStatus: t.status,
        city: t.city || '',
        currentAiCap: t.quotas?.maxMonthlyAiCalls ?? 0,
        currentAiUsed: t.quotas?.aiCallsUsed ?? 0,
        currentWaCap: t.quotas?.maxMonthlyWhatsapp ?? 0,
        currentWaUsed: t.quotas?.whatsappUsed ?? 0,
        id: r.id,
        resource: r.resource,
        quantity: r.quantity,
        note: r.note || '',
        status: r.status,
        requestedByName: r.requestedByName || '',
        requestedByEmail: r.requestedByEmail || '',
        createdAt: r.createdAt || '',
        resolvedAt: r.resolvedAt || '',
        resolvedByEmail: r.resolvedByEmail || '',
        resolutionNote: r.resolutionNote || '',
        grantedQuantity: r.grantedQuantity || 0,
      })),
    );

    const filtered =
      status && status !== 'all' ? rows.filter((r) => r.status === status) : rows;
    filtered.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

    return {
      data: filtered,
      stats: {
        pending: rows.filter((r) => r.status === 'pending').length,
        approved: rows.filter((r) => r.status === 'approved').length,
        rejected: rows.filter((r) => r.status === 'rejected').length,
      },
    };
  }

  async resolveTopupRequest(
    actor: SuperAdminActor,
    tenantId: string,
    requestId: string,
    dto: ResolveTopupRequestDto,
    ipAddress = '',
  ) {
    if (!Types.ObjectId.isValid(tenantId)) {
      throw new NotFoundException('Workspace not found.');
    }
    const tenant = await this.tenantModel.findById(tenantId).exec();
    if (!tenant || tenant.isPlatformHq) {
      throw new NotFoundException('Customer workspace not found.');
    }
    const request = (tenant.topupRequests || []).find((r) => r.id === requestId);
    if (!request) throw new NotFoundException('Top-up request not found.');
    if (request.status !== 'pending') {
      throw new BadRequestException(`This request is already ${request.status}.`);
    }
    if (dto.action !== 'approve' && dto.action !== 'reject') {
      throw new BadRequestException('Action must be approve or reject.');
    }

    let granted = 0;
    if (dto.action === 'approve') {
      granted = Math.max(
        1,
        Math.round(Number(dto.grantedQuantity ?? request.quantity) || request.quantity),
      );
      await this.grantTenantQuotaAddon(
        actor,
        tenantId,
        {
          addonAiCalls: request.resource === 'ai' ? granted : 0,
          addonWhatsapp: request.resource === 'whatsapp' ? granted : 0,
          issueGstInvoice: Boolean(dto.issueGstInvoice),
          addonPriceInr: Number(dto.priceInr || 0),
          reason:
            dto.note?.trim() ||
            `Approved top-up request ${request.id} from ${request.requestedByName || 'Company Admin'}`,
        },
        ipAddress,
      );
    }

    // Reload: grantTenantQuotaAddon saved the document independently.
    const fresh = await this.tenantModel.findById(tenantId).exec();
    if (!fresh) throw new NotFoundException('Customer workspace not found.');
    fresh.topupRequests = (fresh.topupRequests || []).map((r) =>
      r.id === requestId
        ? {
            ...r,
            status: dto.action === 'approve' ? 'approved' : 'rejected',
            resolvedAt: new Date().toISOString(),
            resolvedByEmail: actor.email,
            resolutionNote: dto.note?.trim() || '',
            grantedQuantity: granted,
          }
        : r,
    );
    fresh.markModified('topupRequests');
    await fresh.save();

    await this.recordAudit(actor, {
      action: 'tenant.topup_request_resolved',
      severity: dto.action === 'reject' ? 'warning' : 'info',
      targetTenant: fresh,
      summary: `${dto.action === 'approve' ? 'Approved' : 'Rejected'} ${request.resource.toUpperCase()} top-up request (${request.quantity} requested${granted ? `, ${granted} granted` : ''}) for ${fresh.name}.`,
      reason: dto.note || '',
      ipAddress,
    });

    return this.listTopupRequests('all');
  }

  // ─── Territory & Industry Cluster Analytics ─────────────────────────────

  async getTerritoryAnalytics() {
    const config = await this.ensureGlobalConfig();
    const tenants = await this.tenantModel
      .find({ isPlatformHq: { $ne: true }, slug: { $ne: 'leadsetu-platform-hq' } })
      .exec();
    const tenantIds = tenants.map((t) => t._id as Types.ObjectId);

    const [userCounts, leadCounts, dealAgg] = await Promise.all([
      this.userModel
        .aggregate<{ _id: Types.ObjectId; total: number }>([
          { $match: { tenantId: { $in: tenantIds }, role: { $ne: 'super_admin' } } },
          { $group: { _id: '$tenantId', total: { $sum: 1 } } },
        ])
        .exec(),
      this.connection
        .collection('leads')
        .aggregate<{ _id: Types.ObjectId; count: number }>([
          { $match: { tenantId: { $in: tenantIds } } },
          { $group: { _id: '$tenantId', count: { $sum: 1 } } },
        ])
        .toArray()
        .catch(() => []),
      this.connection
        .collection('deals')
        .aggregate<{ _id: Types.ObjectId; wonRev: number }>([
          { $match: { tenantId: { $in: tenantIds } } },
          {
            $group: {
              _id: '$tenantId',
              wonRev: { $sum: { $cond: [{ $eq: ['$stage', 'won'] }, '$value', 0] } },
            },
          },
        ])
        .toArray()
        .catch(() => []),
    ]);

    const userMap = new Map(userCounts.map((r) => [String(r._id), r.total]));
    const leadMap = new Map(leadCounts.map((r) => [String(r._id), r.count]));
    const dealMap = new Map(dealAgg.map((r) => [String(r._id), r.wonRev || 0]));

    const normalizeCity = (raw?: string) => {
      const c = (raw || '').trim();
      if (!c) return 'Unassigned';
      return c
        .split(/\s+/)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .join(' ');
    };

    const tenantsHealth = tenants.map((t) => {
      const key = t._id.toString();
      const planSpec = config.planMatrix?.[t.plan] || DEFAULT_PLAN_MATRIX[t.plan];
      const seatLimit = this.resolveSeatLimit(t, config);
      const seatsUsed = userMap.get(key) || 0;
      const leadsCount = leadMap.get(key) || 0;
      const wonRevenueInr = dealMap.get(key) || 0;
      const aiCap = t.quotas?.maxMonthlyAiCalls ?? planSpec.maxMonthlyAiCalls;
      const aiUsed = t.quotas?.aiCallsUsed ?? 0;
      const waCap = t.quotas?.maxMonthlyWhatsapp ?? planSpec.maxMonthlyWhatsapp;
      const waUsed = t.quotas?.whatsappUsed ?? 0;
      const mrrInr = t.status === 'active' ? planSpec.monthlyPrice || 0 : 0;

      let score = 50;
      const reasons: string[] = [];
      if (t.status === 'active') {
        score += 20;
      } else if (t.status === 'suspended') {
        score -= 30;
        reasons.push('Workspace suspended');
      } else {
        reasons.push('Still on trial');
      }
      if (seatLimit > 0 && seatsUsed / seatLimit >= 0.5) score += 10;
      else reasons.push('Low seat adoption');
      if (leadsCount > 0) score += 10;
      else reasons.push('No leads captured yet');
      if (wonRevenueInr > 0) score += 10;
      else reasons.push('No won deals yet');
      const aiOver = aiCap > 0 && aiUsed >= aiCap;
      const waOver = waCap > 0 && waUsed >= waCap;
      if (aiOver || waOver) {
        score -= 15;
        reasons.push(aiOver ? 'AI quota exhausted' : 'WhatsApp quota exhausted');
      }
      if (t.status === 'trial' && t.trialEndsAt) {
        const msLeft = new Date(t.trialEndsAt).getTime() - Date.now();
        if (msLeft > 0 && msLeft <= 3 * 86400000) {
          score -= 10;
          reasons.push('Trial ends within 3 days');
        }
      }
      const healthScore = Math.max(0, Math.min(100, score));
      const healthBand: 'healthy' | 'watch' | 'at_risk' =
        healthScore >= 70 ? 'healthy' : healthScore >= 40 ? 'watch' : 'at_risk';

      return {
        id: key,
        name: t.name,
        accountId: t.accountId || '',
        city: normalizeCity(t.city),
        plan: t.plan,
        status: t.status,
        seatsUsed,
        seatLimit,
        leadsCount,
        wonRevenueInr,
        mrrInr,
        aiUsed,
        aiCap,
        healthScore,
        healthBand,
        reasons,
      };
    });

    const byCity = new Map<
      string,
      {
        city: string;
        tenants: number;
        active: number;
        trial: number;
        suspended: number;
        mrrInr: number;
        seatsUsed: number;
        aiCallsUsed: number;
        aiCap: number;
        leadsCount: number;
        wonRevenueInr: number;
        healthTotal: number;
      }
    >();
    for (const h of tenantsHealth) {
      const row =
        byCity.get(h.city) ||
        {
          city: h.city,
          tenants: 0,
          active: 0,
          trial: 0,
          suspended: 0,
          mrrInr: 0,
          seatsUsed: 0,
          aiCallsUsed: 0,
          aiCap: 0,
          leadsCount: 0,
          wonRevenueInr: 0,
          healthTotal: 0,
        };
      row.tenants += 1;
      if (h.status === 'active') row.active += 1;
      else if (h.status === 'suspended') row.suspended += 1;
      else row.trial += 1;
      row.mrrInr += h.mrrInr;
      row.seatsUsed += h.seatsUsed;
      row.aiCallsUsed += h.aiUsed;
      row.aiCap += h.aiCap;
      row.leadsCount += h.leadsCount;
      row.wonRevenueInr += h.wonRevenueInr;
      row.healthTotal += h.healthScore;
      byCity.set(h.city, row);
    }

    const territories = Array.from(byCity.values())
      .map(({ healthTotal, ...r }) => ({
        ...r,
        avgHealthScore: r.tenants > 0 ? Math.round(healthTotal / r.tenants) : 0,
      }))
      .sort((a, b) => b.mrrInr - a.mrrInr || b.tenants - a.tenants);

    tenantsHealth.sort((a, b) => a.healthScore - b.healthScore);

    return {
      territories,
      tenantsHealth,
      summary: {
        totalTerritories: territories.length,
        totalTenants: tenantsHealth.length,
        healthy: tenantsHealth.filter((h) => h.healthBand === 'healthy').length,
        watch: tenantsHealth.filter((h) => h.healthBand === 'watch').length,
        atRisk: tenantsHealth.filter((h) => h.healthBand === 'at_risk').length,
        totalMrrInr: territories.reduce((s, t) => s + t.mrrInr, 0),
      },
    };
  }
}
