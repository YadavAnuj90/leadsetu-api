import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

export type WebhookDeliveryLogDocument = HydratedDocument<WebhookDeliveryLog>;

export type WebhookDeliveryOutcome =
  | 'created'
  | 'updated'
  | 'failed'
  | 'sample_captured';

@Schema({ collection: 'webhook_delivery_logs' })
export class WebhookDeliveryLog {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId!: Types.ObjectId;

  @Prop({ required: true, trim: true, index: true })
  webhookId!: string;

  @Prop({ required: true, trim: true })
  method!: string;

  @Prop({ type: MongooseSchema.Types.Mixed, default: {} })
  rawPayload!: unknown;

  @Prop({ type: Object, default: {} })
  flattenedPayload!: Record<string, unknown>;

  @Prop({ trim: true, default: '' })
  normalizedPhone!: string;

  @Prop({
    required: true,
    enum: ['created', 'updated', 'failed', 'sample_captured'],
    index: true,
  })
  outcome!: WebhookDeliveryOutcome;

  @Prop({ type: Types.ObjectId, default: null })
  matchedRecordId?: Types.ObjectId | null;

  @Prop({ trim: true, default: '' })
  matchedEntityType?: string;

  @Prop({ trim: true, default: '' })
  errorReason?: string;

  @Prop({ type: Date, default: () => new Date() })
  createdAt!: Date;
}

export const WebhookDeliveryLogSchema =
  SchemaFactory.createForClass(WebhookDeliveryLog);

// 7-day TTL index (604800 seconds)
WebhookDeliveryLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 604800 });
WebhookDeliveryLogSchema.index({ webhookId: 1, createdAt: -1 });
