import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Model, Types } from 'mongoose';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import axios from 'axios';
import {
  SubscriptionInvoiceRecord,
  Tenant,
  TenantDocument,
} from '../auth/schemas/tenant.schema';
import { User, UserDocument } from '../auth/schemas/user.schema';
import {
  DEFAULT_DUNNING_POLICY,
  DEFAULT_PLAN_MATRIX,
  PlatformConfig,
  type PlatformConfigDocument,
  SaasCoupon,
  SaasCouponDocument,
} from '../super-admin/schemas/platform-config.schema';
import { AuditService } from '../audit/audit.module';
import { SuperAdminService } from '../super-admin/super-admin.service';
import { resolveEffectiveRazorpayConfig } from '../super-admin/razorpay-config.util';
import { PLAN_CATALOG } from '../tenants/tenants.service';

export type TopupPackId =
  | 'ai_1000'
  | 'ai_5000'
  | 'wa_2500'
  | 'wa_10000'
  | 'wa_call_500'
  | 'wa_call_2000'
  | 'storage_5gb';

export interface TopupPackSpec {
  id: TopupPackId;
  resource: 'ai' | 'whatsapp' | 'calling' | 'storage';
  name: string;
  description: string;
  quantity: number;
  unitLabel: string;
  priceInr: number;
  addonAiCalls: number;
  addonWhatsapp: number;
  addonCallingInr?: number;
  addonStorageMb: number;
  badge?: string;
}

export const TOPUP_PACK_CATALOG: Record<TopupPackId, TopupPackSpec> = {
  ai_1000: {
    id: 'ai_1000',
    resource: 'ai',
    name: '+1,000 SetuAI Credits Pack',
    description:
      'Instant 1,000 AI calls for WhatsApp drafts, lead intent scoring & RAG copilot actions.',
    quantity: 1000,
    unitLabel: 'AI Calls',
    priceInr: 499,
    addonAiCalls: 1000,
    addonWhatsapp: 0,
    addonStorageMb: 0,
  },
  ai_5000: {
    id: 'ai_5000',
    resource: 'ai',
    name: '+5,000 SetuAI Scale Pack',
    description:
      'Best value bundle for active B2B teams running continuous AI lead scoring & workflows.',
    quantity: 5000,
    unitLabel: 'AI Calls',
    priceInr: 1999,
    addonAiCalls: 5000,
    addonWhatsapp: 0,
    addonStorageMb: 0,
    badge: 'Popular',
  },
  wa_2500: {
    id: 'wa_2500',
    resource: 'whatsapp',
    name: '+2,500 WhatsApp Broadcast Pack',
    description:
      'Additional official Meta Cloud template dispatches & workflow follow-up messages.',
    quantity: 2500,
    unitLabel: 'WhatsApp Msgs',
    priceInr: 799,
    addonAiCalls: 0,
    addonWhatsapp: 2500,
    addonStorageMb: 0,
  },
  wa_10000: {
    id: 'wa_10000',
    resource: 'whatsapp',
    name: '+10,000 WhatsApp Enterprise Pack',
    description:
      'High-volume festive & catalog broadcast quota for multi-city dealer outreach.',
    quantity: 10000,
    unitLabel: 'WhatsApp Msgs',
    priceInr: 2499,
    addonAiCalls: 0,
    addonWhatsapp: 10000,
    addonStorageMb: 0,
    badge: 'Best Value',
  },
  wa_call_500: {
    id: 'wa_call_500',
    resource: 'calling',
    name: '+₹500 WhatsApp Calling Wallet Pack',
    description:
      'Prepaid INR voice balance (~1,111 mins @ ₹0.45/min billed in 6s pulses; inbound calls are free).',
    quantity: 500,
    unitLabel: 'INR Calling Credit',
    priceInr: 500,
    addonAiCalls: 0,
    addonWhatsapp: 0,
    addonCallingInr: 500,
    addonStorageMb: 0,
  },
  wa_call_2000: {
    id: 'wa_call_2000',
    resource: 'calling',
    name: '+₹2,000 WhatsApp Calling Scale Pack',
    description:
      'High-capacity prepaid calling wallet (~4,444 mins @ ₹0.45/min 6-second pulses) for busy sales floors.',
    quantity: 2000,
    unitLabel: 'INR Calling Credit',
    priceInr: 2000,
    addonAiCalls: 0,
    addonWhatsapp: 0,
    addonCallingInr: 2000,
    addonStorageMb: 0,
    badge: 'Popular',
  },
  storage_5gb: {
    id: 'storage_5gb',
    resource: 'storage',
    name: '+5 GB Document & Vault Storage',
    description:
      'Expand workspace cloud capacity for GST certificates, CAD PDFs, brochures & call recordings.',
    quantity: 5120,
    unitLabel: 'MB Storage',
    priceInr: 599,
    addonAiCalls: 0,
    addonWhatsapp: 0,
    addonStorageMb: 5120,
  },
};

export interface BillingAuthContext {
  userId: string;
  tenantId: string;
  email: string;
  role: string;
}

export interface ValidateCouponDto {
  code: string;
  plan?: 'starter' | 'growth' | 'enterprise';
  billingCycle?: 'monthly' | 'annual';
  orderType?: 'subscription' | 'topup_pack';
  topupPackId?: TopupPackId;
}

export interface CreateCheckoutOrderDto {
  orderType?: 'subscription' | 'topup_pack';
  plan?: 'starter' | 'growth' | 'enterprise';
  billingCycle?: 'monthly' | 'annual';
  topupPackId?: TopupPackId;
  couponCode?: string;
  greetingNote?: string;
}

export interface VerifyCheckoutPaymentDto {
  razorpayOrderId: string;
  razorpayPaymentId: string;
  razorpaySignature: string;
  paymentMode?: string;
  greetingNote?: string;
}

export interface SandboxAuthorizeCheckoutDto {
  razorpayOrderId: string;
  paymentMode?: string;
}

export interface BillingCheckoutOrderDoc {
  _id?: Types.ObjectId;
  orderId: string;
  orderType: 'subscription' | 'topup_pack';
  topupPackId?: TopupPackId;
  addonAiCalls?: number;
  addonWhatsapp?: number;
  addonCallingInr?: number;
  addonStorageMb?: number;
  tenantId: Types.ObjectId;
  userId: string;
  userEmail: string;
  plan: 'starter' | 'growth' | 'enterprise';
  planName: string;
  billingCycle: 'monthly' | 'annual';
  seatsIncluded: number;
  listBaseAmount: number;
  proratedCreditAmount?: number;
  discountAmount: number;
  netBaseAmount: number;
  gstRate: number;
  cgstAmount: number;
  sgstAmount: number;
  igstAmount: number;
  totalAmount: number;
  amountPaise: number;
  currency: string;
  couponCode: string;
  greetingNote: string;
  mode: 'razorpay_live' | 'razorpay_sandbox';
  status: 'created' | 'paid' | 'failed' | 'refunded';
  paymentId?: string;
  paymentMode?: string;
  invoiceId?: string;
  invoiceNumber?: string;
  failureReason?: string;
  verifiedAt?: string;
  refundedAt?: string;
  createdAt: string;
  updatedAt: string;
}

