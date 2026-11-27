import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type UserDocument = HydratedDocument<User>;

export type UserRole =
  | 'super_admin'
  | 'owner'
  | 'admin'
  | 'manager'
  | 'agent'
  | 'support';

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

  @Prop({
    default: 'owner',
    enum: ['super_admin', 'owner', 'admin', 'manager', 'agent', 'support'],
  })
  role!: UserRole;

  /** Department workspace preset for RBAC feature scoping. */
  @Prop({
    trim: true,
    default: 'sales',
    enum: ['hq', 'executive', 'sales', 'finance', 'service', 'marketing', 'operations'],
  })
  departmentPreset?: string;

  /** Granular module:action permission overrides assigned by Admin / Super Admin. */
  @Prop({ type: [String], default: [] })
  permissions?: string[];

  /** Per-user CRM module feature toggles managed by Workspace Owner / Admin. */
  @Prop({ type: Object, default: {} })
  featureAccess?: Record<string, boolean>;

  /** Invite onboarding state & SHA-256 hashed one-time invite token. */
  @Prop({ type: String, default: null })
  inviteTokenHash?: string | null;

  @Prop({ type: Date, default: null })
  inviteExpiresAt?: Date | null;

  @Prop({ type: Date, default: null })
  inviteSentAt?: Date | null;

  @Prop({
    type: String,
    default: 'active',
    enum: ['active', 'pending', 'accepted'],
  })
  inviteStatus?: 'active' | 'pending' | 'accepted';

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

  /** Per-user daily AI call limit set by Company Admin (0 = unlimited within workspace balance). */
  @Prop({ type: Number, default: 0 })
  aiDailyCallLimit?: number;

  /** Number of AI calls made by this user on `aiCallsDayKey` (YYYY-MM-DD). */
  @Prop({ type: Number, default: 0 })
  aiCallsToday?: number;

  @Prop({ type: String, default: '' })
  aiCallsDayKey?: string;

  /** User who added this member (null for the workspace owner / super admin). */
  @Prop({ type: Types.ObjectId, ref: 'User', default: null })
  invitedBy?: Types.ObjectId | null;

  @Prop({ type: String, default: null })
  refreshTokenHash?: string | null;

  /** Incremented whenever a user's active JWT sessions are force-revoked. */
  @Prop({ type: Number, default: 1 })
  sessionVersion?: number;

  @Prop({ type: Date, default: null })
  lastLoginAt?: Date | null;

  /** Password recovery one-time SHA-256 token & expiry metadata. */
  @Prop({ type: String, default: null })
  resetPasswordTokenHash?: string | null;

  @Prop({ type: Date, default: null })
  resetPasswordExpiresAt?: Date | null;

  @Prop({ type: Date, default: null })
  resetPasswordRequestedAt?: Date | null;

  /** Google OAuth identity metadata. */
  @Prop({ type: String, sparse: true, default: null })
  googleSub?: string | null;

  @Prop({ type: String, default: 'local', enum: ['local', 'google'] })
  authProvider?: 'local' | 'google';

  @Prop({ type: String, default: '' })
  avatarUrl?: string;

  /** Authenticator App (TOTP RFC 6238) 2FA metadata. */
  @Prop({ type: Boolean, default: false })
  twoFactorEnabled?: boolean;

  @Prop({ type: String, default: null })
  twoFactorSecretEncrypted?: string | null;

  @Prop({ type: String, default: null })
  twoFactorPendingSecretEncrypted?: string | null;

  @Prop({ type: [String], default: [] })
  twoFactorBackupCodesHashes?: string[];

  /** Rep shift & lead-routing availability status (does not block CRM sign-in). */
  @Prop({
    type: String,
    default: 'available',
    enum: ['available', 'away', 'on_leave'],
  })
  availabilityStatus?: 'available' | 'away' | 'on_leave';

  @Prop({ type: String, trim: true, default: '09:30' })
  shiftStart?: string;

  @Prop({ type: String, trim: true, default: '19:30' })
  shiftEnd?: string;

  @Prop({ type: String, trim: true, default: '' })
  leaveNote?: string;

  @Prop({ type: Date, default: null })
  availabilityUpdatedAt?: Date | null;
}

export const UserSchema = SchemaFactory.createForClass(User);
