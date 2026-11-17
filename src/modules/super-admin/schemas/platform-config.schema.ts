import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type PlatformConfigDocument = HydratedDocument<PlatformConfig>;
export type PlatformAuditLogDocument = HydratedDocument<PlatformAuditLog>;
export type SaasCouponDocument = HydratedDocument<SaasCoupon>;
export type SaasPartnerDocument = HydratedDocument<SaasPartner>;

export type FeatureKey =
  | 'aiScoring'
  | 'whatsappCloud'
  | 'whatsappBroadcasts'
  | 'gstBilling'
  | 'aiWorkflows'
  | 'slaTickets'
  | 'documentVault'
  | 'apiWebhooks'
  | 'customRbac'
  | 'auditShield'
  | 'aiCreditRisk'
  | 'aiVoiceCrm'
  | 'aiDealerDesk'
  | 'aiCopilot';

export const AI_PILLAR_FEATURE_KEYS = [
  'aiCreditRisk',
  'aiVoiceCrm',
  'aiDealerDesk',
  'aiCopilot',
] as const;

export interface FeatureSpec {
  key: FeatureKey;
  label: string;
  category: 'AI & Automation' | 'Omnichannel' | 'Revenue & GST' | 'Security & RBAC';
  description: string;
}

export const PLATFORM_FEATURE_CATALOG: FeatureSpec[] = [
  {
    key: 'aiScoring',
    label: 'SetuAI Lead Scoring',
    category: 'AI & Automation',
    description: '1–100 Hinglish/English buyer intent ranking & next-best-action summaries',
  },
  {
    key: 'aiWorkflows',
    label: 'Zero-Code AI Workflows',
    category: 'AI & Automation',
    description: 'IF-THIS-THEN-THAT automated lead routing, task creation & trigger logs',
  },
  {
    key: 'whatsappCloud',
    label: 'Unified WhatsApp Cloud Inbox',
    category: 'Omnichannel',
    description: 'Official Meta Cloud Inbox with AI smart reply drafting',
  },
  {
    key: 'whatsappBroadcasts',
    label: 'WhatsApp Broadcast Campaigns',
    category: 'Omnichannel',
    description: 'Bulk green-tick template blasts & revenue attribution funnels',
  },
  {
    key: 'gstBilling',
    label: '18% GST Tax Invoices & CPQ',
    category: 'Revenue & GST',
    description: 'Rule-46 CGST/SGST/IGST billing, Proforma approval links & TDS AR ledger',
  },
  {
    key: 'slaTickets',
    label: 'SLA Field Service Desk',
    category: 'Revenue & GST',
    description: 'Post-sales AMC tickets, 24h SLA breach timers & engineer job sheets',
  },
  {
    key: 'documentVault',
    label: 'Document Center Vault',
    category: 'Revenue & GST',
    description: 'GST certificates, brochures, signed quotes & warranty PDF vault',
  },
  {
    key: 'apiWebhooks',
    label: 'Inbound Webhooks & REST API',
    category: 'AI & Automation',
    description: 'IndiaMART, Justdial, Meta Lead Ads & Razorpay real-time webhook ingest',
  },
  {
    key: 'customRbac',
    label: 'Granular Team RBAC Presets',
    category: 'Security & RBAC',
    description: 'Department role scoping (Sales, Finance, Service, Operations) & quotas',
  },
  {
    key: 'auditShield',
    label: 'DPDP Anti-Leak Audit Shield',
    category: 'Security & RBAC',
    description: 'Agent phone masking, bulk CSV export lock & immutable activity trail',
  },
  {
    key: 'aiCreditRisk',
    label: 'Pillar 1 · Credit & Udhaar AI',
    category: 'AI & Automation',
    description: 'AI credit-risk scoring, Hinglish vaada extraction & Udhaar recovery drafts',
  },
  {
    key: 'aiVoiceCrm',
    label: 'Pillar 2 · Voice-to-CRM & Call Audit',
    category: 'AI & Automation',
    description: 'Hinglish call notes to CRM fields, follow-up tasks & compliance QA audit',
  },
  {
    key: 'aiDealerDesk',
    label: 'Pillar 3 · Dealer RFQ & Beat Planner',
    category: 'AI & Automation',
    description: 'WhatsApp multi-SKU RFQ parser & prioritized field beat route planner',
  },
  {
    key: 'aiCopilot',
    label: 'Ask AI · Tenant RAG Copilot',
    category: 'AI & Automation',
    description: 'Grounded Q&A over the workspace leads, deals, invoices & tasks',
  },
];

export interface PlanEntitlementSpec {
  plan: 'starter' | 'growth' | 'enterprise';
  name: string;
  monthlyPrice: number;
  annualPrice: number;
  seatLimit: number;
  maxMonthlyAiCalls: number;
  maxMonthlyWhatsapp: number;
  maxStorageMb: number;
  features: Record<FeatureKey, boolean>;
}

