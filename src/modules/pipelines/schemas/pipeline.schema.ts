import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type PipelineDocument = HydratedDocument<Pipeline>;

export type StageCategory = 'open' | 'won' | 'lost';

export interface PipelineStage {
  id: string;
  name: string;
  probability: number;
  color: string;
  category: StageCategory;
  rottenAfterDays?: number;
  requireNoteOnEnter?: boolean;
}

export const DEFAULT_PIPELINE_STAGES: PipelineStage[] = [
  {
    id: 'qualified',
    name: 'Qualified Inquiry',
    probability: 25,
    color: '#3978EA',
    category: 'open',
    rottenAfterDays: 7,
    requireNoteOnEnter: false,
  },
  {
    id: 'discovery',
    name: 'Discovery & Sample',
    probability: 45,
    color: '#8B5CF6',
    category: 'open',
    rottenAfterDays: 10,
    requireNoteOnEnter: false,
  },
  {
    id: 'proposal',
    name: 'GST Proposal Sent',
    probability: 65,
    color: '#F59E0B',
    category: 'open',
    rottenAfterDays: 7,
    requireNoteOnEnter: false,
  },
  {
    id: 'negotiation',
    name: 'Commercial Negotiation',
    probability: 85,
    color: '#EC4899',
    category: 'open',
    rottenAfterDays: 5,
    requireNoteOnEnter: false,
  },
  {
    id: 'won',
    name: 'Closed Won',
    probability: 100,
    color: '#10B981',
    category: 'won',
    rottenAfterDays: 0,
    requireNoteOnEnter: false,
  },
  {
    id: 'lost',
    name: 'Closed Lost',
    probability: 0,
    color: '#64748B',
    category: 'lost',
    rottenAfterDays: 0,
    requireNoteOnEnter: true,
  },
];

@Schema({ timestamps: true, collection: 'pipelines' })
export class Pipeline {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId!: Types.ObjectId;

  @Prop({ required: true, trim: true })
  name!: string;

  @Prop({ trim: true, default: '' })
  description!: string;

  @Prop({ type: Boolean, default: false, index: true })
  isDefault!: boolean;

  @Prop({ type: Array, default: DEFAULT_PIPELINE_STAGES })
  stages!: PipelineStage[];

  @Prop({ type: Types.ObjectId, ref: 'User', default: null })
  createdBy?: Types.ObjectId | null;
}

export const PipelineSchema = SchemaFactory.createForClass(Pipeline);
PipelineSchema.index({ tenantId: 1, name: 1 });
