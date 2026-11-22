import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type EmailAccountDocument = HydratedDocument<EmailAccount>;
export type EmailProviderPreset = 'gmail' | 'zoho' | 'outlook' | 'custom';

@Schema({ timestamps: true, collection: 'email_accounts' })
export class EmailAccount {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  userId!: Types.ObjectId;

  @Prop({
    type: String,
    default: 'gmail',
    enum: ['gmail', 'zoho', 'outlook', 'custom'],
  })
  providerPreset!: EmailProviderPreset;

  @Prop({ required: true, trim: true, lowercase: true })
  emailAddress!: string;

  @Prop({ trim: true, default: '' })
  displayName!: string;

  @Prop({ required: true, trim: true })
  smtpHost!: string;

  @Prop({ type: Number, default: 465 })
  smtpPort!: number;

  @Prop({ type: Boolean, default: true })
  smtpSecure!: boolean;

  @Prop({ trim: true, default: '' })
  imapHost!: string;

  @Prop({ type: Number, default: 993 })
  imapPort!: number;

  @Prop({ type: Boolean, default: true })
  imapSecure!: boolean;

  @Prop({ trim: true, default: '' })
  username!: string;

  @Prop({ required: true })
  appPasswordEncrypted!: string;

  @Prop({ default: '' })
  signatureHtml!: string;

  @Prop({ type: Boolean, default: true })
  isActive!: boolean;

  @Prop({ type: Date, default: null })
  lastSyncedAt?: Date | null;

  @Prop({ default: '' })
  lastSyncError!: string;
}

export const EmailAccountSchema = SchemaFactory.createForClass(EmailAccount);
EmailAccountSchema.index({ tenantId: 1, userId: 1 }, { unique: true });
