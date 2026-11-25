import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type DealDocument = HydratedDocument<Deal>;

export type DealStage = string;

export interface DealActivity {
  id: string;
  type:
    | 'created'
    | 'stage_change'
    | 'note'
    | 'quote'
    | 'call'
    | 'whatsapp'
    | 'ai_score';
  description: string;
  authorName: string;
  createdAt: string;
}

@Schema({ timestamps: true, collection: 'deals' })
export class Deal {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  ownerId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Pipeline', index: true, default: null })
  pipelineId?: Types.ObjectId | null;

  @Prop({ required: true, trim: true })
  title!: string;

  @Prop({ trim: true, default: '' })
  company!: string;

  @Prop({ trim: true, default: '' })
  contactName!: string;

  @Prop({ trim: true, default: '' })
  contactPhone!: string;

  @Prop({ trim: true })
  normalizedPhone?: string;

  @Prop({ trim: true, default: '' })
  contactEmail!: string;

  @Prop({ trim: true, default: 'Delhi-NCR' })
  city!: string;

  @Prop({ type: Number, default: 0 })
  value!: number;

  @Prop({
    type: String,
    default: 'qualified',
    index: true,
  })
  stage!: DealStage;

  @Prop({
    type: String,
    default: 'open',
    enum: ['open', 'won', 'lost'],
  })
  stageCategory?: 'open' | 'won' | 'lost';

  @Prop({ type: Number, default: 40 })
  probability!: number;

  @Prop({ default: '' })
  expectedCloseDate!: string;

  @Prop({ default: 'whatsapp' })
  source!: string;

  @Prop({ default: true })
  gstApplicable!: boolean;

  @Prop({ default: '' })
  notes!: string;

  @Prop({ type: Object, default: {} })
  customFields!: Record<string, unknown>;

  @Prop({ type: [String], default: [] })
  tags!: string[];

  @Prop({ type: Number, default: 75 })
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

  @Prop({ type: Array, default: [] })
  activities!: DealActivity[];
}

export const DealSchema = SchemaFactory.createForClass(Deal);
DealSchema.index(
  { tenantId: 1, normalizedPhone: 1 },
  { unique: true, sparse: true },
);
