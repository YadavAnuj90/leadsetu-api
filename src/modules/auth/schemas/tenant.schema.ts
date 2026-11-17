import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type TenantDocument = HydratedDocument<Tenant>;

@Schema({ _id: false })
export class TenantQuotas {
  @Prop({ type: Number, default: 2500 })
  maxMonthlyAiCalls!: number;

  @Prop({ type: Number, default: 5000 })
  maxMonthlyWhatsapp!: number;

  @Prop({ type: Number, default: 0 })
  aiCallsUsed!: number;

  @Prop({ type: Number, default: 0 })
  whatsappUsed!: number;

  @Prop({ type: Number, default: 2048 })
  maxStorageMb!: number;

  @Prop({ type: Number, default: 0 })
  aiCostInr?: number;

  @Prop({ type: Number, default: 0 })
  whatsappCostInr?: number;

  @Prop({ type: Number, default: 0 })
  addonAiCalls?: number;

  @Prop({ type: Number, default: 0 })
  addonWhatsapp?: number;

  @Prop({ trim: true, default: '' })
  lastMeterResetAt?: string;
}

export const TenantQuotasSchema = SchemaFactory.createForClass(TenantQuotas);

@Schema({ _id: false })
export class TenantSecurityPolicy {
  @Prop({ type: Boolean, default: false })
  enforcePhoneMasking!: boolean;

  @Prop({ type: Boolean, default: true })
  lockAgentExport!: boolean;

  @Prop({ type: Boolean, default: true })
  requireStrongPassword!: boolean;

  @Prop({ type: Number, default: 24 })
  sessionTtlHours!: number;

  @Prop({ type: Boolean, default: true })
  allowImpersonation!: boolean;

  @Prop({ type: [String], default: [] })
  ipAllowlist!: string[];

  @Prop({ trim: true, default: '' })
  suspensionReason!: string;

  @Prop({ trim: true, default: '' })
  suspendedAt!: string;
}

export const TenantSecurityPolicySchema = SchemaFactory.createForClass(
  TenantSecurityPolicy,
);

@Schema({ _id: false })
export class SubscriptionInvoiceRecord {
  @Prop({ required: true, trim: true })
  id!: string;

  @Prop({ required: true, trim: true })
  invoiceNumber!: string;

  @Prop({ required: true, enum: ['starter', 'growth', 'enterprise'] })
  plan!: 'starter' | 'growth' | 'enterprise';

  @Prop({ required: true, trim: true })
  planName!: string;

  @Prop({ default: 'monthly', enum: ['monthly', 'annual'] })
  billingCycle!: 'monthly' | 'annual';

  @Prop({ type: Number, default: 12 })
  seatsIncluded!: number;

  @Prop({ type: Number, required: true })
  baseAmount!: number;

  @Prop({ type: Number, default: 18 })
  gstRate!: number;

  @Prop({ type: Number, default: 0 })
  cgstAmount!: number;

  @Prop({ type: Number, default: 0 })
  sgstAmount!: number;

  @Prop({ type: Number, default: 0 })
  igstAmount!: number;

  @Prop({ type: Number, required: true })
  totalAmount!: number;

  @Prop({
    default: 'paid',
    enum: ['paid', 'trial_complimentary', 'complimentary_grant', 'refunded', 'voided'],
  })
  status!: 'paid' | 'trial_complimentary' | 'complimentary_grant' | 'refunded' | 'voided';

  @Prop({ type: Number, default: 0 })
  discountAmount?: number;

  @Prop({ trim: true, uppercase: true, default: '' })
  couponCode?: string;

  @Prop({ trim: true, uppercase: true, default: '' })
  partnerCode?: string;

  @Prop({ type: Number, default: 0 })
  tdsDeducted?: number;

  @Prop({ trim: true, default: '' })
  refundReason?: string;

  @Prop({ trim: true, default: '' })
  refundedAt?: string;

  @Prop({ trim: true, default: '' })
  issuedByEmail?: string;

  @Prop({ default: 'Razorpay / UPI-NEFT', trim: true })
  paymentMode!: string;

  @Prop({ trim: true, default: '' })
  paymentReference!: string;

  @Prop({ required: true, trim: true })
  issuedAt!: string;

  @Prop({ required: true, trim: true })
  periodStart!: string;

  @Prop({ required: true, trim: true })
  periodEnd!: string;

  @Prop({ default: '998314', trim: true })
  sacCode!: string;

  @Prop({ trim: true, default: '' })
  greetingNote!: string;

  @Prop({ trim: true, default: '' })
  buyerCompany!: string;

  @Prop({ trim: true, default: '' })
  buyerGstin!: string;

  @Prop({ trim: true, default: '' })
  buyerState!: string;

  @Prop({ trim: true, default: '' })
  buyerAddress!: string;

  @Prop({ trim: true, default: '' })
  buyerEmail!: string;

  @Prop({ trim: true, default: 'Leadsetu Technologies (Anujalite Tech Pvt. Ltd.)' })
  sellerCompany!: string;

  @Prop({ trim: true, default: '07AABCL4821K1Z5' })
  sellerGstin!: string;

  @Prop({
    trim: true,
    default:
      'Tower B, 7th Floor, Sector 62, Noida & Connaught Place, New Delhi – 110001, India',
  })
  sellerAddress!: string;

  @Prop({ trim: true, default: 'billing@leadsetu.in' })
  sellerEmail!: string;
}

export const SubscriptionInvoiceRecordSchema = SchemaFactory.createForClass(
  SubscriptionInvoiceRecord,
);

