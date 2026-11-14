import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type UserDocument = HydratedDocument<User>;

@Schema({ timestamps: true, collection: 'users' })
export class User {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId!: Types.ObjectId;

  /**
   * Unique 10-digit numeric user ID (e.g. "4827301956"), globally unique.
   * Sparse so pre-existing users are back-filled lazily.
   */
  @Prop({ type: String, unique: true, sparse: true, trim: true })
  userCode?: string;

  @Prop({ required: true, trim: true })
  name!: string;

  @Prop({ required: true, unique: true, lowercase: true, trim: true, index: true })
  email!: string;

  @Prop({ trim: true })
  phone?: string;

  @Prop({ required: true })
  passwordHash!: string;

  @Prop({ default: 'owner', enum: ['owner', 'admin', 'manager', 'agent'] })
  role!: 'owner' | 'admin' | 'manager' | 'agent';

  @Prop({ default: true })
  isActive!: boolean;

  /** Sales territory, e.g. "Noida Sector 62 & Greater Noida". */
  @Prop({ trim: true, default: '' })
  territory?: string;

  /** Monthly revenue target in INR. */
  @Prop({ type: Number, default: 0 })
  monthlyTarget?: number;

  /** Optional per-member phone masking override (hides client phone numbers). */
  @Prop({ type: Boolean, default: false })
  maskPhones?: boolean;

  /** User who added this member (null for the workspace owner). */
  @Prop({ type: Types.ObjectId, ref: 'User', default: null })
  invitedBy?: Types.ObjectId | null;

  @Prop({ type: String, default: null })
  refreshTokenHash?: string | null;

  @Prop({ type: Date, default: null })
  lastLoginAt?: Date | null;
}

export const UserSchema = SchemaFactory.createForClass(User);
