import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type CustomFieldDocument = HydratedDocument<CustomField>;

export type CustomFieldEntity = 'lead' | 'contact' | 'deal';
export type CustomFieldType = 'text' | 'number' | 'dropdown' | 'date' | 'checkbox';

@Schema({ timestamps: true, collection: 'custom_fields' })
export class CustomField {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId!: Types.ObjectId;

  @Prop({
    required: true,
    enum: ['lead', 'contact', 'deal'],
    index: true,
  })
  entity!: CustomFieldEntity;

  @Prop({ required: true, trim: true })
  key!: string;

  @Prop({ required: true, trim: true })
  label!: string;

  @Prop({
    required: true,
    default: 'text',
    enum: ['text', 'number', 'dropdown', 'date', 'checkbox'],
  })
  type!: CustomFieldType;

  @Prop({ type: [String], default: [] })
  options!: string[];

  @Prop({ type: Boolean, default: false })
  required!: boolean;

  @Prop({ trim: true, default: '' })
  placeholder!: string;

  @Prop({ type: Object, default: null })
  defaultValue?: string | number | boolean | null;

  @Prop({ type: Boolean, default: true })
  showInCard!: boolean;

  @Prop({ type: Number, default: 0 })
  order!: number;

  @Prop({ type: Boolean, default: true })
  isActive!: boolean;
}

export const CustomFieldSchema = SchemaFactory.createForClass(CustomField);
CustomFieldSchema.index({ tenantId: 1, entity: 1, key: 1 }, { unique: true });
