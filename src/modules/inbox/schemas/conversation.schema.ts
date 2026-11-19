import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type ConversationDocument = HydratedDocument<ConversationThread>;

export type LinkedCrmEntityType = '' | 'lead' | 'contact' | 'deal' | 'ticket';

export interface ChatAttachment {
  type: 'document' | 'image';
  url: string;
  filename?: string;
  mimeType?: string;
}

export interface ChatMessage {
  id: string;
  direction: 'inbound' | 'outbound';
  content: string;
  senderName: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  isAiDrafted?: boolean;
  templateId?: string;
  templateName?: string;
  via?: 'inbox' | 'wa_me';
  externalMessageId?: string;
  deliveryProvider?: 'meta_cloud' | 'crm_local' | 'wa_me';
  deliveryError?: string;
  metaTemplateName?: string;
  campaignId?: string;
  workflowId?: string;
  attachment?: ChatAttachment;
  statusUpdatedAt?: string;
  createdAt: string;
}

@Schema({ timestamps: true, collection: 'conversations' })
export class ConversationThread {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', index: true })
  ownerId?: Types.ObjectId;

  @Prop({ required: true, trim: true })
  contactName!: string;

  @Prop({ trim: true, default: '' })
  company!: string;

  @Prop({ trim: true, default: '' })
  phone!: string;

  @Prop({ trim: true, default: 'Delhi-NCR' })
  city!: string;

  @Prop({
    default: 'whatsapp',
    enum: ['whatsapp', 'indiamart', 'email'],
  })
  channel!: 'whatsapp' | 'indiamart' | 'email';

  @Prop({
    default: 'open',
    enum: ['open', 'resolved'],
    index: true,
  })
  status!: 'open' | 'resolved';

  @Prop({ type: Number, default: 85 })
  aiScore!: number;

  @Prop({ type: Number, default: 0 })
  estimatedValue!: number;

  @Prop({ default: '' })
  aiSummary!: string;

  @Prop({ default: '' })
  aiSuggestedReply!: string;

  @Prop({
    default: '',
    enum: ['', 'lead', 'contact', 'deal', 'ticket'],
  })
  linkedEntityType!: LinkedCrmEntityType;

  @Prop({ default: '', index: true })
  linkedEntityId!: string;

  @Prop({ default: '' })
  linkedEntityLabel!: string;

  @Prop({ type: Number, default: 0 })
  unreadCount?: number;

  @Prop({ default: '' })
  lastInboundAt?: string;

  @Prop({ type: Boolean, default: false })
  whatsappOptOut?: boolean;

  @Prop({ default: '' })
  whatsappOptOutAt?: string;

  @Prop({ type: Array, default: [] })
  messages!: ChatMessage[];
}

export const ConversationThreadSchema =
  SchemaFactory.createForClass(ConversationThread);
