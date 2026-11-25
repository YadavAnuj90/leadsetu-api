import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type LeadDocument = HydratedDocument<Lead>;

export type LeadStatus =
  | 'new'
  | 'contacted'
  | 'qualified'
  | 'proposal'
  | 'converted'
  | 'lost';

export type LeadSource =
  | 'whatsapp'
  | 'indiamart'
  | 'justdial'
  | 'tradeindia'
  | 'meta_ads'
  | 'meta_lead_ads'
  | 'google_ads'
  | 'website'
  | 'referral'
  | 'manual';

export interface MetaLeadData {
  leadgenId: string;
  pageId?: string;
  pageName?: string;
  formId?: string;
  formName?: string;
  adId?: string;
  createdTime?: string;
  rawFields?: Record<string, string>;
}

export interface LeadActivity {
  id: string;
  type: 'created' | 'status_change' | 'note' | 'call' | 'whatsapp' | 'ai_score';
  description: string;
  authorName: string;
  createdAt: string;
}

@Schema({ timestamps: true, collection: 'leads' })
export class Lead {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  ownerId!: Types.ObjectId;

  @Prop({ required: true, trim: true })
  name!: string;

  @Prop({ trim: true, default: '' })
  company!: string;

  @Prop({
    default: 'business',
    enum: ['business', 'consumer'],
    index: true,
  })
  accountKind!: 'business' | 'consumer';

  @Prop({ trim: true, default: '' })
  phone!: string;

  @Prop({ trim: true })
  normalizedPhone?: string;

  @Prop({ trim: true, lowercase: true, default: '' })
  email!: string;

  @Prop({ trim: true, default: 'Delhi-NCR' })
  city!: string;

  @Prop({
    default: 'whatsapp',
    enum: [
      'whatsapp',
      'indiamart',
      'justdial',
      'tradeindia',
      'meta_ads',
      'meta_lead_ads',
      'google_ads',
      'website',
      'referral',
      'manual',
    ],
  })
  source!: LeadSource;

  @Prop({
    default: 'new',
    enum: ['new', 'contacted', 'qualified', 'proposal', 'converted', 'lost'],
    index: true,
  })
  status!: LeadStatus;

  @Prop({ type: Number, default: 0 })
  estimatedValue!: number;

  @Prop({ type: Number, default: 70, index: true })
  aiScore!: number;

  @Prop({ default: 'Warm', enum: ['Hot', 'Warm', 'Cold'] })
  aiLabel!: 'Hot' | 'Warm' | 'Cold';

  @Prop({ default: '' })
  aiInsight!: string;

  @Prop({ default: '' })
  aiSummary!: string;

  @Prop({ default: '' })
  aiNextAction!: string;

  @Prop({ type: [String], default: [] })
  aiReasons!: string[];

  @Prop({ default: '' })
  aiScoredAt!: string;

  @Prop({ type: [String], default: [] })
  tags!: string[];

  @Prop({ default: '' })
  notes!: string;

  @Prop({ type: Object, default: {} })
  customFields!: Record<string, unknown>;

  @Prop({ type: Number, default: 0 })
  rnrRetryCount?: number;

  @Prop({ default: '' })
  nextCallRetryAt?: string;

  @Prop({ default: '' })
  lastCalledAt?: string;

  @Prop({ default: '' })
  lastCallOutcome?: string;

  @Prop({ type: Boolean, default: false, index: true })
  doNotCall?: boolean;

  @Prop({ trim: true, default: '', index: true })
  adPlatform?: string;

  @Prop({ trim: true, default: '' })
  ctwaClid?: string;

  @Prop({ trim: true, default: '', index: true })
  adId?: string;

  @Prop({ trim: true, default: '' })
  adHeadline?: string;

  @Prop({ trim: true, default: '' })
  adSourceUrl?: string;

  @Prop({ trim: true, default: '', index: true })
  externalQueryId?: string;

  @Prop({ trim: true, default: '' })
  firstContactedAt?: string;

  @Prop({ type: Number, default: -1 })
  speedToLeadSeconds?: number;

  @Prop({ type: Boolean, default: false })
  autoWhatsAppWelcomeSent?: boolean;

  @Prop({ type: Object })
  metaLeadData?: MetaLeadData;

  @Prop({ type: Array, default: [] })
  activities!: LeadActivity[];
}

export const LeadSchema = SchemaFactory.createForClass(Lead);
LeadSchema.index(
  { tenantId: 1, 'metaLeadData.leadgenId': 1 },
  { unique: true, sparse: true },
);
LeadSchema.index(
  { tenantId: 1, normalizedPhone: 1 },
  { unique: true, sparse: true },
);
