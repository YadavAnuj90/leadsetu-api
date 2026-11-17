import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomBytes, randomInt, scryptSync, timingSafeEqual } from 'crypto';
import { Types, type Connection } from 'mongoose';

/** Minimal structural type for a Mongoose model that supports `.exists(...)`. */
export interface ExistsCapableModel {
  exists(filter: Record<string, unknown>): unknown;
}

/**
 * Workspace (admin account) ID: exactly 5 digits, 10000–99999.
 * Capacity: 90,000 workspaces — widen this if Leadsetu ever outgrows it.
 */
export const ACCOUNT_ID_LENGTH = 5;

/**
 * Per-user ID: exactly 10 digits (inside the required 8–10 digit range),
 * giving ~9 billion combinations so collisions are practically nil.
 */
export const USER_CODE_LENGTH = 10;

const MAX_ID_ATTEMPTS = 15;

/** Random number string of exact `length` digits (never starts with 0). */
export function randomDigits(length: number): string {
  const min = 10 ** (length - 1);
  const max = 10 ** length; // exclusive
  return String(randomInt(min, max));
}

/**
 * Generates a numeric ID that is not yet used for `field` in `model`.
 * The field also has a unique index, so a rare concurrent race is still
 * rejected by MongoDB (see `isDuplicateKeyError`).
 */
export async function generateUniqueNumericId(
  model: ExistsCapableModel,
  field: string,
  length: number,
): Promise<string> {
  for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt++) {
    const candidate = randomDigits(length);
    const taken = await model.exists({ [field]: candidate });
    if (!taken) return candidate;
  }
  throw new ServiceUnavailableException(
    `Could not allocate a unique ${field}. Please retry.`,
  );
}

export function generateAccountId(tenantModel: ExistsCapableModel) {
  return generateUniqueNumericId(tenantModel, 'accountId', ACCOUNT_ID_LENGTH);
}

export function generateUserCode(userModel: ExistsCapableModel) {
  return generateUniqueNumericId(userModel, 'userCode', USER_CODE_LENGTH);
}

/** True when `err` is a MongoDB E11000 duplicate-key error (optionally on `field`). */
export function isDuplicateKeyError(err: unknown, field?: string): boolean {
  const e = err as { code?: number; keyPattern?: Record<string, unknown> };
  if (e?.code !== 11000) return false;
  return field ? Boolean(e.keyPattern && field in e.keyPattern) : true;
}

// ─── Password hashing (scrypt, stored as `salt:hex`) ────────────────────────

export function hashSecret(plain: string): string {
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(plain, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function verifySecret(plain: string, storedHash: string): boolean {
  if (!storedHash || !storedHash.includes(':')) return false;
  const [salt, key] = storedHash.split(':');
  const keyBuffer = Buffer.from(key, 'hex');
  const derivedBuffer = scryptSync(plain, salt, 64);
  return (
    keyBuffer.length === derivedBuffer.length &&
    timingSafeEqual(keyBuffer, derivedBuffer)
  );
}

/** Readable temporary password, e.g. `Ls@7kQm4xP2`. Avoids 0/O/1/l/I confusion. */
export function generateTemporaryPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < 9; i++) out += alphabet[randomInt(0, alphabet.length)];
  return `Ls@${out}`;
}

/**
 * Normalises an Indian mobile number to `+91 XXXXX XXXXX`.
 * Returns null if it is not a valid 10-digit mobile (starting 6–9).
 */
export function normalizeIndianPhone(raw?: string): string | null {
  if (!raw) return null;
  let digits = raw.replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  if (!/^[6-9]\d{9}$/.test(digits)) return null;
  return `+91 ${digits.slice(0, 5)} ${digits.slice(5)}`;
}

/**
 * Masks phone numbers for restricted roles (e.g. "+91 98112 45678" -> "+91 98*** **678").
 * Leaves empty strings untouched and already-masked values idempotent.
 */
export function maskPhoneNumber(raw?: string): string {
  if (!raw || !raw.trim()) return '';
  if (raw.includes('***')) return raw;
  const digits = raw.replace(/\D/g, '');
  if (digits.length >= 10) {
    const local = digits.slice(-10);
    return `+91 ${local.slice(0, 2)}*** **${local.slice(7)}`;
  }
  if (digits.length >= 4) {
    return `${'*'.repeat(digits.length - 3)}${digits.slice(-3)}`;
  }
  return '***';
}

