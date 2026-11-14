import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type TenantDocument = HydratedDocument<Tenant>;

@Schema({ timestamps: true, collection: 'tenants' })
export class Tenant {
  @Prop({ required: true, trim: true })
  name!: string;

  @Prop({ required: true, unique: true, lowercase: true, trim: true })
  slug!: string;

  /**
   * Unique 5-digit workspace / admin account ID (e.g. "48213").
   * Sparse so pre-existing tenants without one don't clash; they are
   * back-filled on next login or team page load.
   */
  @Prop({ type: String, unique: true, sparse: true, trim: true })
  accountId?: string;

  @Prop({ default: 'starter', enum: ['starter', 'growth', 'enterprise'] })
  plan!: 'starter' | 'growth' | 'enterprise';

  @Prop({ default: 'trial', enum: ['trial', 'active', 'suspended'] })
  status!: 'trial' | 'active' | 'suspended';

  @Prop({ trim: true })
  city?: string;

  /** Anti-data-leak shield: mask client mobile numbers for agent role. */
  @Prop({ type: Boolean, default: false })
  maskPhoneForAgents?: boolean;

  /** Anti-data-leak shield: prevent bulk CSV exports by non-admin agents. */
  @Prop({ type: Boolean, default: true })
  blockAgentExport?: boolean;

  /** Unique secret key for inbound webhooks (IndiaMART / Justdial / Website forms). */
  @Prop({ type: String, unique: true, sparse: true, trim: true })
  webhookKey?: string;

  /** Counter for round-robin auto-assignment across active sales reps. */
  @Prop({ type: Number, default: 0 })
  roundRobinIndex?: number;
}

export const TenantSchema = SchemaFactory.createForClass(Tenant);
