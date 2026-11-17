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

  @Prop({ type: CallConnectionSummarySchema, default: () => ({}) })
  connection!: CallConnectionSummary;
}

export const CallLogSchema = SchemaFactory.createForClass(CallLog);
CallLogSchema.index({ tenantId: 1, startedAt: -1 });
CallLogSchema.index({ tenantId: 1, callerId: 1, calleeId: 1, startedAt: -1 });
