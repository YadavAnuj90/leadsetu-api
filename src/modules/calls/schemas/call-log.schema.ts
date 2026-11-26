import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type CallLogDocument = HydratedDocument<CallLog>;

export type CallLogStatus =
  | 'ringing'
  | 'connecting'
  | 'connected'
  | 'completed'
  | 'rejected'
  | 'missed'
  | 'cancelled'
  | 'timeout'
  | 'failed';

export type IcePathType = 'direct' | 'turn_relay' | 'failed';

@Schema({ _id: false })
export class CallConnectionSummary {
  @Prop({ default: 'direct', enum: ['direct', 'turn_relay', 'failed'] })
  icePath!: IcePathType;

  @Prop({ type: Boolean, default: false })
  turnUsed!: boolean;

  @Prop({ trim: true, default: '' })
  relayProtocol!: string;

  @Prop({ type: Number, default: 0 })
  rttMs!: number;

  @Prop({ type: Number, default: 0 })
  maxRttMs!: number;

  @Prop({ type: Number, default: 0 })
  packetsLost!: number;

  @Prop({ type: Number, default: 0 })
  bytesSent!: number;

  @Prop({ type: Number, default: 0 })
  bytesReceived!: number;

  @Prop({ trim: true, default: '' })
  iceFailureReason!: string;
}

export const CallConnectionSummarySchema = SchemaFactory.createForClass(
  CallConnectionSummary,
);

@Schema({ timestamps: true, collection: 'call_logs' })
export class CallLog {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  callerId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  calleeId!: Types.ObjectId;

  @Prop({ trim: true, default: '' })
  callerName!: string;

  @Prop({ trim: true, default: '' })
  callerRole!: string;

  @Prop({ trim: true, default: '' })
  callerUserCode!: string;

  @Prop({ trim: true, default: '' })
  calleeName!: string;

  @Prop({ trim: true, default: '' })
  calleeRole!: string;

  @Prop({ trim: true, default: '' })
  calleeUserCode!: string;

  @Prop({
    default: 'ringing',
    enum: [
      'ringing',
      'connecting',
      'connected',
      'completed',
      'rejected',
      'missed',
      'cancelled',
      'timeout',
      'failed',
    ],
    index: true,
  })
  status!: CallLogStatus;

  @Prop({ type: Date, required: true, index: true })
  startedAt!: Date;

  @Prop({ type: Date, default: null })
  answeredAt?: Date | null;

  @Prop({ type: Date, default: null })
  connectedAt?: Date | null;

  @Prop({ type: Date, default: null })
  endedAt?: Date | null;

  @Prop({ type: Number, default: 0 })
  setupTimeMs!: number;

  @Prop({ type: Number, default: 0 })
  durationSeconds!: number;

  @Prop({ trim: true, default: '' })
  endedByUserId!: string;

  @Prop({ trim: true, default: '' })
  endReason!: string;

  @Prop({ default: 'webrtc', enum: ['webrtc', 'sim_mobile'], index: true })
  callChannel!: 'webrtc' | 'sim_mobile';

  @Prop({ default: 'agent', enum: ['agent', 'customer'] })
  callerType!: 'agent' | 'customer';

  @Prop({ trim: true, default: '' })
  customerPhone!: string;

  @Prop({ trim: true, default: '' })
  customerEmail!: string;

  @Prop({
    trim: true,
    default: '',
    enum: ['', 'lead', 'deal', 'ticket', 'contact'],
    index: true,
  })
  linkedEntityType!: '' | 'lead' | 'deal' | 'ticket' | 'contact';

  @Prop({ trim: true, default: '', index: true })
  linkedEntityId!: string;

  @Prop({ trim: true, default: '' })
  linkedEntityLabel!: string;

  @Prop({ trim: true, default: '' })
  notes!: string;

  @Prop({ trim: true, default: '' })
  outcomeTag!: string;

  @Prop({ trim: true, default: '' })
  dispositionByUserId!: string;

  @Prop({ type: Date, default: null })
  dispositionAt?: Date | null;

  @Prop({ trim: true, default: '' })
  followUpTaskId!: string;

  @Prop({ type: Boolean, default: false, index: true })
  callbackResolved!: boolean;

  @Prop({ type: Date, default: null })
  callbackResolvedAt?: Date | null;

  @Prop({ trim: true, default: '' })
  callbackResolvedByUserId!: string;

  @Prop({ trim: true, default: '' })
  recordingUrl!: string;

  @Prop({ type: Number, default: 0 })
  recordingDurationSeconds!: number;

  @Prop({ trim: true, default: '' })
  recordedByUserId!: string;

  @Prop({ type: Date, default: null })
  recordedAt?: Date | null;

  @Prop({ trim: true, default: '' })
  transferredFromUserId!: string;

  @Prop({ trim: true, default: '' })
  transferredFromName!: string;

  @Prop({ trim: true, default: '' })
  transferredToUserId!: string;

  @Prop({ trim: true, default: '' })
  transferredToName!: string;

  @Prop({ trim: true, default: '' })
  aiTranscript?: string;

  @Prop({ trim: true, default: '' })
  aiSummary?: string;

  @Prop({ type: [String], default: [] })
  aiObjections?: string[];

  @Prop({
    trim: true,
    default: '',
    enum: ['', 'positive', 'neutral', 'negative', 'mixed'],
  })
  aiSentiment?: 'positive' | 'neutral' | 'negative' | 'mixed' | '';

  @Prop({ trim: true, default: '' })
  aiSuggestedTaskTitle?: string;

  @Prop({ trim: true, default: 'medium', enum: ['high', 'medium', 'low'] })
  aiSuggestedTaskPriority?: 'high' | 'medium' | 'low';

  @Prop({ type: Date, default: null })
  aiTranscribedAt?: Date | null;

  @Prop({ type: CallConnectionSummarySchema, default: () => ({}) })
  connection!: CallConnectionSummary;
}

export const CallLogSchema = SchemaFactory.createForClass(CallLog);
CallLogSchema.index({ tenantId: 1, startedAt: -1 });
CallLogSchema.index({ tenantId: 1, callerId: 1, calleeId: 1, startedAt: -1 });