export function sha256Hex(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export function generateInviteToken(): { rawToken: string; tokenHash: string } {
  const rawToken = randomBytes(32).toString('hex');
  return { rawToken, tokenHash: sha256Hex(rawToken) };
}

export const USER_FEATURE_KEYS = [
  'leads',
  'aiScoring',
  'contacts',
  'deals',
  'whatsappCloud',
  'whatsappBroadcasts',
  'tasks',
  'slaTickets',
  'aiWorkflows',
  'analytics',
  'products',
  'gstBilling',
  'documentVault',
  'aiCreditRisk',
  'aiVoiceCrm',
  'aiDealerDesk',
  'aiCopilot',
] as const;

export type UserFeatureKey = (typeof USER_FEATURE_KEYS)[number];

export const USER_FEATURE_LABELS: Record<UserFeatureKey, string> = {
  leads: 'Leads Pipeline',
  aiScoring: 'SetuAI Lead Scoring',
  contacts: 'Contacts (B2B)',
  deals: 'Deals Pipeline',
  whatsappCloud: 'WhatsApp Cloud Inbox',
  whatsappBroadcasts: 'WhatsApp Broadcast Campaigns',
  tasks: 'Tasks & Follow-ups',
  slaTickets: 'SLA Service Tickets',
  aiWorkflows: 'AI Workflows',
  analytics: 'Revenue Analytics',
  products: 'Products & HSN Catalog',
  gstBilling: 'Quotations & 18% GST Invoices',
  documentVault: 'Document Center & KYC',
  aiCreditRisk: 'AI Credit & Udhaar Risk (Pillar 1)',
  aiVoiceCrm: 'AI Voice-to-CRM & Call Audit (Pillar 2)',
  aiDealerDesk: 'AI Dealer RFQ & Beat Planner (Pillar 3)',
  aiCopilot: 'Ask AI Copilot',
};

/**
 * Normalizes per-user feature toggles to an explicit map across all 13 CRM modules.
 * Owners and workspace admins always retain full access.
 * When `input` is omitted for managers/agents on creation or legacy profiles, defaults to true
 * unless `workspaceEffective` explicitly disables a workspace-level entitlement.
 */
export function normalizeUserFeatureAccess(
  input: Record<string, unknown> | undefined | null,
  role: string,
  workspaceEffective?: Partial<Record<string, boolean>> | null,
): Record<UserFeatureKey, boolean> {
  const out = {} as Record<UserFeatureKey, boolean>;
  const isAdmin = role === 'owner' || role === 'admin' || role === 'super_admin';

  for (const key of USER_FEATURE_KEYS) {
    const workspaceAllowed =
      !workspaceEffective || workspaceEffective[key] === undefined
        ? true
        : Boolean(workspaceEffective[key]);

    if (isAdmin) {
      out[key] = workspaceAllowed;
      continue;
    }

    const requested =
      input && typeof input === 'object' && key in input
        ? Boolean(input[key])
        : true;
    out[key] = workspaceAllowed && requested;
  }
  return out;
}

/**
 * Resolves per-user data visibility inside a workspace:
 * - Company Owners, Admins & Super Admins retain full workspace visibility (`{}`).
 * - Non-admin invited/added users (Sales Users, Sales Managers) only access records
 *   where `ownerId` matches their own User ID so Admin platform data is never shared
 *   and newly invited users start with clean blank modules.
 */
export async function resolveOwnerScopeFilter(
  connOrDb: Connection | Connection['db'] | undefined,
  auth: { userId?: string; tenantId?: string; role?: string },
): Promise<Record<string, unknown>> {
  if (!auth.userId || !Types.ObjectId.isValid(auth.userId)) {
    return { ownerId: null };
  }
  const userObjId = new Types.ObjectId(auth.userId);
  let liveRole = auth.role || '';
  const db =
    connOrDb && 'db' in connOrDb && connOrDb.db
      ? connOrDb.db
      : (connOrDb as Connection['db'] | undefined);

  if (db && typeof db.collection === 'function') {
    try {
      const userDoc = await db
        .collection('users')
        .findOne(
          { _id: userObjId },
          { projection: { role: 1 } },
        );
      if (userDoc?.role) {
        liveRole = String(userDoc.role);
      }
    } catch {
      // fall through using JWT role if lookup fails transiently
    }
  }

  if (
    liveRole === 'super_admin' ||
    liveRole === 'owner' ||
    liveRole === 'admin'
  ) {
    return {};
  }

  return { ownerId: userObjId };
}

/**
 * Validates and normalizes an optional organization logo URL or data URL.
 * Empty string clears the logo. Rejects non-image or oversized (> 2MB) payloads.
 */
export function sanitizeOrganizationLogoUrl(raw?: string | null): string {
  const val = String(raw || '').trim();
  if (!val) return '';
  if (val.length > 2_000_000) {
    throw new BadRequestException(
      'Organization logo image is too large. Please upload an image under 1.5 MB.',
    );
  }
  const isDataImage =
    /^data:image\/(png|jpeg|jpg|webp|gif|svg\+xml);base64,[A-Za-z0-9+/=]+$/i.test(
      val,
    );
  const isHttpImage = /^https?:\/\/\S+$/i.test(val);
  if (!isDataImage && !isHttpImage) {
    throw new BadRequestException(
      'Invalid logo format. Please upload a PNG, JPG, WEBP, or SVG image.',
    );
  }
  return val;
}