export const DEFAULT_PLAN_MATRIX: Record<
  'starter' | 'growth' | 'enterprise',
  PlanEntitlementSpec
> = {
  starter: {
    plan: 'starter',
    name: 'Starter Plan',
    monthlyPrice: 999,
    annualPrice: 9590,
    seatLimit: 4,
    maxMonthlyAiCalls: 500,
    maxMonthlyWhatsapp: 1000,
    maxStorageMb: 512,
    features: {
      aiScoring: true,
      whatsappCloud: true,
      whatsappBroadcasts: false,
      gstBilling: true,
      aiWorkflows: false,
      slaTickets: false,
      documentVault: true,
      apiWebhooks: true,
      customRbac: false,
      auditShield: false,
      aiCreditRisk: true,
      aiVoiceCrm: false,
      aiDealerDesk: false,
      aiCopilot: false,
    },
  },
  growth: {
    plan: 'growth',
    name: 'Growth Plan',
    monthlyPrice: 2399,
    annualPrice: 23030,
    seatLimit: 12,
    maxMonthlyAiCalls: 5000,
    maxMonthlyWhatsapp: 10000,
    maxStorageMb: 2048,
    features: {
      aiScoring: true,
      whatsappCloud: true,
      whatsappBroadcasts: true,
      gstBilling: true,
      aiWorkflows: true,
      slaTickets: true,
      documentVault: true,
      apiWebhooks: true,
      customRbac: true,
      auditShield: true,
      aiCreditRisk: true,
      aiVoiceCrm: true,
      aiDealerDesk: true,
      aiCopilot: true,
    },
  },
  enterprise: {
    plan: 'enterprise',
    name: 'Enterprise Plan',
    monthlyPrice: 5499,
    annualPrice: 52790,
    seatLimit: 50,
    maxMonthlyAiCalls: 50000,
    maxMonthlyWhatsapp: 100000,
    maxStorageMb: 10240,
    features: {
      aiScoring: true,
      whatsappCloud: true,
      whatsappBroadcasts: true,
      gstBilling: true,
      aiWorkflows: true,
      slaTickets: true,
      documentVault: true,
      apiWebhooks: true,
      customRbac: true,
      auditShield: true,
      aiCreditRisk: true,
      aiVoiceCrm: true,
      aiDealerDesk: true,
      aiCopilot: true,
    },
  },
};

export interface GlobalKillSwitches {
  geminiAiEnabled: boolean;
  whatsappCloudEnabled: boolean;
  webhooksEnabled: boolean;
  bulkExportsEnabled: boolean;
  impersonationEnabled: boolean;
}

export const DEFAULT_GLOBAL_KILL_SWITCHES: GlobalKillSwitches = {
  geminiAiEnabled: true,
  whatsappCloudEnabled: true,
  webhooksEnabled: true,
  bulkExportsEnabled: true,
  impersonationEnabled: true,
};

export interface GlobalSecurityPolicies {
  minPasswordLength: number;
  enforceMfaNotice: boolean;
  impersonationMaxMinutes: number;
  lockTenantOnSuspiciousActivity: boolean;
  dpdpRetentionDays: number;
  requireReasonForGovernance: boolean;
}

export const DEFAULT_SECURITY_POLICIES: GlobalSecurityPolicies = {
  minPasswordLength: 8,
  enforceMfaNotice: true,
  impersonationMaxMinutes: 30,
  lockTenantOnSuspiciousActivity: true,
  dpdpRetentionDays: 365,
  requireReasonForGovernance: true,
};

export interface DunningPolicy {
  autoRemindersEnabled: boolean;
  reminderDaysBeforeExpiry: number[];
  gracePeriodDays: number;
  autoActionOnExpiry: 'downgrade_starter' | 'pause_writes' | 'suspend' | 'notify_only';
  whatsappTemplateEnabled: boolean;
  emailReminderEnabled: boolean;
  reminderMessageTemplate: string;
  lastRunAt?: string;
  lastRunSummary?: string;
}

export const DEFAULT_DUNNING_POLICY: DunningPolicy = {
  autoRemindersEnabled: true,
  reminderDaysBeforeExpiry: [7, 3, 1],
  gracePeriodDays: 3,
  autoActionOnExpiry: 'pause_writes',
  whatsappTemplateEnabled: true,
  emailReminderEnabled: true,
  reminderMessageTemplate:
    'Namaste {{tenantName}} team, aapka Leadsetu {{planName}} trial/billing cycle {{daysLeft}} din me expire ho raha hai. Continuous WhatsApp & GST billing access ke liye Settings -> Billing me upgrade karein.',
  lastRunAt: '',
  lastRunSummary: '',
};

@Schema({ timestamps: true, collection: 'platform_configs' })
export class PlatformConfig {
  @Prop({ required: true, unique: true, default: 'global' })
  key!: string;

