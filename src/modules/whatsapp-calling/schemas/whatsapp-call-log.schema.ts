import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type WhatsappCallLogDocument = HydratedDocument<WhatsappCallLog>;

export type WhatsappCallDirection = 'inbound' | 'outbound';

export type WhatsappCallStatus =
  | 'ringing'
  | 'pre_accepted'
  | 'in_progress'
  | 'completed'
  | 'missed'
  | 'rejected'
  | 'failed';

@Schema({ timestamps: true, collection: 'whatsapp_call_logs' })
export class WhatsappCallLog {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Lead', index: true })
  leadId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'ConversationThread', index: true })
  conversationId?: Types.ObjectId;

  @Prop({ required: true, trim: true })
  wabaPhoneNumberId!: string;

  /** Canonical E.164 format (+91XXXXXXXXXX) kept server-side; masked for non-admin reps in DTOs */
  @Prop({ required: true, trim: true })
  normalizedPhone!: string;

  @Prop({ trim: true, unique: true, sparse: true })
  metaCallId?: string;

  @Prop({
    type: String,
    required: true,
    enum: ['inbound', 'outbound'],
  })
  direction!: WhatsappCallDirection;

  @Prop({
    type: String,
    default: 'ringing',
    enum: [
      'ringing',
      'pre_accepted',
      'in_progress',
      'completed',
      'missed',
      'rejected',
      'failed',
    ],
    index: true,
  })
  status!: WhatsappCallStatus;

  @Prop({ type: Number, default: 0 })
  durationSeconds!: number;

  /** Math.ceil(durationSeconds / 6) for outbound connected calls, 0 for inbound */
  @Prop({ type: Number, default: 0 })
  billedPulses!: number;

  @Prop({ type: Number, default: 0 })
  costInr!: number;

  @Prop({ type: Boolean, default: false })
  walletDeducted?: boolean;

  @Prop({ trim: true, default: '' })
  recordingUrl!: string;

  @Prop({ default: '' })
  transcript!: string;

  @Prop({ default: '' })
  aiSummary!: string;

  @Prop({ type: Object, default: {} })
  bantUpdates!: Record<string, unknown>;

  @Prop({ type: Types.ObjectId, ref: 'User', index: true })
  agentUserId?: Types.ObjectId;

  @Prop({ trim: true, default: '' })
  agentName?: string;

  @Prop({ type: Date })
  startedAt?: Date;

  @Prop({ type: Date })
  connectedAt?: Date;

  @Prop({ type: Date })
  endedAt?: Date;

  @Prop({ trim: true, default: '' })
  failureReason?: string;
}

export const WhatsappCallLogSchema =
  SchemaFactory.createForClass(WhatsappCallLog);
