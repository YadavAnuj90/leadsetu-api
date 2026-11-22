import {
  BadRequestException,
  ForbiddenException,
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
  SubscriptionInvoiceRecord,
  Tenant,
  TenantDocument,
  TopupRequestRecord,
} from '../auth/schemas/tenant.schema';
import { User, UserDocument } from '../auth/schemas/user.schema';
import { AuditService } from '../audit/audit.module';
import { sanitizeOrganizationLogoUrl } from '../auth/identity.util';
import { uploadToCloudinary } from '../auth/cloudinary.util';
import {
  DEFAULT_HIDDEN_MODULES_BY_MODE,
  normalizeBusinessMode,
} from '../auth/business-mode.util';
import { SuperAdminService } from '../super-admin/super-admin.service';
import {
  SubscribePlanDto,
  TenantAuthContext,
  UpdateTenantProfileDto,
} from './dto/tenants.dto';

export interface PlanSpec {
  id: 'starter' | 'growth' | 'enterprise';
  name: string;
  monthlyPrice: number;
  annualPrice: number;
  seatLimit: number;
  highlights: string[];
}

export const PLAN_CATALOG: Record<'starter' | 'growth' | 'enterprise', PlanSpec> = {
  starter: {
    id: 'starter',
    name: 'Starter Plan',
    monthlyPrice: 999,
    annualPrice: 9590,
    seatLimit: 4,
    highlights: [
      'Up to 4 Team Members Included',
      'Leads, Deals Kanban & B2B Contacts',
      'GST Tax Invoices & Proforma Quotations',
    ],
  },
  growth: {
    id: 'growth',
    name: 'Growth Plan',
    monthlyPrice: 2399,
    annualPrice: 23030,
    seatLimit: 12,
    highlights: [
      'Up to 12 Team Members Included',
      'Unlimited SetuAI Lead Scoring',
      'Official WhatsApp Cloud API Sync & AR Ledger',
    ],
  },
  enterprise: {
    id: 'enterprise',
    name: 'Enterprise Plan',
    monthlyPrice: 5499,
    annualPrice: 52790,
    seatLimit: 50,
    highlights: [
      'Up to 50 Team Members Included',
      'Anti-Data-Leak Shield & Custom RBAC Roles',
      'SLA Field Service Desk, Document Vault & Priority Support',
    ],
  },
};

const LEADSETU_SELLER = {
  sellerCompany: 'Leadsetu Technologies (Anujalite Tech Pvt. Ltd.)',
  sellerGstin: '07AABCL4821K1Z5',
  sellerAddress:
    'Tower B, 7th Floor, Sector 62, Noida & Connaught Place, New Delhi – 110001, India',
  sellerEmail: 'billing@leadsetu.in',
};

@Injectable()
export class TenantsService {
  constructor(
    @InjectModel(Tenant.name)
    private readonly tenantModel: Model<TenantDocument>,
    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    @Optional() private readonly auditService?: AuditService,
    @Optional() private readonly superAdminService?: SuperAdminService,
  ) {}

