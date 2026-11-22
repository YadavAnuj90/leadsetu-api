import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type AiKnowledgeEntryDocument = HydratedDocument<AiKnowledgeEntry>;

export type AiKnowledgeCategory =
  | 'pricing_terms'
  | 'product_spec'
  | 'warranty_returns'
  | 'shipping_dispatch'
  | 'company_faq'
  | 'custom_sop';

@Schema({ timestamps: true, collection: 'ai_knowledge_entries' })
export class AiKnowledgeEntry {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId!: Types.ObjectId;

  @Prop({ required: true, trim: true })
  title!: string;

  @Prop({
    default: 'company_faq',
    enum: [
      'pricing_terms',
      'product_spec',
      'warranty_returns',
      'shipping_dispatch',
      'company_faq',
      'custom_sop',
    ],
    index: true,
  })
  category!: AiKnowledgeCategory;

  @Prop({ required: true, trim: true })
  content!: string;

  @Prop({ type: [String], default: [] })
  tags!: string[];

  @Prop({
    default: 'manual',
    enum: ['manual', 'catalog_sync', 'faq_preset'],
  })
  sourceType!: 'manual' | 'catalog_sync' | 'faq_preset';

  @Prop({ trim: true, default: '' })
  sourceRefId!: string;

  @Prop({ type: Boolean, default: true, index: true })
  isActive!: boolean;

  @Prop({ type: Number, default: 0 })
  hitCount!: number;
}

export const AiKnowledgeEntrySchema =
  SchemaFactory.createForClass(AiKnowledgeEntry);
AiKnowledgeEntrySchema.index({ tenantId: 1, sourceRefId: 1 });
