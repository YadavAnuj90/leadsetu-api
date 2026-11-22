import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type EmailTemplateDocument = HydratedDocument<EmailTemplate>;

export type EmailTemplateCategory =
  | 'proforma'
  | 'quotation'
  | 'followup'
  | 'udhaar'
  | 'welcome'
  | 'custom';

@Schema({ timestamps: true, collection: 'email_templates' })
export class EmailTemplate {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId!: Types.ObjectId;

  @Prop({ required: true, trim: true })
  name!: string;

  @Prop({
    type: String,
    default: 'custom',
    enum: ['proforma', 'quotation', 'followup', 'udhaar', 'welcome', 'custom'],
  })
  category!: EmailTemplateCategory;

  @Prop({ required: true, trim: true })
  subject!: string;

  @Prop({ required: true })
  bodyHtml!: string;
}

export const EmailTemplateSchema = SchemaFactory.createForClass(EmailTemplate);
EmailTemplateSchema.index({ tenantId: 1, name: 1 });
