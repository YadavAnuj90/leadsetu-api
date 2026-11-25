import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'crypto';
import type {
  MetaFieldMappingItem,
  MetaFormQuestionItem,
} from './schemas/meta-page-connection.schema';

const DEFAULT_FALLBACK_KEY_SEED =
  'leadsetu_meta_token_encryption_key_2026_aes_256_gcm';

export function resolveAes256KeyBuffer(hexOrRawKey?: string): Buffer {
  const clean = String(hexOrRawKey || '').trim();
  if (/^[0-9a-fA-F]{64}$/.test(clean)) {
    return Buffer.from(clean, 'hex');
  }
  return createHash('sha256')
    .update(clean || DEFAULT_FALLBACK_KEY_SEED)
    .digest();
}

export function encryptMetaPageToken(
  plainToken: string,
  encryptionKey?: string,
): {
  encryptedPageAccessToken: string;
  tokenIv: string;
  tokenAuthTag: string;
} {
  const key = resolveAes256KeyBuffer(encryptionKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(String(plainToken || ''), 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return {
    encryptedPageAccessToken: encrypted.toString('hex'),
    tokenIv: iv.toString('hex'),
    tokenAuthTag: authTag.toString('hex'),
  };
}

export function decryptMetaPageToken(params: {
  encryptedPageAccessToken: string;
  tokenIv: string;
  tokenAuthTag: string;
  encryptionKey?: string;
}): string {
  const key = resolveAes256KeyBuffer(params.encryptionKey);
  const iv = Buffer.from(params.tokenIv, 'hex');
  const authTag = Buffer.from(params.tokenAuthTag, 'hex');
  const encrypted = Buffer.from(params.encryptedPageAccessToken, 'hex');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

/**
 * Verifies Meta `X-Hub-Signature-256` against raw request body using `META_APP_SECRET`.
 */
export function verifyMetaWebhookSignature(
  rawBody: Buffer | string | undefined,
  signatureHeader: string | undefined,
  appSecret: string | undefined,
): boolean {
  const secret = String(appSecret || '').trim();
  const provided = String(signatureHeader || '').trim();
  if (!secret || !provided || !provided.toLowerCase().startsWith('sha256=')) {
    return false;
  }

  const rawBuf = Buffer.isBuffer(rawBody)
    ? rawBody
    : Buffer.from(typeof rawBody === 'string' ? rawBody : '', 'utf8');

  const expectedHex =
    'sha256=' + createHmac('sha256', secret).update(rawBuf).digest('hex');

  try {
    const a = Buffer.from(expectedHex.toLowerCase(), 'utf8');
    const b = Buffer.from(provided.toLowerCase(), 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Normalizes Indian phone numbers (`9876543210`, `09876543210`, `+91-98765 43210`)
 * to canonical `+91XXXXXXXXXX`.
 */
export function normalizeIndianMetaPhone(raw?: string | null): string {
  const input = String(raw || '').trim();
  if (!input) return '';
  const digits = input.replace(/\D+/g, '');
  if (!digits) return '';

  // Strip leading 0 or 91 for 10-digit Indian mobile numbers
  if (digits.length === 10) {
    return `+91${digits}`;
  }
  if (digits.length === 11 && digits.startsWith('0')) {
    return `+91${digits.slice(1)}`;
  }
  if (digits.length === 12 && digits.startsWith('91')) {
    return `+91${digits.slice(2)}`;
  }
  if (digits.length > 10) {
    return `+91${digits.slice(-10)}`;
  }
  return `+91${digits}`;
}

const STANDARD_META_FIELD_MAP: Record<string, string> = {
  full_name: 'name',
  name: 'name',
  first_name: 'name',
  phone_number: 'phone',
  phone: 'phone',
  mobile_number: 'phone',
  whatsapp_number: 'phone',
  email: 'email',
  work_email: 'email',
  company_name: 'company',
  company: 'company',
  city: 'city',
  budget: 'estimatedValue',
  estimated_value: 'estimatedValue',
  requirement: 'notes',
  message: 'notes',
};

export function autoBuildFormFieldMappings(
  questions?: MetaFormQuestionItem[],
): MetaFieldMappingItem[] {
  const defaults: MetaFieldMappingItem[] = [
    { metaFieldKey: 'full_name', crmFieldKey: 'name' },
    { metaFieldKey: 'phone_number', crmFieldKey: 'phone' },
    { metaFieldKey: 'email', crmFieldKey: 'email' },
    { metaFieldKey: 'city', crmFieldKey: 'city' },
    { metaFieldKey: 'company_name', crmFieldKey: 'company' },
  ];

  if (!Array.isArray(questions) || questions.length === 0) {
    return defaults;
  }

  const seen = new Set<string>();
  const mapped: MetaFieldMappingItem[] = [];
  for (const q of questions) {
    const key = String(q.key || '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const lower = key.toLowerCase();
    const crmFieldKey = STANDARD_META_FIELD_MAP[lower] || 'rawFields';
    mapped.push({ metaFieldKey: key, crmFieldKey });
  }

  for (const d of defaults) {
    if (!seen.has(d.metaFieldKey)) {
      mapped.push(d);
    }
  }
  return mapped;
}

export interface MetaGraphFieldDataEntry {
  name: string;
  values?: string[];
}

export interface MappedMetaLeadFields {
  name: string;
  phone: string;
  email: string;
  company: string;
  city: string;
  estimatedValue: number;
  notes: string;
  customFields: Record<string, string>;
  rawFields: Record<string, string>;
}

/**
 * Maps Meta Graph API `field_data` array using saved `fieldMappings`
 * and stores all answers (plus unmapped answers) in `rawFields`.
 */
export function mapMetaFieldDataToLead(
  fieldData: MetaGraphFieldDataEntry[] | undefined,
  fieldMappings?: MetaFieldMappingItem[],
): MappedMetaLeadFields {
  const mappingLookup = new Map<string, string>();
  for (const item of fieldMappings || []) {
    if (item?.metaFieldKey && item?.crmFieldKey) {
      mappingLookup.set(item.metaFieldKey.trim().toLowerCase(), item.crmFieldKey.trim());
    }
  }

  const out: MappedMetaLeadFields = {
    name: '',
    phone: '',
    email: '',
    company: '',
    city: '',
    estimatedValue: 0,
    notes: '',
    customFields: {},
    rawFields: {},
  };

  for (const entry of fieldData || []) {
    const rawKey = String(entry?.name || '').trim();
    if (!rawKey) continue;
    const rawVal = Array.isArray(entry?.values)
      ? entry.values.map((v) => String(v ?? '').trim()).filter(Boolean).join(', ')
      : '';
    if (!rawVal) continue;

    out.rawFields[rawKey] = rawVal;

    const lowerKey = rawKey.toLowerCase();
    const target =
      mappingLookup.get(lowerKey) || STANDARD_META_FIELD_MAP[lowerKey] || 'rawFields';

    if (target === 'name') {
      out.name = out.name ? `${out.name} ${rawVal}`.trim() : rawVal;
    } else if (target === 'phone') {
      out.phone = normalizeIndianMetaPhone(rawVal);
    } else if (target === 'email') {
      out.email = rawVal.toLowerCase();
    } else if (target === 'company') {
      out.company = rawVal;
    } else if (target === 'city') {
      out.city = rawVal;
    } else if (target === 'estimatedValue') {
      const numeric = Number(rawVal.replace(/[^0-9.]/g, ''));
      if (Number.isFinite(numeric) && numeric > 0) {
        out.estimatedValue = Math.round(numeric);
      }
    } else if (target === 'notes') {
      out.notes = out.notes ? `${out.notes} | ${rawVal}` : rawVal;
    } else if (target.startsWith('customFields.')) {
      const cfKey = target.slice('customFields.'.length);
      if (cfKey) out.customFields[cfKey] = rawVal;
    }
  }

  return out;
}

export function signMetaOAuthState(
  payload: { tenantId: string; userId: string; nonce?: string; exp?: number },
  secret: string,
): string {
  const data = {
    tenantId: payload.tenantId,
    userId: payload.userId,
    nonce: payload.nonce || randomBytes(6).toString('hex'),
    exp: payload.exp || Date.now() + 15 * 60_000,
  };
  const encoded = Buffer.from(JSON.stringify(data), 'utf8').toString('base64url');
  const sig = createHmac('sha256', secret || DEFAULT_FALLBACK_KEY_SEED)
    .update(encoded)
    .digest('base64url');
  return `${encoded}.${sig}`;
}

export function verifyMetaOAuthState(
  stateToken: string,
  secret: string,
): { tenantId: string; userId: string } | null {
  const parts = String(stateToken || '').split('.');
  if (parts.length !== 2) return null;
  const [encoded, providedSig] = parts;
  const expectedSig = createHmac('sha256', secret || DEFAULT_FALLBACK_KEY_SEED)
    .update(encoded)
    .digest('base64url');

  try {
    const a = Buffer.from(expectedSig, 'utf8');
    const b = Buffer.from(providedSig, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const parsed = JSON.parse(
      Buffer.from(encoded, 'base64url').toString('utf8'),
    ) as { tenantId?: string; userId?: string; exp?: number };
    if (!parsed?.tenantId || !parsed?.userId) return null;
    if (parsed.exp && Date.now() > parsed.exp) return null;
    return { tenantId: parsed.tenantId, userId: parsed.userId };
  } catch {
    return null;
  }
}
