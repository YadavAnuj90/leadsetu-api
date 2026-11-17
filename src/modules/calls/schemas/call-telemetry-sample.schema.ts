import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import type { IcePathType } from './call-log.schema';

export type CallTelemetrySampleDocument = HydratedDocument<CallTelemetrySample>;

@Schema({ timestamps: false, collection: 'call_telemetry_samples' })
export class CallTelemetrySample {
  @Prop({ type: Types.ObjectId, ref: 'CallLog', required: true, index: true })
  callId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  reporterUserId!: Types.ObjectId;

  @Prop({ type: Date, required: true, default: () => new Date() })
  sampledAt!: Date;

  @Prop({ default: 'direct', enum: ['direct', 'turn_relay', 'failed'] })
  icePath!: IcePathType;

  @Prop({ type: Boolean, default: false })
  turnUsed!: boolean;

  @Prop({ trim: true, default: '' })
  localCandidateType!: string;

  @Prop({ trim: true, default: '' })
  remoteCandidateType!: string;

  @Prop({ trim: true, default: '' })
  relayProtocol!: string;

  @Prop({ type: Number, default: 0 })
  rttMs!: number;

  @Prop({ type: Number, default: 0 })
  jitterMs!: number;

  @Prop({ type: Number, default: 0 })
  packetsLost!: number;

  @Prop({ type: Number, default: 0 })
  bytesSent!: number;

  @Prop({ type: Number, default: 0 })
  bytesReceived!: number;

  @Prop({ trim: true, default: '' })
  iceConnectionState!: string;

  @Prop({ trim: true, default: '' })
  iceFailureReason!: string;
}

export const CallTelemetrySampleSchema = SchemaFactory.createForClass(
  CallTelemetrySample,
);
CallTelemetrySampleSchema.index({ callId: 1, sampledAt: 1 });
// Automatically purge raw periodic samples after 60 days while retaining aggregated CallLog summaries
CallTelemetrySampleSchema.index(
  { sampledAt: 1 },
  { expireAfterSeconds: 60 * 60 * 24 * 60 },
);