const LEADSETU_SELLER = {
  sellerCompany: 'Leadsetu Technologies (Anujalite Tech Pvt. Ltd.)',
  sellerGstin: '07AABCL4821K1Z5',
  sellerAddress:
    'Tower B, 7th Floor, Sector 62, Noida & Connaught Place, New Delhi – 110001, India',
  sellerEmail: 'billing@leadsetu.in',
};

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    @InjectModel(Tenant.name)
    private readonly tenantModel: Model<TenantDocument>,
    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>,
    @InjectModel(SaasCoupon.name)
    private readonly couponModel: Model<SaasCouponDocument>,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    @Optional() private readonly auditService?: AuditService,
    @Optional() private readonly superAdminService?: SuperAdminService,
    @Optional()
    @InjectModel(PlatformConfig.name)
    private readonly platformConfigModel?: Model<PlatformConfigDocument>,
  ) {}

  async verifyAuth(authHeader?: string): Promise<BillingAuthContext> {
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
        role: payload.role || 'owner',
      };
    } catch {
      throw new UnauthorizedException('Invalid or expired session.');
    }
  }

  private async getRazorpayConfig() {
    return resolveEffectiveRazorpayConfig(
      this.tenantModel.db,
      this.configService,
    );
  }

  private computeGstBreakdown(netBaseAmount: number, buyerStateRaw?: string) {
    const baseAmount = Math.max(0, Math.round(netBaseAmount));
    const buyerState = (buyerStateRaw || 'Delhi (07)').trim();
    const isIntraState =
      buyerState.toLowerCase().includes('delhi') || buyerState.includes('07');
    const gstTotal = Math.round(baseAmount * 0.18);
    const cgstAmount = isIntraState ? Math.round(gstTotal / 2) : 0;
    const sgstAmount = isIntraState ? gstTotal - cgstAmount : 0;
    const igstAmount = isIntraState ? 0 : gstTotal;
    const totalAmount = baseAmount + cgstAmount + sgstAmount + igstAmount;

    return {
      baseAmount,
      gstRate: 18,
      cgstAmount,
      sgstAmount,
      igstAmount,
      gstTotal,
      totalAmount,
      buyerState,
      isIntraState,
    };
  }

  private async evaluateCoupon(params: {
    code?: string;
    plan: 'starter' | 'growth' | 'enterprise';
    billingCycle: 'monthly' | 'annual';
    listBaseAmount: number;
  }): Promise<{
    coupon: SaasCouponDocument | null;
    couponCode: string;
    discountAmount: number;
    netBaseAmount: number;
  }> {
    const rawCode = (params.code || '').trim().toUpperCase();
    if (!rawCode) {
      return {
        coupon: null,
        couponCode: '',
        discountAmount: 0,
        netBaseAmount: params.listBaseAmount,
      };
    }

    const coupon = await this.couponModel.findOne({ code: rawCode }).exec();
    if (!coupon || !coupon.isActive) {
      throw new BadRequestException(
        `Promo code "${rawCode}" is invalid or inactive.`,
      );
    }
    if (
      coupon.expiresAt &&
      new Date(coupon.expiresAt).getTime() < Date.now()
    ) {
      throw new BadRequestException(`Promo code "${rawCode}" has expired.`);
    }
    if (
      coupon.maxRedemptions > 0 &&
      (coupon.redemptionsCount || 0) >= coupon.maxRedemptions
    ) {
      throw new BadRequestException(
        `Promo code "${rawCode}" has reached its maximum redemptions limit.`,
      );
    }
    if (
      Array.isArray(coupon.applicablePlans) &&
      coupon.applicablePlans.length > 0 &&
      !coupon.applicablePlans.includes(params.plan)
    ) {
      throw new BadRequestException(
        `Promo code "${rawCode}" is not applicable to the ${params.plan.toUpperCase()} plan.`,
      );
    }
    if (
      coupon.billingCycle &&
      coupon.billingCycle !== 'all' &&
      coupon.billingCycle !== params.billingCycle
    ) {
      throw new BadRequestException(
        `Promo code "${rawCode}" is valid only for ${coupon.billingCycle} billing.`,
      );
    }

    let discountAmount =
      coupon.discountType === 'percent'
        ? Math.round((params.listBaseAmount * coupon.discountValue) / 100)
        : Math.round(coupon.discountValue);

    discountAmount = Math.min(
      params.listBaseAmount,
      Math.max(0, discountAmount),
    );
    const netBaseAmount = Math.max(0, params.listBaseAmount - discountAmount);

    return {
      coupon,
      couponCode: coupon.code,
      discountAmount,
      netBaseAmount,
    };
  }

  async getSummary(auth: BillingAuthContext) {
    const tenant = await this.tenantModel.findById(auth.tenantId).exec();
    if (!tenant) {
      throw new NotFoundException('Workspace not found.');
    }

    const spec = PLAN_CATALOG[tenant.plan || 'growth'] || PLAN_CATALOG.growth;
    const trialEndsAt = String(tenant.trialEndsAt || '').trim();
    const expiresMs = trialEndsAt ? Date.parse(trialEndsAt) : NaN;
    const hasValidExpiry = Boolean(trialEndsAt) && Number.isFinite(expiresMs);
    const daysUntilExpiry = hasValidExpiry
      ? Math.ceil((expiresMs - Date.now()) / 86400000)
      : null;
    const planExpired =
      !tenant.isPlatformHq &&
      (tenant.status === 'suspended' ||
        (hasValidExpiry && Date.now() > expiresMs));
    const [activeSeats, totalSeats] = await Promise.all([
      this.userModel
        .countDocuments({
          tenantId: new Types.ObjectId(auth.tenantId),
          isActive: true,
        })
        .exec(),
      this.userModel
        .countDocuments({ tenantId: new Types.ObjectId(auth.tenantId) })
        .exec(),
    ]);

    const rzp = await this.getRazorpayConfig();
    const invoices = [...(tenant.subscriptionInvoices || [])].reverse();

    return {
      tenant: {
        id: tenant._id.toString(),
        accountId: tenant.accountId || '',
        name: tenant.name,
        companyName: (tenant.companyName || '').trim(),
        logoUrl: tenant.logoUrl || '',
        slug: tenant.slug,
        plan: tenant.plan,
        status: tenant.status,
        city: tenant.city || 'Delhi-NCR',
        gstin: tenant.gstin || '',
        state: tenant.state || 'Delhi (07)',
        phone: tenant.phone || '',
        email: tenant.email || '',
        address: tenant.address || '',
        trialEndsAt,
        planExpired,
        daysUntilExpiry,
        subscriptionInvoices: tenant.subscriptionInvoices || [],
      },
      usage: {
        activeSeats,
        totalSeats,
        seatLimit: tenant.seatLimitOverride ?? spec.seatLimit,
        quotas: tenant.quotas || {},
      },
      seller: LEADSETU_SELLER,
      plans: Object.values(PLAN_CATALOG),
      invoices,
      razorpay: {
        keyId: rzp.keyId,
        mode: rzp.isLiveConfigured ? 'razorpay_live' : 'razorpay_sandbox',
      },
      topupPacks: Object.values(TOPUP_PACK_CATALOG),
      lifecycle: tenant.subscriptionLifecycle || {
        autoRenew: true,
        cancelAtPeriodEnd: false,
        cancellationReason: '',
        cancelledAt: '',
        scheduledDowngradePlan: '',
        scheduledDowngradeCycle: '',
        scheduledForDate: '',
      },
      refundRequests: [...(tenant.refundRequests || [])].sort((a, b) =>
        (b.createdAt || '').localeCompare(a.createdAt || ''),
      ),
      proration: {
        starter: this.computeProrationForTenant(tenant, 'starter', 'monthly'),
        growth: this.computeProrationForTenant(tenant, 'growth', 'monthly'),
        enterprise: this.computeProrationForTenant(tenant, 'enterprise', 'monthly'),
      },
    };
  }

  private computeProrationForTenant(
    tenant: TenantDocument,
    targetPlan: 'starter' | 'growth' | 'enterprise',
    targetCycle: 'monthly' | 'annual' = 'monthly',
  ) {
    const planRank: Record<'starter' | 'growth' | 'enterprise', number> = {
      starter: 1,
      growth: 2,
      enterprise: 3,
    };
    const currentPlan = (tenant.plan || 'growth') as
      | 'starter'
      | 'growth'
      | 'enterprise';
    const targetSpec = PLAN_CATALOG[targetPlan] || PLAN_CATALOG.growth;
    const targetListBase =
      targetCycle === 'annual' ? targetSpec.annualPrice : targetSpec.monthlyPrice;

    const paidPlanInvoices = (tenant.subscriptionInvoices || []).filter(
      (i) =>
        i.status === 'paid' &&
        !String(i.invoiceNumber || '').startsWith('LS-ADDON'),
    );
    const activeInv = paidPlanInvoices[paidPlanInvoices.length - 1];

    const isHigherTier = planRank[targetPlan] > planRank[currentPlan];
    const isCycleUpgrade =
      targetPlan === currentPlan &&
      activeInv?.billingCycle === 'monthly' &&
      targetCycle === 'annual';
    const isUpgrade = isHigherTier || isCycleUpgrade;

    let daysRemaining = 0;
    let cycleTotalDays = activeInv?.billingCycle === 'annual' ? 365 : 30;
    let proratedCreditInr = 0;

    if (isUpgrade && activeInv && Number(activeInv.baseAmount || 0) > 0) {
      const startMs = new Date(activeInv.periodStart).getTime();
      const endMs = new Date(activeInv.periodEnd).getTime();
      const nowMs = Date.now();
      if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > nowMs) {
        cycleTotalDays = Math.max(
          1,
          Math.round((endMs - startMs) / 86400000),
        );
        daysRemaining = Math.max(0, Math.ceil((endMs - nowMs) / 86400000));
        const ratio = Math.min(1, daysRemaining / cycleTotalDays);
        proratedCreditInr = Math.min(
          targetListBase,
          Math.round(Number(activeInv.baseAmount || 0) * ratio),
        );
      }
    }

    const netAfterProration = Math.max(0, targetListBase - proratedCreditInr);
    const gst = this.computeGstBreakdown(
      netAfterProration,
      tenant.state || tenant.city || 'Delhi (07)',
    );

    return {
      isUpgrade,
      currentPlan,
      targetPlan,
      targetCycle,
      daysRemaining,
      cycleTotalDays,
      targetListBaseAmount: targetListBase,
      proratedCreditInr,
      netBaseAfterProration: netAfterProration,
      gstTotal: gst.gstTotal,
      totalPayableWithGst: gst.totalAmount,
    };
  }

  async getProrationPreview(
    auth: BillingAuthContext,
    targetPlan: 'starter' | 'growth' | 'enterprise',
    billingCycle: 'monthly' | 'annual' = 'monthly',
    couponCode?: string,
  ) {
    if (!PLAN_CATALOG[targetPlan]) {
      throw new BadRequestException('Valid target plan is required.');
    }
    const tenant = await this.tenantModel.findById(auth.tenantId).exec();
    if (!tenant) {
      throw new NotFoundException('Workspace not found.');
    }

    const proration = this.computeProrationForTenant(
      tenant,
      targetPlan,
      billingCycle,
    );
    let couponDiscountInr = 0;
    let appliedCouponCode = '';
    if (couponCode?.trim()) {
      const evaluated = await this.evaluateCoupon({
        code: couponCode,
        plan: targetPlan,
        billingCycle,
        listBaseAmount: proration.netBaseAfterProration,
      });
      couponDiscountInr = evaluated.discountAmount;
      appliedCouponCode = evaluated.couponCode;
    }

    const finalNetBase = Math.max(
      0,
      proration.netBaseAfterProration - couponDiscountInr,
    );
    const gst = this.computeGstBreakdown(
      finalNetBase,
      tenant.state || tenant.city || 'Delhi (07)',
    );

    return {
      ...proration,
      couponCode: appliedCouponCode,
      couponDiscountInr,
      finalNetBaseAmount: gst.baseAmount,
      cgstAmount: gst.cgstAmount,
      sgstAmount: gst.sgstAmount,
      igstAmount: gst.igstAmount,
      gstTotal: gst.gstTotal,
      totalPayableWithGst: gst.totalAmount,
    };
  }

  async getUsageDashboard(auth: BillingAuthContext) {
    const tenant = await this.tenantModel.findById(auth.tenantId).exec();
    if (!tenant) {
      throw new NotFoundException('Workspace not found.');
    }

    let configDoc: PlatformConfig | null = null;
    try {
      if (this.platformConfigModel) {
        configDoc = await this.platformConfigModel
          .findOne({ key: 'global' })
          .lean()
          .exec();
      }
    } catch {
      configDoc = null;
    }

    const planKey = (tenant.plan || 'growth') as
      | 'starter'
      | 'growth'
      | 'enterprise';
    const planMatrix = configDoc?.planMatrix || DEFAULT_PLAN_MATRIX;
    const matrixSpec =
      planMatrix[planKey] || DEFAULT_PLAN_MATRIX[planKey] || DEFAULT_PLAN_MATRIX.growth;
    const dunningPolicy = configDoc?.dunningPolicy || DEFAULT_DUNNING_POLICY;

    const tenantOid = new Types.ObjectId(auth.tenantId);

    const safeCount = async (colName: string) => {
      try {
        return await this.tenantModel.db
          .collection(colName)
          .countDocuments({ tenantId: tenantOid });
      } catch {
        return 0;
      }
    };

    const safeDocumentBytes = async () => {
      try {
        const rows = await this.tenantModel.db
          .collection('documents')
          .aggregate<{ totalBytes: number }>([
            { $match: { tenantId: tenantOid } },
            {
              $group: {
                _id: null,
                totalBytes: { $sum: { $ifNull: ['$fileSizeBytes', 0] } },
              },
            },
          ])
          .toArray();
        return Number(rows[0]?.totalBytes || 0);
      } catch {
        return 0;
      }
    };

    const [
      activeSeats,
      totalSeats,
      leadsCount,
      dealsCount,
      invoicesCount,
      conversationsCount,
      documentsCount,
      documentBytes,
    ] = await Promise.all([
      this.userModel
        .countDocuments({ tenantId: tenantOid, isActive: true })
        .exec(),
      this.userModel.countDocuments({ tenantId: tenantOid }).exec(),
      safeCount('leads'),
      safeCount('deals'),
      safeCount('invoices'),
      safeCount('conversations'),
      safeCount('documents'),
      safeDocumentBytes(),
    ]);

    const seatLimit = Math.max(
      1,
      tenant.seatLimitOverride ?? matrixSpec.seatLimit ?? PLAN_CATALOG[planKey]?.seatLimit ?? 12,
    );
    const quotas = tenant.quotas || {
      maxMonthlyAiCalls: matrixSpec.maxMonthlyAiCalls,
      maxMonthlyWhatsapp: matrixSpec.maxMonthlyWhatsapp,
      aiCallsUsed: 0,
      whatsappUsed: 0,
      maxStorageMb: matrixSpec.maxStorageMb,
      aiCostInr: 0,
      whatsappCostInr: 0,
      addonAiCalls: 0,
      addonWhatsapp: 0,
      lastMeterResetAt: '',
    };

    const aiAddonBalance = Math.max(0, Number(quotas.addonAiCalls || 0));
    const aiLimit = Math.max(
      1,
      Number(quotas.maxMonthlyAiCalls ?? matrixSpec.maxMonthlyAiCalls ?? 2500),
    );
    const aiUsed = Math.max(0, Number(quotas.aiCallsUsed || 0));
    const aiPct = Math.min(100, Math.round((aiUsed / aiLimit) * 100));

    const waAddonBalance = Math.max(0, Number(quotas.addonWhatsapp || 0));
    const waLimit = Math.max(
      1,
      Number(quotas.maxMonthlyWhatsapp ?? matrixSpec.maxMonthlyWhatsapp ?? 5000),
    );
    const waUsed = Math.max(0, Number(quotas.whatsappUsed || 0));
    const waPct = Math.min(100, Math.round((waUsed / waLimit) * 100));

    // Compute storage used from uploaded Document Vault bytes + CRM database footprint (~25KB/record)
    const crmFootprintBytes =
      (leadsCount + dealsCount + invoicesCount + conversationsCount) * 25 * 1024;
    const totalUsedMb = Number(
      ((documentBytes + crmFootprintBytes) / (1024 * 1024)).toFixed(2),
    );
    const storageLimitMb = Math.max(
      100,
      Number(quotas.maxStorageMb ?? matrixSpec.maxStorageMb ?? 2048),
    );
    const storagePct = Math.min(
      100,
      Math.round((totalUsedMb / storageLimitMb) * 100),
    );

    // Renewal & Dunning Grace Period calculation
    const paidInvoices = (tenant.subscriptionInvoices || []).filter(
      (i) => i.status === 'paid' || i.status === 'complimentary_grant' || i.status === 'trial_complimentary',
    );
    const latestPaidInv = paidInvoices[paidInvoices.length - 1];
    const periodEndIso =
      latestPaidInv?.periodEnd ||
      tenant.trialEndsAt ||
      new Date(Date.now() + 14 * 86400000).toISOString();

    const periodEndMs = new Date(periodEndIso).getTime();
    const daysRemaining = Number.isFinite(periodEndMs)
      ? Math.ceil((periodEndMs - Date.now()) / 86400000)
      : 14;
    const gracePeriodDays = Math.max(
      0,
      Number(dunningPolicy.gracePeriodDays ?? 3),
    );
    const inGracePeriod = daysRemaining < 0 && Math.abs(daysRemaining) <= gracePeriodDays;
    const expiredBeyondGrace = daysRemaining < -gracePeriodDays;
    const dunningState:
      | 'active'
      | 'expiring_soon'
      | 'grace_period'
      | 'past_due_action_required' = expiredBeyondGrace
      ? 'past_due_action_required'
      : inGracePeriod
        ? 'grace_period'
        : daysRemaining <= 7
          ? 'expiring_soon'
          : 'active';

    const resolveAlert = (pct: number): 'ok' | 'warning' | 'exceeded' =>
      pct >= 100 ? 'exceeded' : pct >= 80 ? 'warning' : 'ok';

    const topupRequests = [...(tenant.topupRequests || [])].sort((a, b) =>
      (b.createdAt || '').localeCompare(a.createdAt || ''),
    );

    return {
      plan: {
        id: planKey,
        name: PLAN_CATALOG[planKey]?.name || matrixSpec.name || 'Growth Plan',
        status: tenant.status || 'active',
        billingCycle: latestPaidInv?.billingCycle || 'monthly',
      },
      renewal: {
        periodEnd: String(periodEndIso).slice(0, 10),
        daysRemaining,
        gracePeriodDays,
        inGracePeriod,
        expiredBeyondGrace,
        dunningState,
        autoActionOnExpiry: dunningPolicy.autoActionOnExpiry || 'pause_writes',
        reminderDaysBeforeExpiry:
          dunningPolicy.reminderDaysBeforeExpiry || [7, 3, 1],
      },
      seats: {
        used: activeSeats,
        totalInvited: totalSeats,
        limit: seatLimit,
        pct: Math.min(100, Math.round((activeSeats / seatLimit) * 100)),
        remaining: Math.max(0, seatLimit - activeSeats),
        alertLevel: resolveAlert(Math.round((activeSeats / seatLimit) * 100)),
      },
      aiCalls: {
        used: aiUsed,
        limit: aiLimit,
        baseIncluded: Math.max(0, aiLimit - aiAddonBalance),
        addonBalance: aiAddonBalance,
        remaining: Math.max(0, aiLimit - aiUsed),
        pct: aiPct,
        estimatedCostInr: Number((quotas.aiCostInr ?? aiUsed * 0.35).toFixed(2)),
        lastMeterResetAt: quotas.lastMeterResetAt || '',
        alertLevel: resolveAlert(aiPct),
      },
      whatsapp: {
        used: waUsed,
        limit: waLimit,
        baseIncluded: Math.max(0, waLimit - waAddonBalance),
        addonBalance: waAddonBalance,
        remaining: Math.max(0, waLimit - waUsed),
        pct: waPct,
        estimatedCostInr: Number((quotas.whatsappCostInr ?? waUsed * 0.15).toFixed(2)),
        alertLevel: resolveAlert(waPct),
      },
      storage: {
        usedMb: totalUsedMb,
        limitMb: storageLimitMb,
        remainingMb: Math.max(0, Number((storageLimitMb - totalUsedMb).toFixed(2))),
        pct: storagePct,
        alertLevel: resolveAlert(storagePct),
        recordsBreakdown: {
          documentsCount,
          documentBytes,
          leadsCount,
          dealsCount,
          invoicesCount,
          conversationsCount,
        },
      },
      topupPacks: Object.values(TOPUP_PACK_CATALOG),
      topupRequests,
    };
  }

  async validateCoupon(auth: BillingAuthContext, dto: ValidateCouponDto) {
    const isTopup = dto?.orderType === 'topup_pack';
    const tenant = await this.tenantModel.findById(auth.tenantId).exec();
    if (!tenant) {
      throw new NotFoundException('Workspace not found.');
    }

    const effectivePlan = (
      dto?.plan && PLAN_CATALOG[dto.plan] ? dto.plan : tenant.plan || 'growth'
    ) as 'starter' | 'growth' | 'enterprise';
    const billingCycle: 'monthly' | 'annual' =
      dto.billingCycle === 'annual' ? 'annual' : 'monthly';

    let listBaseAmount = 0;
    let planName = '';
    if (isTopup) {
      const pack = dto.topupPackId ? TOPUP_PACK_CATALOG[dto.topupPackId] : null;
      if (!pack) {
        throw new BadRequestException('Valid quota top-up pack is required.');
      }
      listBaseAmount = pack.priceInr;
      planName = pack.name;
    } else {
      const spec = PLAN_CATALOG[effectivePlan];
      if (!spec) {
        throw new BadRequestException('Valid subscription plan is required.');
      }
      listBaseAmount =
        billingCycle === 'annual' ? spec.annualPrice : spec.monthlyPrice;
      planName = spec.name;
    }

    const evaluated = await this.evaluateCoupon({
      code: dto.code,
      plan: effectivePlan,
      billingCycle,
      listBaseAmount,
    });

    if (!evaluated.coupon) {
      throw new BadRequestException('Please enter a promo or coupon code.');
    }

    const gst = this.computeGstBreakdown(
      evaluated.netBaseAmount,
      tenant.state || tenant.city || 'Delhi (07)',
    );

    return {
      valid: true,
      coupon: {
        code: evaluated.coupon.code,
        discountType: evaluated.coupon.discountType,
        discountValue: evaluated.coupon.discountValue,
        description:
          evaluated.coupon.description ||
          (evaluated.coupon.discountType === 'percent'
            ? `${evaluated.coupon.discountValue}% off before 18% GST`
            : `₹${evaluated.coupon.discountValue.toLocaleString('en-IN')} flat discount before 18% GST`),
      },
      pricing: {
        plan: effectivePlan,
        planName,
        billingCycle,
        listBaseAmount,
        discountAmount: evaluated.discountAmount,
        netBaseAmount: gst.baseAmount,
        gstRate: gst.gstRate,
        cgstAmount: gst.cgstAmount,
        sgstAmount: gst.sgstAmount,
        igstAmount: gst.igstAmount,
        gstTotal: gst.gstTotal,
        totalAmount: gst.totalAmount,
      },
    };
  }

  private ordersCollection() {
    return this.tenantModel.db.collection<BillingCheckoutOrderDoc>(
      'billing_checkout_orders',
    );
  }

  async createCheckoutOrder(
    auth: BillingAuthContext,
    dto: CreateCheckoutOrderDto,
  ) {
    if (!['owner', 'admin'].includes(auth.role)) {
      throw new ForbiddenException(
        'Only workspace Owners or Admins can purchase or upgrade plans or add-on packs.',
      );
    }

    const tenant = await this.tenantModel.findById(auth.tenantId).exec();
    if (!tenant) {
      throw new NotFoundException('Workspace not found.');
    }

    const orderType: 'subscription' | 'topup_pack' =
      dto?.orderType === 'topup_pack' ? 'topup_pack' : 'subscription';

    const planKey = (
      dto?.plan && PLAN_CATALOG[dto.plan] ? dto.plan : tenant.plan || 'growth'
    ) as 'starter' | 'growth' | 'enterprise';
    const spec = PLAN_CATALOG[planKey];
    const billingCycle: 'monthly' | 'annual' =
      dto?.billingCycle === 'annual' ? 'annual' : 'monthly';

    let topupPack: TopupPackSpec | null = null;
    if (orderType === 'topup_pack') {
      topupPack = dto?.topupPackId
        ? TOPUP_PACK_CATALOG[dto.topupPackId] || null
        : null;
      if (!topupPack) {
        throw new BadRequestException('Valid quota top-up pack is required.');
      }
    } else if (!dto?.plan || !PLAN_CATALOG[dto.plan]) {
      throw new BadRequestException('Valid subscription plan is required.');
    }

    const listBaseAmount = topupPack
      ? topupPack.priceInr
      : billingCycle === 'annual'
        ? spec.annualPrice
        : spec.monthlyPrice;
    const itemTitle = topupPack ? topupPack.name : spec.name;

    const proratedCreditAmount =
      !topupPack
        ? this.computeProrationForTenant(tenant, planKey, billingCycle)
            .proratedCreditInr
        : 0;
    const netAfterProration = Math.max(0, listBaseAmount - proratedCreditAmount);

    const evaluated = await this.evaluateCoupon({
      code: dto.couponCode,
      plan: planKey,
      billingCycle,
      listBaseAmount: netAfterProration,
    });

    const gst = this.computeGstBreakdown(
      evaluated.netBaseAmount,
      tenant.state || tenant.city || 'Delhi (07)',
    );
    const amountPaise = Math.max(0, gst.totalAmount * 100);
    const rzp = await this.getRazorpayConfig();
    const receipt = `${topupPack ? 'lspack' : 'lssub'}_${
      tenant.accountId || tenant._id.toString().slice(-6)
    }_${Date.now()}`;

    let orderId = `order_ls_${randomBytes(7).toString('hex')}`;
    let mode: 'razorpay_live' | 'razorpay_sandbox' = 'razorpay_sandbox';

    if (rzp.isLiveConfigured && amountPaise > 0) {
      try {
        const basicAuth = Buffer.from(
          `${rzp.keyId}:${rzp.keySecret}`,
          'utf8',
        ).toString('base64');
        const rzpRes = await axios.post<{ id: string }>(
          `${rzp.apiBase}/orders`,
          {
            amount: amountPaise,
            currency: 'INR',
            receipt,
            notes: {
              tenantId: tenant._id.toString(),
              accountId: tenant.accountId || '',
              orderType,
              plan: planKey,
              billingCycle,
              topupPackId: topupPack?.id || '',
              couponCode: evaluated.couponCode,
            },
          },
          {
            headers: {
              Authorization: `Basic ${basicAuth}`,
              'Content-Type': 'application/json',
            },
            timeout: 8000,
          },
        );
        if (rzpRes.data?.id) {
          orderId = rzpRes.data.id;
          mode = 'razorpay_live';
        }
      } catch (err) {
        this.logger.warn(
          `Razorpay Orders API fallback to Leadsetu signed order: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    const nowIso = new Date().toISOString();
    const recipientLabel =
      tenant.companyName?.trim() || tenant.name || 'Leadsetu Workspace';
    const defaultGreeting = topupPack
      ? `Instant Quota Add-On Activated for ${recipientLabel}: ${topupPack.name} (${topupPack.description}).`
      : `Dear ${recipientLabel} Team, thank you for choosing Leadsetu to bridge every B2B lead, deal, and GST workflow! Your ${spec.name} is active with 18% GST Input Tax Credit eligibility. Warm regards, Team Leadsetu (New Delhi).`;

    const orderDoc: BillingCheckoutOrderDoc = {
      orderId,
      orderType,
      ...(topupPack
        ? {
            topupPackId: topupPack.id,
            addonAiCalls: topupPack.addonAiCalls,
            addonWhatsapp: topupPack.addonWhatsapp,
            addonCallingInr: topupPack.addonCallingInr || 0,
            addonStorageMb: topupPack.addonStorageMb,
          }
        : {}),
      tenantId: tenant._id,
      userId: auth.userId,
      userEmail: auth.email,
      plan: planKey,
      planName: itemTitle,
      billingCycle,
      seatsIncluded: tenant.seatLimitOverride ?? spec.seatLimit,
      listBaseAmount,
      proratedCreditAmount,
      discountAmount: evaluated.discountAmount,
      netBaseAmount: gst.baseAmount,
      gstRate: gst.gstRate,
      cgstAmount: gst.cgstAmount,
      sgstAmount: gst.sgstAmount,
      igstAmount: gst.igstAmount,
      totalAmount: gst.totalAmount,
      amountPaise,
      currency: 'INR',
      couponCode: evaluated.couponCode,
      greetingNote: dto.greetingNote?.trim() || defaultGreeting,
      mode,
      status: 'created',
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    await this.ordersCollection().insertOne(orderDoc);

    return {
      orderId,
      orderType,
      topupPackId: topupPack?.id,
      keyId: rzp.keyId,
      mode,
      currency: 'INR',
      amountPaise,
      plan: planKey,
      planName: itemTitle,
      billingCycle,
      couponCode: evaluated.couponCode,
      pricing: {
        listBaseAmount,
        proratedCreditAmount,
        discountAmount: evaluated.discountAmount,
        netBaseAmount: gst.baseAmount,
        gstRate: gst.gstRate,
        cgstAmount: gst.cgstAmount,
        sgstAmount: gst.sgstAmount,
        igstAmount: gst.igstAmount,
        gstTotal: gst.gstTotal,
        totalAmount: gst.totalAmount,
      },
      prefill: {
        name: recipientLabel,
        email: tenant.email || auth.email,
        contact: tenant.phone || '',
        companyName: recipientLabel,
        gstin: tenant.gstin || '',
      },
      seller: LEADSETU_SELLER,
    };
  }

  public async computePaymentSignature(
    orderId: string,
    paymentId: string,
  ): Promise<string> {
    const { signingSecret } = await this.getRazorpayConfig();
    return createHmac('sha256', signingSecret)
      .update(`${orderId}|${paymentId}`)
      .digest('hex');
  }

  private verifyHmacSignature(
    expectedHex: string,
    providedHex: string,
  ): boolean {
    if (!expectedHex || !providedHex) return false;
    try {
      const a = Buffer.from(expectedHex.trim().toLowerCase(), 'utf8');
      const b = Buffer.from(providedHex.trim().toLowerCase(), 'utf8');
      if (a.length !== b.length) return false;
      return timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }

  async authorizeSandboxOrder(
    auth: BillingAuthContext,
    dto: SandboxAuthorizeCheckoutDto,
  ) {
    if (!dto?.razorpayOrderId?.trim()) {
      throw new BadRequestException('razorpayOrderId is required.');
    }
    const order = await this.ordersCollection().findOne({
      orderId: dto.razorpayOrderId.trim(),
      tenantId: new Types.ObjectId(auth.tenantId),
    });
    if (!order) {
      throw new NotFoundException('Checkout order not found for this workspace.');
    }

    const razorpayPaymentId = `pay_ls_${randomBytes(7).toString('hex')}`;
    const razorpaySignature = await this.computePaymentSignature(
      order.orderId,
      razorpayPaymentId,
    );

    return {
      razorpayOrderId: order.orderId,
      razorpayPaymentId,
      razorpaySignature,
      paymentMode: dto.paymentMode?.trim() || 'Razorpay UPI / Corporate NetBanking',
    };
  }

  private async fulfillPaidOrder(
    order: BillingCheckoutOrderDoc,
    paymentId: string,
    paymentMode = 'Razorpay UPI / NEFT Corporate',
    greetingOverride?: string,
  ): Promise<{
    tenant: TenantDocument;
    invoice: SubscriptionInvoiceRecord;
    alreadyPaid: boolean;
  }> {
    const tenant = await this.tenantModel.findById(order.tenantId).exec();
    if (!tenant) {
      throw new NotFoundException('Workspace not found for checkout order.');
    }

    // Idempotency check: if already fulfilled, return the existing invoice
    if (order.status === 'paid' && order.invoiceId) {
      const existingInv = (tenant.subscriptionInvoices || []).find(
        (inv) => inv.id === order.invoiceId || inv.paymentReference === paymentId,
      );
      if (existingInv) {
        return { tenant, invoice: existingInv, alreadyPaid: true };
      }
    }

    // Redeem coupon if present on the order
    if (order.couponCode) {
      const coupon = await this.couponModel
        .findOne({ code: order.couponCode.toUpperCase() })
        .exec();
      if (coupon && coupon.isActive) {
        coupon.redemptionsCount = (coupon.redemptionsCount || 0) + 1;
        coupon.totalDiscountGivenInr =
          (coupon.totalDiscountGivenInr || 0) + (order.discountAmount || 0);
        await coupon.save();
      }
    }

    const now = new Date();
    const periodEndDate = new Date(
      now.getTime() +
        (order.billingCycle === 'annual' ? 365 : 30) * 86400000,
    );
    const existingInvoices = Array.isArray(tenant.subscriptionInvoices)
      ? tenant.subscriptionInvoices
      : [];
    const seq = existingInvoices.length + 1;
    const isTopupOrder = order.orderType === 'topup_pack';
    const invoiceNumber = `${isTopupOrder ? 'LS-ADDON' : 'LS-SUB'}-${now.getFullYear()}-${String(100 + seq)}`;
    const recipientLabel =
      tenant.companyName?.trim() || tenant.name || 'Leadsetu Workspace';
    const buyerState = (tenant.state || tenant.city || 'Delhi (07)').trim();

    const newInvoice: SubscriptionInvoiceRecord = {
      id: `${isTopupOrder ? 'addon' : 'sub'}-${Date.now()}-${randomBytes(2).toString('hex')}`,
      invoiceNumber,
      plan: order.plan,
      planName: order.planName,
      billingCycle: order.billingCycle,
      seatsIncluded: order.seatsIncluded,
      baseAmount: order.netBaseAmount,
      gstRate: order.gstRate,
      cgstAmount: order.cgstAmount,
      sgstAmount: order.sgstAmount,
      igstAmount: order.igstAmount,
      totalAmount: order.totalAmount,
      status: 'paid',
      discountAmount: order.discountAmount || 0,
      proratedCreditAmount: order.proratedCreditAmount || 0,
      couponCode: order.couponCode || '',
      partnerCode: '',
      tdsDeducted: 0,
      refundReason: '',
      refundedAt: '',
      issuedByEmail: order.userEmail,
      paymentMode: paymentMode.trim() || 'Razorpay UPI / NEFT Corporate',
      paymentReference: paymentId,
      issuedAt: now.toISOString(),
      periodStart: now.toISOString().slice(0, 10),
      periodEnd: periodEndDate.toISOString().slice(0, 10),
      sacCode: '998314',
      greetingNote: greetingOverride?.trim() || order.greetingNote,
      buyerCompany: recipientLabel,
      buyerGstin: tenant.gstin || 'Unregistered / Applied',
      buyerState,
      buyerAddress: tenant.address || `${tenant.city || 'New Delhi'}, India`,
      buyerEmail: tenant.email || order.userEmail,
      ...LEADSETU_SELLER,
    };

    if (isTopupOrder) {
      const planMatrix = DEFAULT_PLAN_MATRIX[tenant.plan || 'growth'];
      const currentQuotas = tenant.quotas || {
        maxMonthlyAiCalls: planMatrix.maxMonthlyAiCalls,
        maxMonthlyWhatsapp: planMatrix.maxMonthlyWhatsapp,
        aiCallsUsed: 0,
        whatsappUsed: 0,
        maxStorageMb: planMatrix.maxStorageMb,
        aiCostInr: 0,
        whatsappCostInr: 0,
        addonAiCalls: 0,
        addonWhatsapp: 0,
        lastMeterResetAt: '',
      };
      const addAi = Math.max(0, Number(order.addonAiCalls || 0));
      const addWa = Math.max(0, Number(order.addonWhatsapp || 0));
      const addCallInr = Math.max(0, Number(order.addonCallingInr || 0));
      const addMb = Math.max(0, Number(order.addonStorageMb || 0));

      currentQuotas.maxMonthlyAiCalls =
        (currentQuotas.maxMonthlyAiCalls ?? planMatrix.maxMonthlyAiCalls) + addAi;
      currentQuotas.maxMonthlyWhatsapp =
        (currentQuotas.maxMonthlyWhatsapp ?? planMatrix.maxMonthlyWhatsapp) + addWa;
      currentQuotas.maxStorageMb =
        (currentQuotas.maxStorageMb ?? planMatrix.maxStorageMb) + addMb;
      currentQuotas.addonAiCalls = (currentQuotas.addonAiCalls || 0) + addAi;
      currentQuotas.addonWhatsapp = (currentQuotas.addonWhatsapp || 0) + addWa;

      tenant.quotas = currentQuotas;
      tenant.markModified('quotas');

      if (addCallInr > 0) {
        const starterDefault = tenant.callingWalletStarterGranted ? 0 : 25;
        const prevBal = Number(
          tenant.callingWalletBalanceInr ?? starterDefault,
        );
        const nextBal = Number((prevBal + addCallInr).toFixed(4));
        tenant.callingWalletBalanceInr = nextBal;
        tenant.callingWalletTotalTopupInr = Number(
          ((tenant.callingWalletTotalTopupInr || 0) + addCallInr).toFixed(4),
        );
        tenant.callingWalletStarterGranted = true;

        await this.tenantModel.db
          .collection('calling_wallet_transactions')
          .insertOne({
            tenantId: tenant._id,
            type: 'razorpay_topup',
            amountInr: addCallInr,
            balanceAfterInr: nextBal,
            referenceId: newInvoice.invoiceNumber,
            description: `${order.planName} via ${newInvoice.paymentMode}`,
            actorEmail: order.userEmail,
            createdAt: now,
            updatedAt: now,
          });
      }
    } else {
      const prevPlan = tenant.plan;
      let matrixSpec =
        DEFAULT_PLAN_MATRIX[order.plan] || DEFAULT_PLAN_MATRIX.growth;
      try {
        if (this.platformConfigModel) {
          const cfg = await this.platformConfigModel
            .findOne({ key: 'global' })
            .lean()
            .exec();
          if (cfg?.planMatrix?.[order.plan]) {
            matrixSpec = cfg.planMatrix[order.plan];
          }
        }
      } catch {
        // fallback to DEFAULT_PLAN_MATRIX
      }

      tenant.plan = order.plan;
      tenant.status = 'active';
      tenant.trialEndsAt = periodEndDate.toISOString();
      tenant.lastExpiryReminderDate = '';

      // Single active plan rule: switching/renewing strictly replaces quotas with the new plan's limits
      // so previous plan benefits/limits no longer remain active.
      tenant.quotas = {
        maxMonthlyAiCalls: matrixSpec.maxMonthlyAiCalls,
        maxMonthlyWhatsapp: matrixSpec.maxMonthlyWhatsapp,
        aiCallsUsed: 0,
        whatsappUsed: 0,
        maxStorageMb: matrixSpec.maxStorageMb,
        aiCostInr: 0,
        whatsappCostInr: 0,
        addonAiCalls: 0,
        addonWhatsapp: 0,
        lastMeterResetAt: now.toISOString(),
      };
      tenant.markModified('quotas');

      if (prevPlan !== order.plan) {
        tenant.seatLimitOverride = null;
      }

      tenant.subscriptionLifecycle = {
        autoRenew: true,
        cancelAtPeriodEnd: false,
        cancellationReason: '',
        cancelledAt: '',
        scheduledDowngradePlan: '',
        scheduledDowngradeCycle: '',
        scheduledForDate: '',
      };
      tenant.markModified('subscriptionLifecycle');
    }

    tenant.subscriptionInvoices = [...existingInvoices, newInvoice];
    tenant.markModified('subscriptionInvoices');
    await tenant.save();

    await this.ordersCollection().updateOne(
      { orderId: order.orderId },
      {
        $set: {
          status: 'paid',
          paymentId,
          paymentMode: newInvoice.paymentMode,
          invoiceId: newInvoice.id,
          invoiceNumber: newInvoice.invoiceNumber,
          verifiedAt: now.toISOString(),
          updatedAt: now.toISOString(),
        },
      },
    );

    await this.auditService?.record({
      tenantId: tenant._id.toString(),
      actorId: order.userId,
      actorEmail: order.userEmail,
      action: 'subscription.razorpay_verified',
      entityType: 'invoice',
      entityId: newInvoice.id,
      entityLabel: `${newInvoice.invoiceNumber} · ${newInvoice.planName}`,
      summary: `Verified Razorpay payment ${paymentId} (${order.orderId}) for ${newInvoice.planName} (${order.billingCycle})${
        order.couponCode
          ? ` with coupon ${order.couponCode} (-₹${order.discountAmount.toLocaleString('en-IN')})`
          : ''
      } · Total ₹${newInvoice.totalAmount.toLocaleString('en-IN')} incl. 18% GST`,
    });

    return { tenant, invoice: newInvoice, alreadyPaid: false };
  }

  async verifyCheckoutPayment(
    auth: BillingAuthContext,
    dto: VerifyCheckoutPaymentDto,
  ) {
    if (!['owner', 'admin'].includes(auth.role)) {
      throw new ForbiddenException(
        'Only workspace Owners or Admins can verify subscription payments.',
      );
    }
    const orderId = (dto?.razorpayOrderId || '').trim();
    const paymentId = (dto?.razorpayPaymentId || '').trim();
    const signature = (dto?.razorpaySignature || '').trim();

    if (!orderId || !paymentId || !signature) {
      throw new BadRequestException(
        'razorpayOrderId, razorpayPaymentId, and razorpaySignature are required.',
      );
    }

    const order = await this.ordersCollection().findOne({
      orderId,
      tenantId: new Types.ObjectId(auth.tenantId),
    });
    if (!order) {
      throw new NotFoundException('Checkout order not found for this workspace.');
    }

    const expectedSignature = await this.computePaymentSignature(
      orderId,
      paymentId,
    );
    if (!this.verifyHmacSignature(expectedSignature, signature)) {
      throw new BadRequestException(
        'Razorpay HMAC-SHA256 payment signature verification failed.',
      );
    }

    const fulfilled = await this.fulfillPaidOrder(
      order,
      paymentId,
      dto.paymentMode || 'Razorpay UPI / Corporate NetBanking',
      dto.greetingNote,
    );

    const summary = await this.getSummary(auth);
    return {
      ...summary,
      verified: true,
      alreadyPaid: fulfilled.alreadyPaid,
      orderId,
      paymentId,
      latestInvoice: fulfilled.invoice,
    };
  }

  async handleRazorpayWebhook(
    rawBody: Buffer | string | undefined,
    signatureHeader: string | undefined,
    payload: Record<string, unknown>,
  ) {
    const { webhookSecret } = await this.getRazorpayConfig();
    const rawPayload =
      Buffer.isBuffer(rawBody)
        ? rawBody
        : Buffer.from(
            typeof rawBody === 'string' && rawBody.length > 0
              ? rawBody
              : JSON.stringify(payload || {}),
            'utf8',
          );

    const expectedSignature = createHmac('sha256', webhookSecret)
      .update(rawPayload)
      .digest('hex');

    if (!this.verifyHmacSignature(expectedSignature, signatureHeader || '')) {
      throw new UnauthorizedException('Invalid Razorpay webhook signature.');
    }

    const eventType = String(payload?.event || '').trim();
    const payloadObj = (payload?.payload || {}) as Record<
      string,
      { entity?: Record<string, unknown> }
    >;
    const paymentEntity = payloadObj.payment?.entity || {};
    const orderEntity = payloadObj.order?.entity || {};
    const refundEntity = payloadObj.refund?.entity || {};

    const orderId = String(
      paymentEntity.order_id || orderEntity.id || '',
    ).trim();
    const paymentId = String(
      refundEntity.payment_id || paymentEntity.id || '',
    ).trim();

    if (eventType === 'payment.captured' || eventType === 'order.paid') {
      if (!orderId) {
        return { received: true, event: eventType, action: 'ignored_no_order_id' };
      }
      const order = await this.ordersCollection().findOne({ orderId });
      if (!order) {
        return {
          received: true,
          event: eventType,
          orderId,
          action: 'order_not_found',
        };
      }
      const methodLabel = paymentEntity.method
        ? `Razorpay ${String(paymentEntity.method).toUpperCase()}`
        : 'Razorpay Webhook Capture';
      const fulfilled = await this.fulfillPaidOrder(
        order,
        paymentId || `pay_wh_${Date.now()}`,
        methodLabel,
      );
      return {
        received: true,
        event: eventType,
        orderId,
        paymentId: fulfilled.invoice.paymentReference,
        invoiceNumber: fulfilled.invoice.invoiceNumber,
        alreadyPaid: fulfilled.alreadyPaid,
        action: fulfilled.alreadyPaid ? 'already_fulfilled' : 'plan_activated',
      };
    }

    if (eventType === 'payment.failed') {
      const reason = String(
        paymentEntity.error_description ||
          paymentEntity.error_reason ||
          'Payment declined by bank/UPI',
      );
      if (orderId) {
        await this.ordersCollection().updateOne(
          { orderId },
          {
            $set: {
              status: 'failed',
              paymentId,
              failureReason: reason,
              updatedAt: new Date().toISOString(),
            },
          },
        );
      }
      return {
        received: true,
        event: eventType,
        orderId,
        paymentId,
        failureReason: reason,
        action: 'marked_failed',
      };
    }

    if (eventType === 'refund.created' || eventType === 'payment.refunded') {
      const order = orderId
        ? await this.ordersCollection().findOne({ orderId })
        : paymentId
          ? await this.ordersCollection().findOne({ paymentId })
          : null;

      let refundedInvoiceNumber = '';
      const nowIso = new Date().toISOString();
      const refundReason = String(
        (refundEntity.notes as Record<string, unknown> | undefined)?.reason ||
          'Refund processed via Razorpay Webhook',
      );

      if (order) {
        await this.ordersCollection().updateOne(
          { orderId: order.orderId },
          {
            $set: {
              status: 'refunded',
              refundedAt: nowIso,
              updatedAt: nowIso,
            },
          },
        );

        const tenant = await this.tenantModel.findById(order.tenantId).exec();
        if (tenant && Array.isArray(tenant.subscriptionInvoices)) {
          let matched = false;
          tenant.subscriptionInvoices = tenant.subscriptionInvoices.map((inv) => {
            if (
              inv.id === order.invoiceId ||
              (paymentId && inv.paymentReference === paymentId)
            ) {
              matched = true;
              refundedInvoiceNumber = inv.invoiceNumber;
              return {
                ...inv,
                status: 'refunded' as const,
                refundedAt: nowIso,
                refundReason,
              };
            }
            return inv;
          });
          if (matched) {
            tenant.markModified('subscriptionInvoices');
            await tenant.save();
          }
        }
      }

      return {
        received: true,
        event: eventType,
        orderId: order?.orderId || orderId,
        paymentId,
        invoiceNumber: refundedInvoiceNumber,
        action: refundedInvoiceNumber ? 'invoice_refunded' : 'refund_logged',
      };
    }

    return {
      received: true,
      event: eventType,
      action: 'unhandled_event_acknowledged',
    };
  }

  async cancelSubscriptionAtPeriodEnd(
    auth: BillingAuthContext,
    body: { reason?: string },
  ) {
    if (!['owner', 'admin'].includes(auth.role)) {
      throw new ForbiddenException(
        'Only workspace Owners or Admins can pause or cancel subscription renewal.',
      );
    }
    const tenant = await this.tenantModel.findById(auth.tenantId).exec();
    if (!tenant) throw new NotFoundException('Workspace not found.');

    const paidInvoices = (tenant.subscriptionInvoices || []).filter(
      (i) =>
        i.status === 'paid' &&
        !String(i.invoiceNumber || '').startsWith('LS-ADDON'),
    );
    const periodEnd =
      paidInvoices[paidInvoices.length - 1]?.periodEnd ||
      tenant.trialEndsAt ||
      new Date(Date.now() + 14 * 86400000).toISOString();

    const nowIso = new Date().toISOString();
    const reason =
      (body?.reason || '').trim() || 'Paused / cancelled auto-renewal at period end';

    tenant.subscriptionLifecycle = {
      ...(tenant.subscriptionLifecycle || {}),
      autoRenew: false,
      cancelAtPeriodEnd: true,
      cancellationReason: reason,
      cancelledAt: nowIso,
      scheduledDowngradePlan:
        tenant.subscriptionLifecycle?.scheduledDowngradePlan || '',
      scheduledDowngradeCycle:
        tenant.subscriptionLifecycle?.scheduledDowngradeCycle || '',
      scheduledForDate: String(periodEnd).slice(0, 10),
    };
    tenant.markModified('subscriptionLifecycle');
    await tenant.save();

    await this.auditService?.record({
      tenantId: auth.tenantId,
      actorId: auth.userId,
      actorEmail: auth.email,
      action: 'subscription.auto_renew_paused',
      entityType: 'security',
      entityId: tenant._id.toString(),
      entityLabel: tenant.name,
      summary: `Paused/cancelled auto-renewal at period end (${String(periodEnd).slice(0, 10)}): ${reason}`,
    });

    return {
      lifecycle: tenant.subscriptionLifecycle,
      summary: `Auto-renewal paused. Workspace stays active on ${tenant.plan.toUpperCase()} until ${String(periodEnd).slice(0, 10)}.`,
    };
  }

  async resumeAutoRenewal(auth: BillingAuthContext) {
    if (!['owner', 'admin'].includes(auth.role)) {
      throw new ForbiddenException(
        'Only workspace Owners or Admins can manage subscription auto-renewal.',
      );
    }
    const tenant = await this.tenantModel.findById(auth.tenantId).exec();
    if (!tenant) throw new NotFoundException('Workspace not found.');

    tenant.subscriptionLifecycle = {
      autoRenew: true,
      cancelAtPeriodEnd: false,
      cancellationReason: '',
      cancelledAt: '',
      scheduledDowngradePlan: '',
      scheduledDowngradeCycle: '',
      scheduledForDate: '',
    };
    tenant.markModified('subscriptionLifecycle');
    await tenant.save();

    await this.auditService?.record({
      tenantId: auth.tenantId,
      actorId: auth.userId,
      actorEmail: auth.email,
      action: 'subscription.auto_renew_resumed',
      entityType: 'security',
      entityId: tenant._id.toString(),
      entityLabel: tenant.name,
      summary: `Resumed subscription auto-renewal & cleared pending downgrade/cancellation.`,
    });

    return {
      lifecycle: tenant.subscriptionLifecycle,
      summary: 'Auto-renewal resumed and scheduled plan changes cleared.',
    };
  }

  async schedulePlanDowngrade(
    auth: BillingAuthContext,
    body: {
      targetPlan: 'starter' | 'growth';
      billingCycle?: 'monthly' | 'annual';
      reason?: string;
    },
  ) {
    if (!['owner', 'admin'].includes(auth.role)) {
      throw new ForbiddenException(
        'Only workspace Owners or Admins can schedule a plan downgrade.',
      );
    }
    if (!body?.targetPlan || !['starter', 'growth'].includes(body.targetPlan)) {
      throw new BadRequestException(
        'Downgrade targetPlan must be starter or growth.',
      );
    }
    const tenant = await this.tenantModel.findById(auth.tenantId).exec();
    if (!tenant) throw new NotFoundException('Workspace not found.');

    const planRank: Record<'starter' | 'growth' | 'enterprise', number> = {
      starter: 1,
      growth: 2,
      enterprise: 3,
    };
    const currentPlan = (tenant.plan || 'growth') as
      | 'starter'
      | 'growth'
      | 'enterprise';
    if (planRank[body.targetPlan] >= planRank[currentPlan]) {
      throw new BadRequestException(
        `Target plan (${body.targetPlan}) must be lower than current plan (${currentPlan}). Use checkout to upgrade.`,
      );
    }

    const paidInvoices = (tenant.subscriptionInvoices || []).filter(
      (i) =>
        i.status === 'paid' &&
        !String(i.invoiceNumber || '').startsWith('LS-ADDON'),
    );
    const periodEnd =
      paidInvoices[paidInvoices.length - 1]?.periodEnd ||
      tenant.trialEndsAt ||
      new Date(Date.now() + 14 * 86400000).toISOString();
    const targetCycle: 'monthly' | 'annual' =
      body.billingCycle === 'annual' ? 'annual' : 'monthly';
    const scheduledForDate = String(periodEnd).slice(0, 10);

    tenant.subscriptionLifecycle = {
      autoRenew: true,
      cancelAtPeriodEnd: false,
      cancellationReason: (body.reason || '').trim(),
      cancelledAt: '',
      scheduledDowngradePlan: body.targetPlan,
      scheduledDowngradeCycle: targetCycle,
      scheduledForDate,
    };
    tenant.markModified('subscriptionLifecycle');
    await tenant.save();

    await this.auditService?.record({
      tenantId: auth.tenantId,
      actorId: auth.userId,
      actorEmail: auth.email,
      action: 'subscription.downgrade_scheduled',
      entityType: 'security',
      entityId: tenant._id.toString(),
      entityLabel: tenant.name,
      summary: `Scheduled downgrade ${currentPlan.toUpperCase()} -> ${body.targetPlan.toUpperCase()} (${targetCycle}) effective ${scheduledForDate}`,
    });

    return {
      lifecycle: tenant.subscriptionLifecycle,
      summary: `Downgrade to ${PLAN_CATALOG[body.targetPlan].name} (${targetCycle}) scheduled for ${scheduledForDate}. You retain full ${PLAN_CATALOG[currentPlan].name} features until then.`,
    };
  }

  async listRefundRequests(auth: BillingAuthContext) {
    if (!['owner', 'admin', 'super_admin'].includes(auth.role)) {
      throw new ForbiddenException(
        'Only workspace Owners or Admins can view refund requests.',
      );
    }
    const tenant = await this.tenantModel.findById(auth.tenantId).exec();
    if (!tenant) throw new NotFoundException('Workspace not found.');

    const data = [...(tenant.refundRequests || [])].sort((a, b) =>
      (b.createdAt || '').localeCompare(a.createdAt || ''),
    );
    return { data };
  }

  async createRefundRequest(
    auth: BillingAuthContext,
    body: { invoiceId: string; reason: string },
  ) {
    if (!['owner', 'admin'].includes(auth.role)) {
      throw new ForbiddenException(
        'Only workspace Owners or Admins can raise GST Credit Note / Refund requests.',
      );
    }
    const invoiceId = (body?.invoiceId || '').trim();
    const reason = (body?.reason || '').trim();
    if (!invoiceId || !reason) {
      throw new BadRequestException(
        'Both invoiceId and refund reason are required.',
      );
    }

    const [tenant, requester] = await Promise.all([
      this.tenantModel.findById(auth.tenantId).exec(),
      this.userModel.findById(auth.userId).select('name email').lean().exec(),
    ]);
    if (!tenant) throw new NotFoundException('Workspace not found.');

    const inv = (tenant.subscriptionInvoices || []).find(
      (i) => i.id === invoiceId,
    );
    if (!inv) {
      throw new NotFoundException(
        `Subscription invoice ${invoiceId} not found on workspace.`,
      );
    }
    if (inv.status !== 'paid') {
      throw new BadRequestException(
        `Only paid invoices are eligible for a GST Credit Note / Refund request (current status: ${inv.status}).`,
      );
    }

    const existingPending = (tenant.refundRequests || []).find(
      (r) => r.invoiceId === invoiceId && r.status === 'pending',
    );
    if (existingPending) {
      throw new BadRequestException(
        `A pending refund request already exists for ${inv.invoiceNumber}.`,
      );
    }

    const record = {
      id: `refreq_${Date.now()}_${randomBytes(3).toString('hex')}`,
      invoiceId: inv.id,
      invoiceNumber: inv.invoiceNumber,
      amountInr: inv.totalAmount,
      reason: reason.slice(0, 400),
      status: 'pending' as const,
      requestedByUserId: auth.userId,
      requestedByName: requester?.name || auth.email,
      requestedByEmail: requester?.email || auth.email,
      createdAt: new Date().toISOString(),
      resolvedAt: '',
      resolvedByEmail: '',
      resolutionNote: '',
    };

    tenant.refundRequests = [record, ...(tenant.refundRequests || [])];
    tenant.markModified('refundRequests');
    await tenant.save();

    await this.auditService?.record({
      tenantId: auth.tenantId,
      actorId: auth.userId,
      actorEmail: auth.email,
      action: 'subscription.refund_requested',
      entityType: 'invoice',
      entityId: inv.id,
      entityLabel: inv.invoiceNumber,
      summary: `Requested GST Credit Note / Refund of ₹${inv.totalAmount.toLocaleString('en-IN')} on ${inv.invoiceNumber}: ${reason.slice(0, 120)}`,
    });

    const data = [...(tenant.refundRequests || [])].sort((a, b) =>
      (b.createdAt || '').localeCompare(a.createdAt || ''),
    );
    return { created: record, data };
  }
}
