import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type LeadFormDocument = HydratedDocument<LeadForm>;
export type LeadFormSubmissionDocument = HydratedDocument<LeadFormSubmission>;

export type LeadFormStatus = 'live' | 'draft' | 'paused';
export type LeadFormFieldType = 'text' | 'phone' | 'email' | 'chips' | 'select';

export interface LeadFormFieldItem {
  key: string;
  label: string;
  type: LeadFormFieldType;
  required: boolean;
  placeholder?: string;
  options?: string[];
}

export interface LeadFormStepItem {
  title: string;
  fields: LeadFormFieldItem[];
}

export interface LeadFormThankYouConfig {
  title: string;
  message: string;
  bookingCta: boolean;
  whatsappCta: boolean;
  brochureCta: boolean;
  brochureUrl?: string;
}

export interface LeadFormAutomationConfig {
  autoAssignRouting: boolean;
  instantWhatsappWelcome: boolean;
  whatsappTemplate: string;
  fireMetaCapi: boolean;
  defaultSourceTag: string;
  setuAiScoring: boolean;
}

export interface LeadFormChannelsConfig {
  link: boolean;
  widget: boolean;
  qr: boolean;
}

export interface LeadFormStatsCounters {
  views: number;
  starts: number;
  otpVerified: number;
  submissions: number;
  qualified: number;
  wonRevenueInr: number;
}

@Schema({ timestamps: true, collection: 'lead_forms' })
export class LeadForm {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  ownerId!: Types.ObjectId;

  @Prop({ required: true, trim: true, lowercase: true, unique: true, index: true })
  slug!: string;

  @Prop({ required: true, trim: true })
  title!: string;

  @Prop({ required: true, trim: true })
  headline!: string;

  @Prop({ trim: true, default: '' })
  subheadline!: string;

  @Prop({ trim: true, default: '#2563EB' })
  brandColor!: string;

  @Prop({ trim: true, default: 'LS' })
  logoText!: string;

  @Prop({ trim: true, default: 'Leadsetu Partner' })
  companyName!: string;

  @Prop({ default: 'draft', enum: ['live', 'draft', 'paused'], index: true })
  status!: LeadFormStatus;

  @Prop({ type: [String], default: [] })
  trustBullets!: string[];

  @Prop({ type: Array, default: [] })
  steps!: LeadFormStepItem[];

  @Prop({ type: Boolean, default: true })
  requireWhatsappOtp!: boolean;

  @Prop({ default: 'merge', enum: ['merge', 'create_new'] })
  duplicateStrategy!: 'merge' | 'create_new';

  @Prop({
    type: Object,
    default: () => ({
      title: 'Request Confirmed — Check Your WhatsApp!',
      message: 'Our specialist will connect with your quotation right away.',
      bookingCta: true,
      whatsappCta: true,
      brochureCta: true,
      brochureUrl: '',
    }),
  })
  thankYou!: LeadFormThankYouConfig;

  @Prop({
    type: Object,
    default: () => ({
      autoAssignRouting: true,
      instantWhatsappWelcome: true,
      whatsappTemplate: 'b2b_gst_proforma_instant_v2',
      fireMetaCapi: true,
      defaultSourceTag: 'Leadsetu Instant Form',
      setuAiScoring: true,
    }),
  })
  automation!: LeadFormAutomationConfig;

  @Prop({
    type: Object,
    default: () => ({
      link: true,
      widget: true,
      qr: true,
    }),
  })
  channels!: LeadFormChannelsConfig;

  @Prop({
    type: Object,
    default: () => ({
      views: 0,
      starts: 0,
      otpVerified: 0,
      submissions: 0,
      qualified: 0,
      wonRevenueInr: 0,
    }),
  })
  stats!: LeadFormStatsCounters;
}

export const LeadFormSchema = SchemaFactory.createForClass(LeadForm);

@Schema({ timestamps: true, collection: 'lead_form_submissions' })
export class LeadFormSubmission {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'LeadForm', required: true, index: true })
  formId!: Types.ObjectId;

  @Prop({ required: true, trim: true, lowercase: true, index: true })
  slug!: string;

  @Prop({ trim: true, default: '' })
  leadId!: string;

  @Prop({ trim: true, default: '' })
  name!: string;

  @Prop({ trim: true, default: '' })
  phone!: string;

  @Prop({ trim: true, lowercase: true, default: '' })
  email!: string;

  @Prop({ trim: true, default: '' })
  company!: string;

  @Prop({ trim: true, default: '' })
  city!: string;

  @Prop({ type: Object, default: {} })
  answers!: Record<string, string>;

  @Prop({ type: Boolean, default: false })
  otpVerified!: boolean;

  @Prop({ default: 'created', enum: ['created', 'merged'] })
  outcome!: 'created' | 'merged';

  @Prop({ trim: true, default: '' })
  utmSource!: string;

  @Prop({ trim: true, default: '' })
  utmMedium!: string;

  @Prop({ trim: true, default: '' })
  utmCampaign!: string;

  @Prop({ trim: true, default: '' })
  referrer!: string;
}

export const LeadFormSubmissionSchema =
  SchemaFactory.createForClass(LeadFormSubmission);
