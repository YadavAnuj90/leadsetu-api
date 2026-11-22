import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type MarketplaceSyncLogDocument = HydratedDocument<MarketplaceSyncLog>;

export type MarketplaceChannel =
  | 'indiamart_pull'
  | 'justdial_feed'
  | 'tradeindia_feed'
  | 'meta_lead_ads'
  | 'booking_widget'
  | 'sandbox_sim';

@Schema({ timestamps: true, collection: 'marketplace_sync_logs' })
export class MarketplaceSyncLog {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId!: Types.ObjectId;

  @Prop({
    required: true,
    enum: [
      'indiamart_pull',
      'justdial_feed',
      'tradeindia_feed',
      'meta_lead_ads',
      'booking_widget',
      'sandbox_sim',
    ],
    index: true,
  })
  channel!: MarketplaceChannel;

  @Prop({
    required: true,
    enum: ['live_api', 'sandbox'],
    default: 'sandbox',
  })
  mode!: 'live_api' | 'sandbox';

  @Prop({ type: Number, default: 0 })
  fetchedCount!: number;

  @Prop({ type: Number, default: 0 })
  createdCount!: number;

  @Prop({ type: Number, default: 0 })
  deduplicatedCount!: number;

  @Prop({ type: Number, default: 0 })
  skippedCount!: number;

  @Prop({ type: Number, default: 0 })
  whatsAppDispatchedCount!: number;

  @Prop({ type: Number, default: 0 })
  durationMs!: number;

  @Prop({
    required: true,
    enum: ['success', 'error'],
    default: 'success',
  })
  status!: 'success' | 'error';

  @Prop({ trim: true, default: '' })
  errorMessage!: string;

  @Prop({ type: Array, default: [] })
  sampleLeads!: Array<{
    leadId: string;
    name: string;
    phone: string;
    city: string;
    product: string;
    outcome: 'created' | 'deduplicated';
    assignedRepName: string;
    whatsAppSent: boolean;
    speedToLeadSeconds: number;
  }>;

  @Prop({ trim: true, default: () => new Date().toISOString() })
  syncedAt!: string;
}

export const MarketplaceSyncLogSchema =
  SchemaFactory.createForClass(MarketplaceSyncLog);
