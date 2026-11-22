import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type LeadRoutingDocument = HydratedDocument<LeadRouting>;

export type RoutingMode = 'round_robin' | 'territory_first' | 'load_balanced';

export interface RepRoutingConfig {
  userId: string;
  eligible: boolean;
  dailyCap: number;
  territories: string[];
}

export interface TerritoryRoutingRule {
  id: string;
  name: string;
  active: boolean;
  matchCities: string[];
  matchSources: string[];
  minEstimatedValue: number;
  targetUserIds: string[];
  strategy: 'round_robin' | 'load_balanced';
}

export interface RoutingDecisionLog {
  id: string;
  leadId?: string;
  leadName: string;
  source: string;
  city: string;
  estimatedValue: number;
  assignedUserId: string;
  assignedUserName: string;
  strategyUsed: string;
  ruleName?: string;
  assignedAt: string;
}

@Schema({ timestamps: true, collection: 'lead_routing_configs' })
export class LeadRouting {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, unique: true, index: true })
  tenantId!: Types.ObjectId;

  @Prop({ type: Boolean, default: true })
  enabled!: boolean;

  @Prop({
    type: String,
    default: 'round_robin',
    enum: ['round_robin', 'territory_first', 'load_balanced'],
  })
  mode!: RoutingMode;

  @Prop({
    type: [String],
    default: ['indiamart', 'justdial', 'meta_ads', 'google_ads', 'website', 'whatsapp'],
  })
  applyToSources!: string[];

  @Prop({ type: Boolean, default: false })
  applyOnManualCreate!: boolean;

  @Prop({ type: Boolean, default: true })
  respectDailyCap!: boolean;

  @Prop({ type: Number, default: 25 })
  defaultDailyCap!: number;

  @Prop({ type: Array, default: [] })
  repConfigs!: RepRoutingConfig[];

  @Prop({ type: Array, default: [] })
  rules!: TerritoryRoutingRule[];

  @Prop({ type: Number, default: 0 })
  roundRobinCursor!: number;

  @Prop({ type: Array, default: [] })
  recentLogs!: RoutingDecisionLog[];
}

export const LeadRoutingSchema = SchemaFactory.createForClass(LeadRouting);