  @Prop({ type: Boolean, default: false })
  maintenanceMode!: boolean;

  @Prop({
    trim: true,
    default: 'Scheduled Leadsetu Cloud optimization window. All CRM data remains safe.',
  })
  maintenanceBanner!: string;

  @Prop({ type: Boolean, default: true })
  allowNewSignups!: boolean;

  @Prop({ type: Number, default: 14 })
  defaultTrialDays!: number;

  @Prop({ type: Object, default: () => DEFAULT_PLAN_MATRIX })
  planMatrix!: Record<'starter' | 'growth' | 'enterprise', PlanEntitlementSpec>;

  @Prop({ type: Object, default: () => DEFAULT_GLOBAL_KILL_SWITCHES })
  globalKillSwitches!: GlobalKillSwitches;

  @Prop({ type: Object, default: () => DEFAULT_SECURITY_POLICIES })
  securityPolicies!: GlobalSecurityPolicies;

  @Prop({ type: Object, default: () => DEFAULT_DUNNING_POLICY })
  dunningPolicy!: DunningPolicy;

  @Prop({ trim: true, default: '' })
  updatedByEmail?: string;
}

export const PlatformConfigSchema = SchemaFactory.createForClass(PlatformConfig);

@Schema({ timestamps: true, collection: 'platform_audit_logs' })
export class PlatformAuditLog {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  actorId!: Types.ObjectId;

  @Prop({ required: true, trim: true })
  actorName!: string;

  @Prop({ required: true, trim: true, lowercase: true })
  actorEmail!: string;

  @Prop({ required: true, trim: true, index: true })
  action!: string;

  @Prop({
    default: 'info',
    enum: ['info', 'warning', 'critical'],
    index: true,
  })
  severity!: 'info' | 'warning' | 'critical';

  @Prop({ trim: true, default: '' })
  targetTenantId?: string;

  @Prop({ trim: true, default: '' })
  targetTenantName?: string;

  @Prop({ trim: true, default: '' })
  targetAccountId?: string;

  @Prop({ required: true, trim: true })
  summary!: string;

  @Prop({ trim: true, default: '' })
  reason?: string;

  @Prop({ trim: true, default: '' })
  ipAddress?: string;

  @Prop({ type: Object, default: {} })
  metadata?: Record<string, unknown>;
}

export const PlatformAuditLogSchema = SchemaFactory.createForClass(PlatformAuditLog);
PlatformAuditLogSchema.index({ createdAt: -1 });

@Schema({ timestamps: true, collection: 'saas_coupons' })
export class SaasCoupon {
  @Prop({ required: true, unique: true, uppercase: true, trim: true })
  code!: string;

  @Prop({ default: 'percent', enum: ['percent', 'flat_inr'] })
  discountType!: 'percent' | 'flat_inr';

  @Prop({ type: Number, required: true })
  discountValue!: number;

  @Prop({ type: [String], default: [] })
  applicablePlans!: Array<'starter' | 'growth' | 'enterprise'>;

  @Prop({ default: 'all', enum: ['all', 'monthly', 'annual'] })
  billingCycle!: 'all' | 'monthly' | 'annual';

  @Prop({ type: Number, default: 0 })
  maxRedemptions!: number;

  @Prop({ type: Number, default: 0 })
  redemptionsCount!: number;

  @Prop({ type: Number, default: 0 })
  totalDiscountGivenInr!: number;

  @Prop({ trim: true, default: '' })
  expiresAt!: string;

  @Prop({ type: Boolean, default: true })
  isActive!: boolean;

  @Prop({ trim: true, default: '' })
  description!: string;
}

export const SaasCouponSchema = SchemaFactory.createForClass(SaasCoupon);

@Schema({ timestamps: true, collection: 'saas_partners' })
export class SaasPartner {
  @Prop({ required: true, unique: true, uppercase: true, trim: true })
  partnerCode!: string;

  @Prop({ required: true, trim: true })
  name!: string;

  @Prop({ required: true, trim: true, lowercase: true })
  email!: string;

  @Prop({ trim: true, default: '' })
  phone!: string;

  @Prop({ trim: true, default: 'Delhi-NCR' })
  city!: string;

  @Prop({ type: Number, default: 15 })
  commissionRatePct!: number;

  @Prop({ type: Number, default: 0 })
  totalAttributedRevenueInr!: number;

  @Prop({ type: Number, default: 0 })
  totalCommissionEarnedInr!: number;

  @Prop({ type: Number, default: 0 })
  totalCommissionPaidInr!: number;

  @Prop({ type: Number, default: 0 })
  referredTenantsCount!: number;

  @Prop({ type: Boolean, default: true })
  isActive!: boolean;
}

export const SaasPartnerSchema = SchemaFactory.createForClass(SaasPartner);
