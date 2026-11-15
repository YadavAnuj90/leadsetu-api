import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type {
  FeatureKey,
  GlobalKillSwitches,
  GlobalSecurityPolicies,
  PlanEntitlementSpec,
} from '../schemas/platform-config.schema';

export interface SuperAdminActor {
  userId: string;
  email: string;
  name: string;
  userCode: string;
}

export class UpdateTenantGovernanceDto {
  @ApiPropertyOptional({ enum: ['starter', 'growth', 'enterprise'] })
  plan?: 'starter' | 'growth' | 'enterprise';

  @ApiPropertyOptional({ enum: ['trial', 'active', 'suspended'] })
  status?: 'trial' | 'active' | 'suspended';

  @ApiPropertyOptional()
  suspensionReason?: string;

  @ApiPropertyOptional({ nullable: true })
  seatLimitOverride?: number | null;

  @ApiPropertyOptional()
  trialEndsAt?: string;

  @ApiPropertyOptional()
  extendTrialDays?: number;

  @ApiPropertyOptional()
  assignedManagerNote?: string;

  @ApiPropertyOptional()
  featureOverrides?: Partial<Record<FeatureKey, boolean | null>>;

  @ApiPropertyOptional()
  quotas?: {
    maxMonthlyAiCalls?: number;
    maxMonthlyWhatsapp?: number;
    maxStorageMb?: number;
    resetUsageCounters?: boolean;
  };

  @ApiPropertyOptional()
  securityPolicy?: {
    enforcePhoneMasking?: boolean;
    lockAgentExport?: boolean;
    requireStrongPassword?: boolean;
    sessionTtlHours?: number;
    allowImpersonation?: boolean;
    ipAllowlist?: string[];
  };

  @ApiPropertyOptional()
  reason?: string;
}

export class UpdateTenantUserRbacDto {
  @ApiPropertyOptional({ enum: ['owner', 'admin', 'manager', 'agent'] })
  role?: 'owner' | 'admin' | 'manager' | 'agent';

  @ApiPropertyOptional({
    enum: ['executive', 'sales', 'finance', 'service', 'marketing', 'operations'],
  })
  departmentPreset?: string;

  @ApiPropertyOptional({ type: [String] })
  permissions?: string[];

  @ApiPropertyOptional()
  isActive?: boolean;

  @ApiPropertyOptional()
  maskPhones?: boolean;

  @ApiPropertyOptional()
  territory?: string;

  @ApiPropertyOptional()
  revokeSessions?: boolean;

  @ApiPropertyOptional()
  reason?: string;
}

export class ImpersonateTenantDto {
  @ApiProperty({ example: 'Investigating GST IGST tax split ticket #104' })
  reason!: string;

  @ApiPropertyOptional({ description: 'Optional target user ID inside the tenant (defaults to Workspace Owner)' })
  targetUserId?: string;
}

export class UpdatePlatformPoliciesDto {
  @ApiPropertyOptional()
  maintenanceMode?: boolean;

  @ApiPropertyOptional()
  maintenanceBanner?: string;

  @ApiPropertyOptional()
  allowNewSignups?: boolean;

  @ApiPropertyOptional()
  defaultTrialDays?: number;

  @ApiPropertyOptional()
  globalKillSwitches?: Partial<GlobalKillSwitches>;

  @ApiPropertyOptional()
  securityPolicies?: Partial<GlobalSecurityPolicies>;

  @ApiPropertyOptional()
  planMatrix?: Partial<Record<'starter' | 'growth' | 'enterprise', PlanEntitlementSpec>>;

  @ApiPropertyOptional()
  reason?: string;
}

export class CreateSuperAdminOperatorDto {
  @ApiProperty({ example: 'Anuj Yadav' })
  name!: string;

  @ApiProperty({ example: 'hq-security@leadsetu.in' })
  email!: string;

  @ApiPropertyOptional({ example: '+91 98112 45678' })
  phone?: string;

  @ApiProperty({ example: 'StrongVault#2026' })
  password!: string;

  @ApiPropertyOptional({ example: 'Leadsetu HQ Platform Authority' })
  territory?: string;
}

