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
} from '../auth/schemas/tenant.schema';
import { User, UserDocument } from '../auth/schemas/user.schema';
import { AuditService } from '../audit/audit.module';
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
      'Unlimited Gemini AI Lead Scoring',
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
      seq: number;
    },
  ): SubscriptionInvoiceRecord {
    const spec = PLAN_CATALOG[params.plan] || PLAN_CATALOG.growth;
    const baseAmount =
      params.billingCycle === 'annual' ? spec.annualPrice : spec.monthlyPrice;
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

    const defaultGreeting = `Dear ${tenant.name} Team, thank you for choosing Leadsetu to bridge every B2B lead, deal, and GST workflow! Your ${spec.name} is active with 18% GST Input Tax Credit eligibility. Warm regards, Team Leadsetu (New Delhi).`;

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
      paymentMode: params.paymentMode,
      paymentReference: ref,
      issuedAt: now.toISOString(),
      periodStart: now.toISOString().slice(0, 10),
      periodEnd: periodEndDate.toISOString().slice(0, 10),
      sacCode: '998314',
      greetingNote: params.greetingNote?.trim() || defaultGreeting,
      buyerCompany: tenant.name,
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
    return {
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
    if (!['owner', 'admin'].includes(auth.role)) {
      throw new ForbiddenException(
        'Only workspace Owners or Admins can edit organization settings.',
      );
    }
    const tenant = await this.tenantModel.findById(auth.tenantId).exec();
    if (!tenant) {
      throw new NotFoundException('Workspace not found.');
    }

    if (dto.name !== undefined) {
      const nextName = dto.name.trim();
      if (!nextName) {
        throw new BadRequestException('Workspace name cannot be empty.');
      }
      tenant.name = nextName;
    }
    if (dto.city !== undefined) tenant.city = dto.city.trim();
    if (dto.gstin !== undefined)
      tenant.gstin = dto.gstin.trim().toUpperCase();
    if (dto.state !== undefined) tenant.state = dto.state.trim();
    if (dto.phone !== undefined) tenant.phone = dto.phone.trim();
    if (dto.email !== undefined)
      tenant.email = dto.email.trim().toLowerCase();
    if (dto.address !== undefined) tenant.address = dto.address.trim();

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
    const newInvoice = this.buildSubscriptionInvoice(tenant, auth.email, {
      plan: dto.plan,
      billingCycle,
      status: 'paid',
      paymentMode: dto.paymentMode?.trim() || 'Razorpay UPI / NEFT',
      paymentReference: dto.paymentReference,
      greetingNote: dto.greetingNote,
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
}
