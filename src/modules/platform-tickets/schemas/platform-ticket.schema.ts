import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type PlatformTicketDocument = HydratedDocument<PlatformTicket>;

export type PlatformTicketCategory =
  | 'ui_glitch'
  | 'whatsapp_api'
  | 'indiamart_sync'
  | 'gst_invoicing'
  | 'calling_webrtc'
  | 'billing_plan'
  | 'feature_help'
  | 'other';

export type PlatformTicketPriority = 'low' | 'medium' | 'high' | 'urgent';

export type PlatformTicketStatus =
  | 'open'
  | 'in_progress'
  | 'waiting_admin'
  | 'resolved'
  | 'closed';

@Schema({ _id: false })
export class PlatformTicketComment {
  @Prop({ required: true, trim: true })
  id!: string;

  @Prop({ required: true, trim: true })
  authorName!: string;

  @Prop({
    required: true,
    enum: ['tenant_admin', 'super_admin', 'system'],
  })
  authorRole!: 'tenant_admin' | 'super_admin' | 'system';

  @Prop({ required: true, trim: true })
  message!: string;

  @Prop({ required: true, trim: true })
  createdAt!: string;
}

export const PlatformTicketCommentSchema = SchemaFactory.createForClass(
  PlatformTicketComment,
);

@Schema({ timestamps: true, collection: 'platform_tickets' })
export class PlatformTicket {
  @Prop({ required: true, trim: true, index: true })
  ticketNumber!: string;

  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId!: Types.ObjectId;

  /** Auto-captured from logged-in workspace; visible to Super Admin, omitted from Admin form. */
  @Prop({ trim: true, default: '', index: true })
  accountId!: string;

  @Prop({ trim: true, default: '' })
  companyName!: string;

  @Prop({ trim: true, default: 'b2b' })
  businessMode!: string;

  @Prop({ trim: true, default: 'starter' })
  tenantPlan!: string;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  raisedByUserId!: Types.ObjectId;

  @Prop({ trim: true, default: '' })
  raisedByName!: string;

  @Prop({ trim: true, lowercase: true, default: '' })
  raisedByEmail!: string;

  @Prop({ trim: true, default: 'admin' })
  raisedByRole!: string;

  @Prop({ required: true, trim: true })
  subject!: string;

  @Prop({
    default: 'ui_glitch',
    enum: [
      'ui_glitch',
      'whatsapp_api',
      'indiamart_sync',
      'gst_invoicing',
      'calling_webrtc',
      'billing_plan',
      'feature_help',
      'other',
    ],
    index: true,
  })
  category!: PlatformTicketCategory;

  @Prop({
    default: 'medium',
    enum: ['low', 'medium', 'high', 'urgent'],
    index: true,
  })
  priority!: PlatformTicketPriority;

  @Prop({
    default: 'open',
    enum: ['open', 'in_progress', 'waiting_admin', 'resolved', 'closed'],
    index: true,
  })
  status!: PlatformTicketStatus;

  @Prop({ required: true, trim: true })
  description!: string;

  @Prop({ trim: true, default: '' })
  pageUrl!: string;

  @Prop({ trim: true, default: '' })
  resolutionSummary!: string;

  @Prop({ trim: true, default: '' })
  resolvedByName!: string;

  @Prop({ trim: true, default: '' })
  resolvedAt!: string;

  @Prop({ type: [PlatformTicketCommentSchema], default: [] })
  comments!: PlatformTicketComment[];
}

export const PlatformTicketSchema =
  SchemaFactory.createForClass(PlatformTicket);
