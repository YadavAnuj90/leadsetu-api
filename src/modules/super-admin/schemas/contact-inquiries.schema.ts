import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type PublicContactInquiryDocument =
  HydratedDocument<PublicContactInquiry>;

export type ContactInquiryStatus =
  | 'new'
  | 'contacted'
  | 'demo_scheduled'
  | 'converted'
  | 'archived';

@Schema({ timestamps: true, collection: 'public_contact_inquiries' })
export class PublicContactInquiry {
  @Prop({ required: true, trim: true })
  name!: string;

  @Prop({ required: true, trim: true })
  company!: string;

  @Prop({ required: true, trim: true, lowercase: true, index: true })
  email!: string;

  @Prop({ trim: true, default: '' })
  phone!: string;

  @Prop({ required: true, trim: true, default: 'Enterprise Demo & Migration' })
  topic!: string;

  @Prop({ required: true, trim: true })
  message!: string;

  @Prop({
    required: true,
    default: 'new',
    enum: ['new', 'contacted', 'demo_scheduled', 'converted', 'archived'],
    index: true,
  })
  status!: ContactInquiryStatus;

  @Prop({ trim: true, default: '' })
  ownerNotes!: string;

  @Prop({ trim: true, default: 'company_contact' })
  source!: string;

  @Prop({ trim: true, default: '' })
  ipAddress?: string;
}

export const PublicContactInquirySchema =
  SchemaFactory.createForClass(PublicContactInquiry);
PublicContactInquirySchema.index({ createdAt: -1 });
