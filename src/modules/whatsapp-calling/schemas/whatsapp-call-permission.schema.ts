import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type WhatsappCallPermissionDocument =
  HydratedDocument<WhatsappCallPermission>;

export type WhatsappCallPermissionStatus =
  | 'none'
  | 'requested'
  | 'granted'
  | 'expired'
  | 'revoked';

@Schema({ timestamps: true, collection: 'whatsapp_call_permissions' })
export class WhatsappCallPermission {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId!: Types.ObjectId;

  @Prop({ required: true, trim: true })
  wabaPhoneNumberId!: string;

  /** Canonical E.164 format (+91XXXXXXXXXX) */
  @Prop({ required: true, trim: true })
  normalizedPhone!: string;

  @Prop({
    type: String,
    default: 'none',
    enum: ['none', 'requested', 'granted', 'expired', 'revoked'],
    index: true,
  })
  status!: WhatsappCallPermissionStatus;

  @Prop({ type: Date })
  grantedAt?: Date;

  /** 7 days after customer approval or inbound customer call */
  @Prop({ type: Date, index: true })
  expiresAt?: Date;

  @Prop({ type: Number, default: 0 })
  connectedCallsUsed!: number;

  /** Timestamps of outbound permission requests (used for 1/24h and 2/7d Meta caps) */
  @Prop({ type: [Date], default: [] })
  permissionRequestsTimestamps!: Date[];

  @Prop({ type: Types.ObjectId, ref: 'Lead', index: true })
  leadId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'ConversationThread' })
  conversationId?: Types.ObjectId;

  @Prop({ trim: true, default: '' })
  lastResponseSource?: string;
}

export const WhatsappCallPermissionSchema = SchemaFactory.createForClass(
  WhatsappCallPermission,
);

WhatsappCallPermissionSchema.index(
  { tenantId: 1, wabaPhoneNumberId: 1, normalizedPhone: 1 },
  { unique: true },
);
