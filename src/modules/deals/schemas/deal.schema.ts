import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type DealDocument = HydratedDocument<Deal>;

export type DealStage =
  | 'qualified'
  | 'discovery'
  | 'proposal'
  | 'negotiation'
  | 'won'
  | 'lost';

export interface DealActivity {
  id: string;
  type: 'created' | 'stage_change' | 'note' | 'quote';
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

  @Prop({ required: true, trim: true })
  title!: string;

  @Prop({ trim: true, default: '' })
  company!: string;

  @Prop({ trim: true, default: '' })
  contactName!: string;

  @Prop({ trim: true, default: '' })
  contactPhone!: string;

  @Prop({ trim: true, default: '' })
  contactEmail!: string;

  @Prop({ trim: true, default: 'Delhi-NCR' })
  city!: string;

  @Prop({ type: Number, default: 0 })
  value!: number;

  @Prop({
    default: 'qualified',
    enum: ['qualified', 'discovery', 'proposal', 'negotiation', 'won', 'lost'],
    index: true,
  })
  stage!: DealStage;

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

  @Prop({ type: [String], default: [] })
  tags!: string[];

  @Prop({ type: Array, default: [] })
  activities!: DealActivity[];
}

export const DealSchema = SchemaFactory.createForClass(Deal);
