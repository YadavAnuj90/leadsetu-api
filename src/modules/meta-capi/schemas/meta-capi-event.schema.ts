import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type MetaCapiEventDocument = HydratedDocument<MetaCapiEvent>;

export type MetaCapiEventName =
  | 'LeadSubmitted'
  | 'QualifiedLead'
  | 'Purchase'
  | 'Contact';

export type MetaCapiDispatchStatus =
  | 'sent'
  | 'local_simulated'
  | 'failed'
  | 'skipped';

@Schema({ timestamps: true, collection: 'meta_capi_events' })
export class MetaCapiEvent {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId!: Types.ObjectId;

  @Prop({ required: true, trim: true })
  eventId!: string;

  @Prop({
    required: true,
    enum: ['LeadSubmitted', 'QualifiedLead', 'Purchase', 'Contact'],
    index: true,
  })
  eventName!: MetaCapiEventName;

  @Prop({
    required: true,
    enum: ['sent', 'local_simulated', 'failed', 'skipped'],
    default: 'local_simulated',
    index: true,
  })
  status!: MetaCapiDispatchStatus;

  @Prop({
    default: 'lead',
    enum: ['lead', 'deal', 'invoice', 'conversation'],
  })
  entityType!: 'lead' | 'deal' | 'invoice' | 'conversation';

  @Prop({ trim: true, default: '', index: true })
  entityId!: string;

  @Prop({ trim: true, default: '' })
  entityLabel!: string;

  @Prop({ trim: true, default: '' })
  phone!: string;

  @Prop({ trim: true, default: '' })
  email!: string;

  @Prop({ trim: true, default: '' })
  ctwaClid!: string;

  @Prop({ trim: true, default: '', index: true })
  adId!: string;

  @Prop({ trim: true, default: '' })
  adHeadline!: string;

  @Prop({ trim: true, default: '' })
  adSourceUrl!: string;

  @Prop({ type: Number, default: 0 })
  valueInr!: number;

  @Prop({ trim: true, default: 'INR' })
  currency!: string;

  @Prop({ trim: true, default: '' })
  pixelId!: string;

  @Prop({ trim: true, default: '' })
  testEventCode!: string;

  @Prop({ trim: true, default: 'auto_lead_qualified' })
  triggeredBy!: string;

  @Prop({ type: Object, default: {} })
  requestPayload!: Record<string, unknown>;

  @Prop({ type: Object, default: {} })
  metaResponse!: Record<string, unknown>;

  @Prop({ trim: true, default: '' })
  errorMessage!: string;

  @Prop({ type: Number, default: 0 })
  eventsReceived!: number;

  @Prop({ type: Number, default: 0 })
  httpStatus!: number;

  @Prop({ trim: true, default: '' })
  fbtraceId!: string;

  @Prop({ trim: true, default: () => new Date().toISOString() })
  firedAt!: string;
}

export const MetaCapiEventSchema = SchemaFactory.createForClass(MetaCapiEvent);