  async verifyAuth(authHeader?: string): Promise<TenantAuthContext> {
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

  private buildSubscriptionInvoice(
    tenant: TenantDocument,
    ownerEmail: string,
    params: {
      plan: 'starter' | 'growth' | 'enterprise';
      billingCycle: 'monthly' | 'annual';
      status: 'paid' | 'trial_complimentary';
      paymentMode: string;
      paymentReference?: string;
      greetingNote?: string;
      discountAmount?: number;
      couponCode?: string;
      seq: number;
    },
  ): SubscriptionInvoiceRecord {
    const spec = PLAN_CATALOG[params.plan] || PLAN_CATALOG.growth;
    const listBaseAmount =
      params.billingCycle === 'annual' ? spec.annualPrice : spec.monthlyPrice;
    const discountAmount = Math.min(
      listBaseAmount,
      Math.max(0, Math.round(Number(params.discountAmount || 0))),
    );
    const baseAmount = Math.max(0, listBaseAmount - discountAmount);
    const buyerState = (tenant.state || tenant.city || 'Delhi (07)').trim();
    const isIntraState =
      buyerState.toLowerCase().includes('delhi') ||
      buyerState.includes('07');
    const gstTotal = Math.round(baseAmount * 0.18);
    const cgstAmount = isIntraState ? Math.round(gstTotal / 2) : 0;
    const sgstAmount = isIntraState ? gstTotal - cgstAmount : 0;
    const igstAmount = isIntraState ? 0 : gstTotal;
    const totalAmount = baseAmount + cgstAmount + sgstAmount + igstAmount;

    const now = new Date();
    const periodEndDate = new Date(
      now.getTime() +
        (params.billingCycle === 'annual' ? 365 : 30) * 86400000,
    );
    const invoiceNumber = `LS-SUB-${now.getFullYear()}-${String(100 + params.seq)}`;
    const ref =
      params.paymentReference?.trim() ||
      `LSPAY-${randomBytes(3).toString('hex').toUpperCase()}`;

    const recipientLabel = tenant.companyName?.trim() || 'Leadsetu Workspace';
    const defaultGreeting = `Dear ${recipientLabel} Team, thank you for choosing Leadsetu to bridge every B2B lead, deal, and GST workflow! Your ${spec.name} is active with 18% GST Input Tax Credit eligibility. Warm regards, Team Leadsetu (New Delhi).`;

    return {
      id: `sub-${Date.now()}-${randomBytes(2).toString('hex')}`,
      invoiceNumber,
      plan: spec.id,
      planName: spec.name,
      billingCycle: params.billingCycle,
      seatsIncluded: spec.seatLimit,
      baseAmount,
      gstRate: 18,
      cgstAmount,
      sgstAmount,
      igstAmount,
      totalAmount,
      status: params.status,
      discountAmount,
      couponCode: (params.couponCode || '').trim().toUpperCase(),
      paymentMode: params.paymentMode,
      paymentReference: ref,
      issuedAt: now.toISOString(),
      periodStart: now.toISOString().slice(0, 10),
      periodEnd: periodEndDate.toISOString().slice(0, 10),
      sacCode: '998314',
      greetingNote: params.greetingNote?.trim() || defaultGreeting,
      buyerCompany: recipientLabel,
      buyerGstin: tenant.gstin || 'Unregistered / Applied',
      buyerState,
      buyerAddress:
        tenant.address || `${tenant.city || 'New Delhi'}, India`,
      buyerEmail: tenant.email || ownerEmail,
      ...LEADSETU_SELLER,
    };
  }

  private async ensureInitialInvoice(
    tenant: TenantDocument,
    fallbackEmail: string,
  ) {
    const existing = Array.isArray(tenant.subscriptionInvoices)
      ? tenant.subscriptionInvoices
      : [];
    if (existing.length > 0) return existing;

    const owner = await this.userModel
      .findOne({ tenantId: tenant._id, role: 'owner' })
      .exec();
    const initial = this.buildSubscriptionInvoice(
      tenant,
      owner?.email || fallbackEmail,
      {
        plan: tenant.plan || 'growth',
        billingCycle: 'monthly',
        status: tenant.status === 'active' ? 'paid' : 'trial_complimentary',
        paymentMode:
          tenant.status === 'active'
            ? 'Razorpay UPI / NEFT'
            : '14-Day Growth Activation',
        seq: 1,
      },
    );
    tenant.subscriptionInvoices = [initial];
    await tenant.save();
    return tenant.subscriptionInvoices;
  }

  private toDto(tenant: TenantDocument) {
    const raw = tenant.toObject() as unknown as {
      createdAt?: Date;
      updatedAt?: Date;
    };
    const companyName = (tenant.companyName || '').trim();
    return {
      id: tenant._id.toString(),
      accountId: tenant.accountId || '',
      name: tenant.name,
      companyName,
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
      businessMode: normalizeBusinessMode(tenant.businessMode),
      hiddenNavModules: Array.isArray(tenant.hiddenNavModules)
        ? tenant.hiddenNavModules
        : DEFAULT_HIDDEN_MODULES_BY_MODE[normalizeBusinessMode(tenant.businessMode)] || [],
      maskPhoneForAgents: Boolean(tenant.maskPhoneForAgents),
      blockAgentExport: tenant.blockAgentExport ?? true,
      subscriptionInvoices: Array.isArray(tenant.subscriptionInvoices)
        ? tenant.subscriptionInvoices
        : [],
      createdAt: raw.createdAt
        ? new Date(raw.createdAt).toISOString()
        : undefined,
      updatedAt: raw.updatedAt
        ? new Date(raw.updatedAt).toISOString()
        : undefined,
    };
  }

  async getCurrentTenant(auth: TenantAuthContext) {
    const tenant = await this.tenantModel.findById(auth.tenantId).exec();
    if (!tenant) {
      throw new NotFoundException('Workspace not found.');
    }
    await this.ensureInitialInvoice(tenant, auth.email);

    const spec = PLAN_CATALOG[tenant.plan || 'growth'] || PLAN_CATALOG.growth;
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

    const effectiveState = this.superAdminService
      ? await this.superAdminService
          .getTenantEffectiveState(tenant._id.toString())
          .catch(() => null)
      : null;

    return {
      tenant: {
        ...this.toDto(tenant),
        effectiveFeatures: effectiveState?.effectiveFeatures,
        effectiveFeatureDetails: effectiveState?.effectiveFeatureDetails,
        globalKillSwitches: effectiveState?.globalKillSwitches,
        maintenanceMode: effectiveState?.maintenanceMode ?? false,
      },
      usage: {
        activeSeats,
        totalSeats,
        seatLimit: spec.seatLimit,
      },
    };
  }

  async updateCurrentTenant(
    auth: TenantAuthContext,
    dto: UpdateTenantProfileDto,
  ) {
    let effectiveRole = auth.role;
    if (!['owner', 'admin', 'super_admin'].includes(effectiveRole)) {
      const dbUser = await this.userModel
        .findById(auth.userId)
        .select('role')
        .lean()
        .exec();
      if (dbUser?.role) {
        effectiveRole = dbUser.role;
      }
    }
    if (!['owner', 'admin', 'super_admin'].includes(effectiveRole)) {
      throw new ForbiddenException(
        'Only workspace Owners or Admins can edit organization settings.',
      );
    }
    const tenant = await this.tenantModel.findById(auth.tenantId).exec();
    if (!tenant) {
      throw new NotFoundException('Workspace not found.');
    }

    if (dto.companyName !== undefined) {
      const nextCompany = dto.companyName.trim();
      tenant.companyName = nextCompany;
      tenant.name = nextCompany || 'Leadsetu Workspace';
    } else if (dto.name !== undefined) {
      const nextName = dto.name.trim();
      if (!nextName || nextName === 'Leadsetu Workspace') {
        tenant.companyName = '';
        tenant.name = 'Leadsetu Workspace';
      } else {
        tenant.companyName = nextName;
        tenant.name = nextName;
      }
    }
    if (dto.logoUrl !== undefined) {
      const sanitizedLogo = sanitizeOrganizationLogoUrl(dto.logoUrl);
      tenant.logoUrl = sanitizedLogo
        ? await uploadToCloudinary(sanitizedLogo, {
            folder: 'leadsetu/org-logos',
            publicId: `tenant-${tenant._id.toString()}`,
            resourceType: 'image',
          })
        : '';
    }
    if (dto.city !== undefined) tenant.city = dto.city.trim();
    if (dto.gstin !== undefined)
      tenant.gstin = dto.gstin.trim().toUpperCase();
    if (dto.state !== undefined) tenant.state = dto.state.trim();
    if (dto.phone !== undefined) tenant.phone = dto.phone.trim();
    if (dto.email !== undefined)
      tenant.email = dto.email.trim().toLowerCase();
    if (dto.address !== undefined) tenant.address = dto.address.trim();
    if (dto.businessMode !== undefined) {
      const nextMode = normalizeBusinessMode(dto.businessMode);
      tenant.businessMode = nextMode;
      if (dto.hiddenNavModules === undefined) {
        tenant.hiddenNavModules = [
          ...(DEFAULT_HIDDEN_MODULES_BY_MODE[nextMode] || []),
        ];
      }
    }
    if (dto.hiddenNavModules !== undefined) {
      tenant.hiddenNavModules = Array.isArray(dto.hiddenNavModules)
        ? Array.from(
            new Set(
              dto.hiddenNavModules
                .map((m) => String(m || '').trim())
                .filter(Boolean),
            ),
          )
        : [];
    }

    await tenant.save();

    await this.auditService?.record({
      tenantId: auth.tenantId,
      actorId: auth.userId,
      actorEmail: auth.email,
      action: 'workspace.profile_updated',
      entityType: 'security',
      entityId: tenant._id.toString(),
      entityLabel: tenant.name,
      summary: `Updated workspace profile (${tenant.name}${
        tenant.city ? `, ${tenant.city}` : ''
      }${tenant.gstin ? ` · GSTIN ${tenant.gstin}` : ''})`,
    });

    return this.getCurrentTenant(auth);
  }

  async getBillingSummary(auth: TenantAuthContext) {
    const res = await this.getCurrentTenant(auth);
    return {
      ...res,
      seller: LEADSETU_SELLER,
      plans: Object.values(PLAN_CATALOG),
      invoices: [...(res.tenant.subscriptionInvoices || [])].reverse(),
    };
  }

  async subscribePlan(auth: TenantAuthContext, dto: SubscribePlanDto) {
    if (!['owner', 'admin'].includes(auth.role)) {
      throw new ForbiddenException(
        'Only workspace Owners or Admins can purchase or switch plans.',
      );
    }
    if (!dto.plan || !PLAN_CATALOG[dto.plan]) {
      throw new BadRequestException('Valid subscription plan is required.');
    }

    const tenant = await this.tenantModel.findById(auth.tenantId).exec();
    if (!tenant) {
      throw new NotFoundException('Workspace not found.');
    }
    const existing = await this.ensureInitialInvoice(tenant, auth.email);

    const billingCycle = dto.billingCycle === 'annual' ? 'annual' : 'monthly';
    const spec = PLAN_CATALOG[dto.plan];
    const listBaseAmount =
      billingCycle === 'annual' ? spec.annualPrice : spec.monthlyPrice;

    let discountAmount = 0;
    let appliedCouponCode = '';
    if (dto.couponCode?.trim()) {
      const codeUpper = dto.couponCode.trim().toUpperCase();
      const couponsCol = this.tenantModel.db.collection('saas_coupons');
      const coupon = await couponsCol.findOne({ code: codeUpper });
      if (!coupon || coupon.isActive === false) {
        throw new BadRequestException(
          `Promo code "${codeUpper}" is invalid or inactive.`,
        );
      }
      if (
        coupon.expiresAt &&
        new Date(String(coupon.expiresAt)).getTime() < Date.now()
      ) {
        throw new BadRequestException(`Promo code "${codeUpper}" has expired.`);
      }
      if (
        Number(coupon.maxRedemptions || 0) > 0 &&
        Number(coupon.redemptionsCount || 0) >= Number(coupon.maxRedemptions)
      ) {
        throw new BadRequestException(
          `Promo code "${codeUpper}" has reached its redemption limit.`,
        );
      }
      if (
        Array.isArray(coupon.applicablePlans) &&
        coupon.applicablePlans.length > 0 &&
        !coupon.applicablePlans.includes(dto.plan)
      ) {
        throw new BadRequestException(
          `Promo code "${codeUpper}" is not valid for the ${dto.plan.toUpperCase()} plan.`,
        );
      }
      if (
        coupon.billingCycle &&
        coupon.billingCycle !== 'all' &&
        coupon.billingCycle !== billingCycle
      ) {
        throw new BadRequestException(
          `Promo code "${codeUpper}" only applies to ${String(coupon.billingCycle)} billing.`,
        );
      }

      discountAmount =
        coupon.discountType === 'percent'
          ? Math.round((listBaseAmount * Number(coupon.discountValue || 0)) / 100)
          : Math.round(Number(coupon.discountValue || 0));
      discountAmount = Math.min(listBaseAmount, Math.max(0, discountAmount));
      appliedCouponCode = codeUpper;

      await couponsCol.updateOne(
        { _id: coupon._id },
        {
          $inc: {
            redemptionsCount: 1,
            totalDiscountGivenInr: discountAmount,
          },
        },
      );
    }

    const newInvoice = this.buildSubscriptionInvoice(tenant, auth.email, {
      plan: dto.plan,
      billingCycle,
      status: 'paid',
      paymentMode: dto.paymentMode?.trim() || 'Razorpay UPI / NEFT',
      paymentReference: dto.paymentReference,
      greetingNote: dto.greetingNote,
      discountAmount,
      couponCode: appliedCouponCode,
      seq: existing.length + 1,
    });

    tenant.plan = dto.plan;
    tenant.status = 'active';
    tenant.subscriptionInvoices = [...existing, newInvoice];
    await tenant.save();

    await this.auditService?.record({
      tenantId: auth.tenantId,
      actorId: auth.userId,
      actorEmail: auth.email,
      action: 'subscription.plan_activated',
      entityType: 'invoice',
      entityId: newInvoice.id,
      entityLabel: `${newInvoice.invoiceNumber} · ${newInvoice.planName}`,
      summary: `Activated ${newInvoice.planName} (${billingCycle}) · GST Invoice ${newInvoice.invoiceNumber} (₹${newInvoice.totalAmount.toLocaleString('en-IN')}) attached to workspace`,
    });

    const summary = await this.getBillingSummary(auth);
    return {
      ...summary,
      latestInvoice: newInvoice,
    };
  }

  async listTopupRequests(auth: TenantAuthContext) {
    if (auth.role !== 'owner' && auth.role !== 'admin' && auth.role !== 'super_admin') {
      throw new ForbiddenException('Only Workspace Owners and Admins can view top-up requests.');
    }
    const tenant = await this.tenantModel.findById(auth.tenantId).exec();
    if (!tenant) throw new NotFoundException('Workspace not found.');
    const items = [...(tenant.topupRequests || [])].sort((a, b) =>
      (b.createdAt || '').localeCompare(a.createdAt || ''),
    );
    return { data: items };
  }

  async createTopupRequest(
    auth: TenantAuthContext,
    body: { resource: 'ai' | 'whatsapp'; quantity: number; note?: string },
  ) {
    if (auth.role !== 'owner' && auth.role !== 'admin' && auth.role !== 'super_admin') {
      throw new ForbiddenException('Only Workspace Owners and Admins can request quota top-ups.');
    }
    if (body.resource !== 'ai' && body.resource !== 'whatsapp') {
      throw new BadRequestException('Resource must be ai or whatsapp.');
    }
    const qty = Math.round(Number(body.quantity || 0));
    if (!Number.isFinite(qty) || qty < 1 || qty > 1000000) {
      throw new BadRequestException('Quantity must be between 1 and 1,000,000.');
    }

    const [tenant, requester] = await Promise.all([
      this.tenantModel.findById(auth.tenantId).exec(),
      this.userModel.findById(auth.userId).select('name email').lean().exec(),
    ]);
    if (!tenant) throw new NotFoundException('Workspace not found.');

    const existingPending = (tenant.topupRequests || []).find(
      (r) => r.status === 'pending' && r.resource === body.resource,
    );
    if (existingPending) {
      throw new BadRequestException(
        `A pending ${body.resource.toUpperCase()} top-up request is already awaiting Super Admin review.`,
      );
    }

    const record: TopupRequestRecord = {
      id: `topup_${Date.now()}_${randomBytes(3).toString('hex')}`,
      resource: body.resource,
      quantity: qty,
      note: (body.note || '').trim().slice(0, 300),
      status: 'pending',
      requestedByUserId: auth.userId,
      requestedByName: requester?.name || auth.email,
      requestedByEmail: requester?.email || auth.email,
      createdAt: new Date().toISOString(),
      resolvedAt: '',
      resolvedByEmail: '',
      resolutionNote: '',
      grantedQuantity: 0,
    };

    tenant.topupRequests = [record, ...(tenant.topupRequests || [])];
    tenant.markModified('topupRequests');
    await tenant.save();

    return {
      created: record,
      data: tenant.topupRequests,
    };
  }
}
