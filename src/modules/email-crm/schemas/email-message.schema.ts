import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type EmailMessageDocument = HydratedDocument<EmailMessage>;

@Schema({ timestamps: true, collection: 'email_messages' })
export class EmailMessage {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  ownerId!: Types.ObjectId;

  @Prop({
    required: true,
    enum: ['outbound', 'inbound'],
    index: true,
  })
  direction!: 'outbound' | 'inbound';

  @Prop({ required: true, lowercase: true, trim: true })
  fromEmail!: string;

  @Prop({ required: true, lowercase: true, trim: true })
  toEmail!: string;

  @Prop({ required: true, trim: true })
  subject!: string;

  @Prop({ default: '' })
  bodyText!: string;

  @Prop({ default: '' })
  bodyHtml!: string;

  @Prop({ type: String, default: '', index: true })
  rfcMessageId!: string;

  @Prop({ type: String, default: '' })
  entityType!: 'lead' | 'contact' | 'deal' | '';

  @Prop({ type: String, default: '', index: true })
  entityId!: string;

  @Prop({ type: String, default: '' })
  entityLabel!: string;

  @Prop({ type: String, sparse: true, index: true })
  trackingId?: string;

  @Prop({ type: Number, default: 0 })
  openCount!: number;

  @Prop({ type: Date, default: null })
  firstOpenedAt?: Date | null;

  @Prop({ type: Date, default: null })
  lastOpenedAt?: Date | null;

  @Prop({
    type: String,
    default: 'sent',
    enum: ['sent', 'received', 'failed'],
  })
  status!: 'sent' | 'received' | 'failed';

  @Prop({ type: Date, default: () => new Date(), index: true })
  sentAt!: Date;
}

export const EmailMessageSchema = SchemaFactory.createForClass(EmailMessage);
EmailMessageSchema.index({ tenantId: 1, entityType: 1, entityId: 1, sentAt: -1 });
