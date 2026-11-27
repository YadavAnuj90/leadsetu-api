import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type CallingWalletTransactionDocument =
  HydratedDocument<CallingWalletTransaction>;

export type CallingWalletTxType =
  | 'starter_credit'
  | 'razorpay_topup'
  | 'admin_credit'
  | 'call_deduction'
  | 'refund';

@Schema({ timestamps: true, collection: 'calling_wallet_transactions' })
export class CallingWalletTransaction {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId!: Types.ObjectId;

  @Prop({
    type: String,
    required: true,
    enum: [
      'starter_credit',
      'razorpay_topup',
      'admin_credit',
      'call_deduction',
      'refund',
    ],
    index: true,
  })
  type!: CallingWalletTxType;

  /** Positive for credit/top-up, negative for 6s pulse call deduction */
  @Prop({ type: Number, required: true })
  amountInr!: number;

  @Prop({ type: Number, required: true })
  balanceAfterInr!: number;

  @Prop({ trim: true, default: '' })
  referenceId?: string;

  @Prop({ trim: true, default: '' })
  description!: string;

  @Prop({ trim: true, default: '' })
  actorEmail?: string;
}

export const CallingWalletTransactionSchema = SchemaFactory.createForClass(
  CallingWalletTransaction,
);
