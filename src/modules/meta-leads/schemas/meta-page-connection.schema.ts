import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type MetaPageConnectionDocument = HydratedDocument<MetaPageConnection>;

export type MetaPageConnectionStatus =
  | 'active'
  | 'needs_reconnect'
  | 'disconnected';

export interface MetaFieldMappingItem {
  metaFieldKey: string;
  crmFieldKey: string;
}

export interface MetaFormQuestionItem {
  key: string;
  label: string;
}

export interface MetaLeadFormConfig {
  formId: string;
  formName: string;
  status: string;
  autoReplyEnabled: boolean;
  whatsappTemplateId?: string;
  defaultAssigneeId?: string;
  questions?: MetaFormQuestionItem[];
  fieldMappings: MetaFieldMappingItem[];
}

@Schema({ timestamps: true, collection: 'meta_page_connections' })
export class MetaPageConnection {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId!: Types.ObjectId;

  @Prop({ required: true, trim: true, index: true })
  pageId!: string;

  @Prop({ required: true, trim: true })
  pageName!: string;

  @Prop({ required: true })
  encryptedPageAccessToken!: string;

  @Prop({ required: true })
  tokenIv!: string;

  @Prop({ required: true })
  tokenAuthTag!: string;

  @Prop({ type: Boolean, default: false })
  isSubscribed!: boolean;

  @Prop({
    default: 'active',
    enum: ['active', 'needs_reconnect', 'disconnected'],
    index: true,
  })
  status!: MetaPageConnectionStatus;

  @Prop({ trim: true, default: '' })
  lastError!: string;

  @Prop({ type: Date, default: null })
  lastLeadReceivedAt?: Date | null;

  @Prop({ type: Array, default: [] })
  forms!: MetaLeadFormConfig[];
}

export const MetaPageConnectionSchema =
  SchemaFactory.createForClass(MetaPageConnection);

MetaPageConnectionSchema.index({ tenantId: 1, pageId: 1 }, { unique: true });
