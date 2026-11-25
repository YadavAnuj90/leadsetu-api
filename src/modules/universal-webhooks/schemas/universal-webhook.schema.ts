import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type UniversalWebhookDocument = HydratedDocument<UniversalWebhook>;

export type UniversalWebhookMethod = 'GET' | 'POST';
export type UniversalWebhookAction =
  | 'create_lead'
  | 'create_contact'
  | 'create_deal';
export type UniversalWebhookStatus = 'listening' | 'active' | 'paused';
export type UniversalDuplicateStrategy =
  | 'fill_empty'
  | 'overwrite_non_empty';

export interface UniversalWebhookFieldMapping {
  sourceKey: string;
  targetField: string;
}

export interface UniversalWebhookStats {
  created: number;
  updated: number;
  failed: number;
}

@Schema({ timestamps: true, collection: 'universal_webhooks' })
export class UniversalWebhook {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId!: Types.ObjectId;

  @Prop({ required: true, trim: true })
  name!: string;

  @Prop({ required: true, trim: true, unique: true, index: true })
  webhookId!: string;

  @Prop({ required: true })
  encryptedSecretToken!: string;

  @Prop({ required: true })
  tokenIv!: string;

  @Prop({ required: true })
  tokenAuthTag!: string;

  @Prop({ required: true, enum: ['GET', 'POST'], default: 'POST' })
  allowedMethod!: UniversalWebhookMethod;

  @Prop({
    required: true,
    enum: ['create_lead', 'create_contact', 'create_deal'],
    default: 'create_lead',
  })
  targetAction!: UniversalWebhookAction;

  @Prop({
    required: true,
    enum: ['listening', 'active', 'paused'],
    default: 'listening',
    index: true,
  })
  status!: UniversalWebhookStatus;

  @Prop({
    required: true,
    enum: ['fill_empty', 'overwrite_non_empty'],
    default: 'fill_empty',
  })
  duplicateStrategy!: UniversalDuplicateStrategy;

  @Prop({ type: Boolean, default: false })
  triggerWhatsappOnNew!: boolean;

  @Prop({ type: Boolean, default: false })
  triggerWhatsappOnRepeat!: boolean;

  @Prop({ trim: true, default: '' })
  whatsappTemplateId?: string;

  @Prop({ type: Types.ObjectId, ref: 'User', default: null })
  defaultAssigneeId?: Types.ObjectId | null;

  @Prop({ trim: true, default: '' })
  optionalHeaderSecret?: string;

  @Prop({ type: Array, default: [] })
  fieldMappings!: UniversalWebhookFieldMapping[];

  @Prop({
    type: Object,
    default: () => ({ created: 0, updated: 0, failed: 0 }),
  })
  stats!: UniversalWebhookStats;

  @Prop({ type: Date, default: null })
  lastReceivedAt?: Date | null;
}

export const UniversalWebhookSchema =
  SchemaFactory.createForClass(UniversalWebhook);