export class IssueTenantSubscriptionDto {
  @ApiProperty({ enum: ['starter', 'growth', 'enterprise'] })
  plan!: 'starter' | 'growth' | 'enterprise';

  @ApiPropertyOptional({ enum: ['monthly', 'annual'], default: 'monthly' })
  billingCycle?: 'monthly' | 'annual';

  @ApiProperty({ enum: ['paid_offline', 'complimentary_grant'] })
  grantMode!: 'paid_offline' | 'complimentary_grant';

  @ApiPropertyOptional({ example: 'NEFT / RTGS Transfer' })
  paymentMode?: string;

  @ApiPropertyOptional({ example: 'UTR4391882710' })
  paymentReference?: string;

  @ApiPropertyOptional({ description: 'Optional overridden taxable base INR before GST' })
  customBaseAmount?: number;

  @ApiPropertyOptional()
  couponCode?: string;

  @ApiPropertyOptional()
  partnerCode?: string;

  @ApiPropertyOptional({ description: 'Optional TDS deducted by enterprise customer u/s 194J/194C' })
  tdsDeducted?: number;

  @ApiPropertyOptional()
  greetingNote?: string;

  @ApiPropertyOptional()
  reason?: string;
}

export class UpdateSubscriptionInvoiceStatusDto {
  @ApiProperty({ enum: ['refund', 'void', 'mark_paid'] })
  action!: 'refund' | 'void' | 'mark_paid';

  @ApiPropertyOptional()
  paymentReference?: string;

  @ApiPropertyOptional()
  tdsDeducted?: number;

  @ApiProperty()
  reason!: string;
}

export class CreateSaasCouponDto {
  @ApiProperty({ example: 'LAUNCH20' })
  code!: string;

  @ApiProperty({ enum: ['percent', 'flat_inr'] })
  discountType!: 'percent' | 'flat_inr';

  @ApiProperty({ example: 20 })
  discountValue!: number;

  @ApiPropertyOptional({ type: [String] })
  applicablePlans?: Array<'starter' | 'growth' | 'enterprise'>;

  @ApiPropertyOptional({ enum: ['all', 'monthly', 'annual'] })
  billingCycle?: 'all' | 'monthly' | 'annual';

  @ApiPropertyOptional()
  maxRedemptions?: number;

  @ApiPropertyOptional()
  expiresAt?: string;

  @ApiPropertyOptional()
  description?: string;
}

export class UpdateSaasCouponDto {
  @ApiPropertyOptional()
  isActive?: boolean;

  @ApiPropertyOptional()
  maxRedemptions?: number;

  @ApiPropertyOptional()
  expiresAt?: string;
}

export class CreateSaasPartnerDto {
  @ApiProperty({ example: 'DELHI-CA-01' })
  partnerCode!: string;

  @ApiProperty({ example: 'Sharma & Associates CA Advisory' })
  name!: string;

  @ApiProperty({ example: 'partners@sharmaca.in' })
  email!: string;

  @ApiPropertyOptional()
  phone?: string;

  @ApiPropertyOptional()
  city?: string;

  @ApiPropertyOptional({ example: 15 })
  commissionRatePct?: number;
}

export class PartnerPayoutDto {
  @ApiProperty({ example: 2500 })
  amountInr!: number;

  @ApiPropertyOptional({ example: 'UTR-NEFT-8821' })
  reference?: string;

  @ApiPropertyOptional()
  note?: string;
}

export class UpdateDunningPolicyDto {
  @ApiPropertyOptional()
  autoRemindersEnabled?: boolean;

  @ApiPropertyOptional({ type: [Number] })
  reminderDaysBeforeExpiry?: number[];

  @ApiPropertyOptional()
  gracePeriodDays?: number;

  @ApiPropertyOptional({ enum: ['downgrade_starter', 'pause_writes', 'suspend', 'notify_only'] })
  autoActionOnExpiry?: 'downgrade_starter' | 'pause_writes' | 'suspend' | 'notify_only';

  @ApiPropertyOptional()
  whatsappTemplateEnabled?: boolean;

  @ApiPropertyOptional()
  emailReminderEnabled?: boolean;

  @ApiPropertyOptional()
  reminderMessageTemplate?: string;
}
