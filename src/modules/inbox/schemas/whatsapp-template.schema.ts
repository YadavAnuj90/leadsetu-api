import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type WhatsAppTemplateCategory =
  | 'greeting'
  | 'quotation'
  | 'followup'
  | 'payment'
  | 'support'
  | 'custom';

export type WhatsAppTemplateLanguage = 'English' | 'Hinglish' | 'Hindi';

export type WhatsAppTemplateDocument = HydratedDocument<WhatsAppTemplate>;

@Schema({ timestamps: true, collection: 'whatsapp_templates' })
export class WhatsAppTemplate {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  createdByUserId?: Types.ObjectId;

  @Prop({ required: true, trim: true })
  name!: string;

  @Prop({ required: true, trim: true, lowercase: true })
  slug!: string;

  @Prop({
    default: 'custom',
    enum: ['greeting', 'quotation', 'followup', 'payment', 'support', 'custom'],
  })
  category!: WhatsAppTemplateCategory;

  @Prop({
    default: 'Hinglish',
    enum: ['English', 'Hinglish', 'Hindi'],
  })
  language!: WhatsAppTemplateLanguage;

  @Prop({ required: true, trim: true })
  body!: string;

  @Prop({ type: [String], default: [] })
  variables!: string[];

  @Prop({ type: Number, default: 0 })
  usageCount!: number;

  @Prop({ type: Boolean, default: true })
  isActive!: boolean;

  @Prop({ type: Boolean, default: false })
  isDefault!: boolean;
}

export const WhatsAppTemplateSchema =
  SchemaFactory.createForClass(WhatsAppTemplate);

WhatsAppTemplateSchema.index({ tenantId: 1, category: 1, updatedAt: -1 });
