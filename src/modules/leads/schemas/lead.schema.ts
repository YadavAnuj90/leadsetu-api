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
  | 'meta_ads'
  | 'google_ads'
  | 'website'
  | 'referral'
  | 'manual';

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

  @Prop({ trim: true, default: '' })
  phone!: string;

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
      'meta_ads',
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

  @Prop({ type: Array, default: [] })
  activities!: LeadActivity[];
}

export const LeadSchema = SchemaFactory.createForClass(Lead);
