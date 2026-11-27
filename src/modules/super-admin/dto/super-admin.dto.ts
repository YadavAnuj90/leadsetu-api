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
    aiCallsUsed?: number;
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

  @ApiPropertyOptional({ description: 'Super Admin password required for destructive actions (e.g., suspending workspace)' })
  confirmPassword?: string;
}

export class UpdateTenantUserRbacDto {
  @ApiPropertyOptional({ enum: ['owner', 'admin', 'manager', 'agent', 'support'] })
  role?: 'owner' | 'admin' | 'manager' | 'agent' | 'support';

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

  @ApiPropertyOptional({ description: 'Super Admin password required for destructive actions (e.g., suspending workspace)' })
  confirmPassword?: string;
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

  @ApiPropertyOptional({ description: 'Super Admin password required for destructive actions (e.g., suspending workspace)' })
  confirmPassword?: string;
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

  @ApiPropertyOptional({ description: 'Super Admin password required for destructive actions (e.g., suspending workspace)' })
  confirmPassword?: string;
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

export class RevokeTenantSessionsDto {
  @ApiProperty({ example: 'Suspected compromised employee credentials' })
  reason!: string;

  @ApiProperty({ description: 'Super Admin operator password confirmation' })
  confirmPassword!: string;
}

export class DpdpEraseTenantDto {
  @ApiProperty({ enum: ['soft_delete', 'restore', 'permanent_purge'] })
  mode!: 'soft_delete' | 'restore' | 'permanent_purge';

  @ApiProperty({ example: 'Customer DPDP erasure request ticket #409' })
  reason!: string;

  @ApiPropertyOptional({ description: 'Super Admin operator password confirmation' })
  confirmPassword?: string;

  @ApiPropertyOptional({ description: 'Allow purge even before dpdpRetentionDays elapses (audited)' })
  forceBypassRetention?: boolean;
}

export class GrantQuotaAddonDto {
  @ApiPropertyOptional({ example: 2500 })
  addonAiCalls?: number;

  @ApiPropertyOptional({ example: 5000 })
  addonWhatsapp?: number;

  @ApiPropertyOptional({ example: 2048 })
  addonStorageMb?: number;

  @ApiPropertyOptional()
  issueGstInvoice?: boolean;

  @ApiPropertyOptional({ example: 999 })
  addonPriceInr?: number;

  @ApiPropertyOptional()
  paymentReference?: string;

  @ApiPropertyOptional()
  reason?: string;
}

export class ToggleOperatorStatusDto {
  @ApiProperty()
  isActive!: boolean;

  @ApiPropertyOptional({ description: 'Super Admin password required when revoking an operator' })
  confirmPassword?: string;
}

export class ManageTenantAiAuthorityDto {
  @ApiProperty({
    enum: ['assign_balance', 'remove_balance', 'set_balance', 'reset_used', 'update_features'],
  })
  mode!: 'assign_balance' | 'remove_balance' | 'set_balance' | 'reset_used' | 'update_features';

  @ApiPropertyOptional({ example: 1000 })
  aiCallsDelta?: number;

  @ApiPropertyOptional({ example: 5000 })
  maxMonthlyAiCalls?: number;

  @ApiPropertyOptional({ example: 0 })
  aiCallsUsed?: number;

  @ApiPropertyOptional({ nullable: true })
  aiScoring?: boolean | null;

  @ApiPropertyOptional({ nullable: true })
  aiWorkflows?: boolean | null;

  @ApiPropertyOptional({ nullable: true, description: 'Pillar 1 · Credit & Udhaar AI' })
  aiCreditRisk?: boolean | null;

  @ApiPropertyOptional({ nullable: true, description: 'Pillar 2 · Voice-to-CRM & Call Audit' })
  aiVoiceCrm?: boolean | null;

  @ApiPropertyOptional({ nullable: true, description: 'Pillar 3 · Dealer RFQ & Beat Planner' })
  aiDealerDesk?: boolean | null;

  @ApiPropertyOptional({ nullable: true, description: 'Ask AI · Tenant RAG Copilot' })
  aiCopilot?: boolean | null;

  @ApiPropertyOptional()
  reason?: string;
}

export class BulkManageAiAuthorityDto extends ManageTenantAiAuthorityDto {
  @ApiPropertyOptional({ type: [String] })
  tenantIds?: string[];
}

export class ResolveTopupRequestDto {
  @ApiProperty({ enum: ['approve', 'reject'] })
  action!: 'approve' | 'reject';

  @ApiPropertyOptional({ example: 2500, description: 'Quantity to grant (defaults to requested quantity)' })
  grantedQuantity?: number;

  @ApiPropertyOptional({ description: 'Attach a paid 18% GST add-on invoice' })
  issueGstInvoice?: boolean;

  @ApiPropertyOptional({ example: 999 })
  priceInr?: number;

  @ApiPropertyOptional()
  note?: string;
}

export class ProvisionWorkspaceDto {
  @ApiProperty({ example: 'Apex Switchgears Pvt. Ltd.' })
  companyName!: string;

  @ApiProperty({ example: 'Rajesh Sharma' })
  ownerName!: string;

  @ApiProperty({ example: 'rajesh@apexswitchgears.in' })
  ownerEmail!: string;

  @ApiPropertyOptional({
    description: 'Optional initial password (auto-generated securely if omitted)',
    example: 'Leadsetu@2026',
  })
  ownerPassword?: string;

  @ApiPropertyOptional({ example: '+91 98112 45678' })
  ownerPhone?: string;

  @ApiPropertyOptional({
    enum: ['b2b', 'msme', 'b2c', 'hybrid', 'bpo', 'education'],
    default: 'b2b',
  })
  businessMode?: 'b2b' | 'msme' | 'b2c' | 'hybrid' | 'bpo' | 'education';

  @ApiPropertyOptional({
    enum: ['starter', 'growth', 'enterprise'],
    default: 'growth',
  })
  plan?: 'starter' | 'growth' | 'enterprise';

  @ApiPropertyOptional({ enum: ['trial', 'active'], default: 'trial' })
  status?: 'trial' | 'active';

  @ApiPropertyOptional({ default: 14, example: 14 })
  trialDays?: number;

  @ApiPropertyOptional({ example: 'Noida' })
  city?: string;

  @ApiPropertyOptional({ example: '09AAACA1234A1Z5' })
  gstin?: string;

  @ApiPropertyOptional({ nullable: true, example: 15 })
  seatLimitOverride?: number | null;

  @ApiPropertyOptional({ default: true })
  seedDemoData?: boolean;

  @ApiPropertyOptional({ example: 'Enterprise pilot closed by HQ Onboarding Desk' })
  assignedManagerNote?: string;
}

export class ChurnRescueActionDto {
  @ApiProperty({
    enum: [
      'extend_trial_7d',
      'extend_trial_14d',
      'activate_promo_growth',
      'mark_outreach_sent',
    ],
  })
  action!:
    | 'extend_trial_7d'
    | 'extend_trial_14d'
    | 'activate_promo_growth'
    | 'mark_outreach_sent';

  @ApiPropertyOptional({ example: 'Extended trial +7d after founder demo call' })
  note?: string;
}

export class RunIntegrationProbeDto {
  @ApiPropertyOptional({
    enum: ['whatsapp_cloud', 'meta_capi', 'indiamart_pull', 'all'],
    default: 'all',
  })
  connector?: 'whatsapp_cloud' | 'meta_capi' | 'indiamart_pull' | 'all';

  @ApiPropertyOptional({ example: 'Proactive HQ diagnostic check' })
  reason?: string;
}