/** Company Admin request for an AI / WhatsApp quota top-up, resolved by Super Admin. */
@Schema({ _id: false })
export class TopupRequestRecord {
  @Prop({ required: true, trim: true })
  id!: string;

  @Prop({ required: true, enum: ['ai', 'whatsapp'] })
  resource!: 'ai' | 'whatsapp';

  @Prop({ type: Number, required: true })
  quantity!: number;

  @Prop({ trim: true, default: '' })
  note!: string;

  @Prop({ default: 'pending', enum: ['pending', 'approved', 'rejected'] })
  status!: 'pending' | 'approved' | 'rejected';

  @Prop({ trim: true, default: '' })
  requestedByUserId!: string;

  @Prop({ trim: true, default: '' })
  requestedByName!: string;

  @Prop({ trim: true, default: '' })
  requestedByEmail!: string;

  @Prop({ trim: true, default: '' })
  createdAt!: string;

  @Prop({ trim: true, default: '' })
  resolvedAt!: string;

  @Prop({ trim: true, default: '' })
  resolvedByEmail!: string;

  @Prop({ trim: true, default: '' })
  resolutionNote!: string;

  @Prop({ type: Number, default: 0 })
  grantedQuantity!: number;
}

export const TopupRequestRecordSchema = SchemaFactory.createForClass(TopupRequestRecord);

@Schema({ timestamps: true, collection: 'tenants' })
export class Tenant {
  @Prop({ required: true, trim: true })
  name!: string;

  @Prop({ required: true, unique: true, lowercase: true, trim: true })
  slug!: string;

  /**
   * Unique 5-digit workspace / admin account ID (e.g. "48213").
   * Sparse so pre-existing tenants without one don't clash; they are
   * back-filled on next login or team page load.
   */
  @Prop({ type: String, unique: true, sparse: true, trim: true })
  accountId?: string;

  @Prop({ default: 'starter', enum: ['starter', 'growth', 'enterprise'] })
  plan!: 'starter' | 'growth' | 'enterprise';

  @Prop({ default: 'trial', enum: ['trial', 'active', 'suspended'] })
  status!: 'trial' | 'active' | 'suspended';

  /** Distinguishes Leadsetu HQ internal system tenant from customer workspaces. */
  @Prop({ type: Boolean, default: false })
  isPlatformHq?: boolean;

  @Prop({ trim: true })
  city?: string;

  @Prop({ trim: true, uppercase: true, default: '' })
  gstin?: string;

  @Prop({ trim: true, default: '' })
  state?: string;

  @Prop({ trim: true, default: '' })
  phone?: string;

  @Prop({ trim: true, lowercase: true, default: '' })
  email?: string;

  @Prop({ trim: true, default: '' })
  address?: string;

  /** Anti-data-leak shield: mask client mobile numbers for agent role. */
  @Prop({ type: Boolean, default: false })
  maskPhoneForAgents?: boolean;

  /** Anti-data-leak shield: prevent bulk CSV exports by non-admin agents. */
  @Prop({ type: Boolean, default: true })
  blockAgentExport?: boolean;

  /** Unique secret key for inbound webhooks (IndiaMART / Justdial / Website forms). */
  @Prop({ type: String, unique: true, sparse: true, trim: true })
  webhookKey?: string;

  /** Counter for round-robin auto-assignment across active sales reps. */
  @Prop({ type: Number, default: 0 })
  roundRobinIndex?: number;

  /** Per-tenant Super Admin module feature overrides (true=force ON, false=force OFF). */
  @Prop({ type: Object, default: {} })
  featureOverrides?: Record<string, boolean>;

  /** Custom seat cap override set by Super Admin (null = use plan default). */
  @Prop({ type: Number, default: null })
  seatLimitOverride?: number | null;

  /** ISO timestamp when 14-day / extended trial expires. */
  @Prop({ trim: true, default: '' })
  trialEndsAt?: string;

  /** Internal account note visible only in Leadsetu Super Admin panel. */
  @Prop({ trim: true, default: '' })
  assignedManagerNote?: string;

  /** AI, WhatsApp & Storage quotas governed by Super Admin. */
  @Prop({ type: TenantQuotasSchema, default: () => ({}) })
  quotas?: TenantQuotas;

  /** Platform-enforced security & compliance policies for this tenant. */
  @Prop({ type: TenantSecurityPolicySchema, default: () => ({}) })
  securityPolicy?: TenantSecurityPolicy;

  /** Subscription GST invoices attached to this workspace profile. */
  @Prop({ type: [SubscriptionInvoiceRecordSchema], default: [] })
  subscriptionInvoices?: SubscriptionInvoiceRecord[];

  /** Company Admin AI / WhatsApp top-up requests awaiting or resolved by Super Admin. */
  @Prop({ type: [TopupRequestRecordSchema], default: [] })
  topupRequests?: TopupRequestRecord[];

  /** Incremented on whole-tenant panic revoke to invalidate all tenant JWTs immediately. */
  @Prop({ type: Number, default: 1 })
  sessionVersion?: number;

  /** DPDP Act Right-to-Erasure lifecycle metadata. */
  @Prop({
    type: Object,
    default: () => ({
      softDeletedAt: '',
      purgeScheduledAt: '',
      purgedAt: '',
      deletionReason: '',
      requestedByEmail: '',
    }),
  })
  dpdpRetention?: {
    softDeletedAt?: string;
    purgeScheduledAt?: string;
    purgedAt?: string;
    deletionReason?: string;
    requestedByEmail?: string;
  };
}

export const TenantSchema = SchemaFactory.createForClass(Tenant);
