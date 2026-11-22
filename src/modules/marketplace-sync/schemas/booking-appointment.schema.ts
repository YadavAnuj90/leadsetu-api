import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type BookingAppointmentDocument = HydratedDocument<BookingAppointment>;

export type BookingAppointmentStatus =
  | 'confirmed'
  | 'completed'
  | 'cancelled'
  | 'no_show';

@Schema({ timestamps: true, collection: 'booking_appointments' })
export class BookingAppointment {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId!: Types.ObjectId;

  @Prop({ required: true, trim: true, index: true })
  slug!: string;

  @Prop({ required: true, trim: true, unique: true })
  bookingRef!: string;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  assignedRepId?: Types.ObjectId;

  @Prop({ trim: true, default: '' })
  assignedRepName!: string;

  @Prop({ type: Types.ObjectId, ref: 'Lead' })
  leadId?: Types.ObjectId;

  @Prop({ trim: true, default: '' })
  taskId!: string;

  @Prop({ required: true, trim: true })
  guestName!: string;

  @Prop({ required: true, trim: true })
  guestPhone!: string;

  @Prop({ trim: true, lowercase: true, default: '' })
  guestEmail!: string;

  @Prop({ trim: true, default: '' })
  guestCompany!: string;

  @Prop({ trim: true, default: 'Product Demo & Quotation Consultation' })
  topic!: string;

  @Prop({ required: true, trim: true, index: true })
  dateYmd!: string;

  @Prop({ required: true, trim: true })
  slotLabel!: string;

  @Prop({ required: true, trim: true, index: true })
  slotStartIso!: string;

  @Prop({ required: true, trim: true })
  slotEndIso!: string;

  @Prop({ default: 'video_call', enum: ['video_call', 'phone_call', 'in_person'] })
  meetingType!: 'video_call' | 'phone_call' | 'in_person';

  @Prop({
    default: 'confirmed',
    enum: ['confirmed', 'completed', 'cancelled', 'no_show'],
    index: true,
  })
  status!: BookingAppointmentStatus;

  @Prop({ type: Boolean, default: false })
  confirmationSent!: boolean;

  @Prop({ type: Boolean, default: false, index: true })
  reminder1HrSent!: boolean;

  @Prop({ type: Boolean, default: false })
  noShowNudgeSent!: boolean;
}

export const BookingAppointmentSchema =
  SchemaFactory.createForClass(BookingAppointment);
BookingAppointmentSchema.index({ tenantId: 1, dateYmd: 1, slotStartIso: 1 });
