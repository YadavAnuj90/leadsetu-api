import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'crypto';
import type {
  UniversalWebhookAction,
  UniversalWebhookFieldMapping,
} from './schemas/universal-webhook.schema';

const FALLBACK_KEY_SEED =
  'leadsetu_universal_webhook_secret_key_2026_aes_256_gcm';

export interface CrmActionFieldSpec {
  key: string;
  label: string;
  required?: boolean;
  type: 'string' | 'number' | 'phone' | 'email';
}

export interface CrmActionSpec {
  action: UniversalWebhookAction;
  label: string;
  entityType: 'lead' | 'contact' | 'deal';
  description: string;
  fields: CrmActionFieldSpec[];
}

export const SUPPORTED_UNIVERSAL_WEBHOOK_ACTIONS: CrmActionSpec[] = [
  {
    action: 'create_lead',
    label: 'Create / Upsert Lead',
    entityType: 'lead',
    description:
      'Captures or updates a CRM Lead deduplicated by phone number without resetting existing pipeline status.',
    fields: [
      { key: 'phone', label: 'WhatsApp / Mobile Phone (+91)', required: true, type: 'phone' },
      { key: 'name', label: 'Lead Full Name', type: 'string' },
      { key: 'company', label: 'Company / Firm Name', type: 'string' },
      { key: 'email', label: 'Email Address', type: 'email' },
      { key: 'city', label: 'City / Territory', type: 'string' },
      { key: 'estimatedValue', label: 'Estimated Deal Value (₹)', type: 'number' },
      { key: 'notes', label: 'Requirement / Inquiry Notes', type: 'string' },
    ],
  },
  {
    action: 'create_contact',
    label: 'Create / Upsert Contact',
    entityType: 'contact',
    description:
      'Creates or merges a B2B/B2C Contact record deduplicated by phone number.',
    fields: [
      { key: 'phone', label: 'WhatsApp / Mobile Phone (+91)', required: true, type: 'phone' },
      { key: 'name', label: 'Contact Full Name', type: 'string' },
      { key: 'company', label: 'Company Name', type: 'string' },
      { key: 'designation', label: 'Job Title / Designation', type: 'string' },
      { key: 'email', label: 'Email Address', type: 'email' },
      { key: 'city', label: 'City', type: 'string' },
      { key: 'gstin', label: '15-Digit GSTIN', type: 'string' },
      { key: 'notes', label: 'Contact Notes', type: 'string' },
    ],
  },
  {
    action: 'create_deal',
    label: 'Create / Upsert Deal',
    entityType: 'deal',
    description:
      'Creates or updates an active Pipeline Deal deduplicated by buyer phone number while preserving stage.',
    fields: [
      { key: 'phone', label: 'Buyer Mobile Phone (+91)', required: true, type: 'phone' },
      { key: 'title', label: 'Deal Title', type: 'string' },
      { key: 'contactName', label: 'Buyer Contact Name', type: 'string' },
      { key: 'company', label: 'Company Name', type: 'string' },
      { key: 'contactEmail', label: 'Buyer Email', type: 'email' },
      { key: 'city', label: 'City', type: 'string' },
      { key: 'value', label: 'Deal Value (₹)', type: 'number' },
      { key: 'notes', label: 'Deal Notes', type: 'string' },
    ],
  },
];

function resolveAesKey(rawKey?: string): Buffer {
  const clean = String(rawKey || '').trim();
  if (/^[0-9a-fA-F]{64}$/.test(clean)) {
    return Buffer.from(clean, 'hex');
  }
  return createHash('sha256').update(clean || FALLBACK_KEY_SEED).digest();
}

export function encryptWebhookSecret(
  plainToken: string,
  encryptionKey?: string,
): {
  encryptedSecretToken: string;
  tokenIv: string;
  tokenAuthTag: string;
} {
  const key = resolveAesKey(encryptionKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(String(plainToken || ''), 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return {
    encryptedSecretToken: encrypted.toString('hex'),
    tokenIv: iv.toString('hex'),
    tokenAuthTag: authTag.toString('hex'),
  };
}

export function decryptWebhookSecret(params: {
  encryptedSecretToken: string;
  tokenIv: string;
  tokenAuthTag: string;
  encryptionKey?: string;
}): string {
  const key = resolveAesKey(params.encryptionKey);
  const iv = Buffer.from(params.tokenIv, 'hex');
  const authTag = Buffer.from(params.tokenAuthTag, 'hex');
  const encrypted = Buffer.from(params.encryptedSecretToken, 'hex');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

export function timingSafeMatchSecret(
  expected: string,
  provided: string,
): boolean {
  const aStr = String(expected || '');
  const bStr = String(provided || '');
  if (!aStr || !bStr || aStr.length !== bStr.length) return false;
  try {
    return timingSafeEqual(Buffer.from(aStr, 'utf8'), Buffer.from(bStr, 'utf8'));
  } catch {
    return false;
  }
}

/**
 * Flattens nested JSON objects into dot-notation (`customer.mobile` -> `'customer.mobile'`).
 */
export function flattenWebhookPayload(
  input: unknown,
  prefix = '',
  out: Record<string, string> = {},
): Record<string, string> {
  if (input === null || input === undefined) return out;
  if (typeof input !== 'object') {
    if (prefix) out[prefix] = String(input).trim();
    return out;
  }
  if (Array.isArray(input)) {
    if (prefix) {
      out[prefix] = input
        .map((item) =>
          typeof item === 'object' ? JSON.stringify(item) : String(item),
        )
        .join(', ');
    }
    return out;
  }

  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    const cleanKey = String(k || '').trim();
    if (!cleanKey) continue;
    const nextKey = prefix ? `${prefix}.${cleanKey}` : cleanKey;
    if (v !== null && v !== undefined && typeof v === 'object' && !Array.isArray(v)) {
      flattenWebhookPayload(v, nextKey, out);
    } else if (v !== null && v !== undefined) {
      out[nextKey] = Array.isArray(v)
        ? v.map((x) => String(x ?? '').trim()).filter(Boolean).join(', ')
        : String(v).trim();
    }
  }
  return out;
}

/**
 * Normalizes Indian phone numbers (`9876543210`, `09876543210`, `+91-98765 43210`)
 * to E.164 `+91XXXXXXXXXX`. Returns `''` if invalid (<10 digits).
 */
export function normalizeUniversalPhone(raw?: string | null): string {
  const input = String(raw || '').trim();
  if (!input) return '';
  const digits = input.replace(/\D+/g, '');
  if (digits.length < 10) return '';

  if (digits.length === 10) {
    return `+91${digits}`;
  }
  if (digits.length === 11 && digits.startsWith('0')) {
    return `+91${digits.slice(1)}`;
  }
  if (digits.length === 12 && digits.startsWith('91')) {
    return `+91${digits.slice(2)}`;
  }
  return `+91${digits.slice(-10)}`;
}

/**
 * Auto-suggests CRM field mappings from flattened sample payload keys.
 */
export function autoSuggestFieldMappings(
  flattenedPayload: Record<string, unknown>,
  targetAction: UniversalWebhookAction,
): UniversalWebhookFieldMapping[] {
  const suggestions: UniversalWebhookFieldMapping[] = [];
  const assignedTargets = new Set<string>();

  for (const sourceKey of Object.keys(flattenedPayload || {})) {
    const tail = sourceKey.split('.').pop()?.toLowerCase() || sourceKey.toLowerCase();
    let targetField = '';

    if (
      /^(phone|mobile|whatsapp|contact_no|ph|phone_number|mobile_number|sender_mobile)$/.test(
        tail,
      )
    ) {
      targetField = 'phone';
    } else if (/^(full_name|name|customer_name|sender_name|buyer_name|first_name)$/.test(tail)) {
      targetField = targetAction === 'create_deal' ? 'contactName' : 'name';
    } else if (/^(email|work_email|sender_email|customer_email)$/.test(tail)) {
      targetField = targetAction === 'create_deal' ? 'contactEmail' : 'email';
    } else if (/^(city|location|sender_city|delivery_city)$/.test(tail)) {
      targetField = 'city';
    } else if (/^(company|company_name|firm|sender_co|organization)$/.test(tail)) {
      targetField = 'company';
    } else if (/^(title|deal_title|product|subject)$/.test(tail)) {
      targetField = targetAction === 'create_deal' ? 'title' : 'notes';
    } else if (/^(amount|value|budget|estimated_value|price)$/.test(tail)) {
      targetField =
        targetAction === 'create_deal'
          ? 'value'
          : targetAction === 'create_lead'
            ? 'estimatedValue'
            : '';
    } else if (/^(notes|message|requirement|query|description)$/.test(tail)) {
      targetField = 'notes';
    } else if (/^(gstin|gst)$/.test(tail) && targetAction === 'create_contact') {
      targetField = 'gstin';
    }

    if (targetField && !assignedTargets.has(targetField)) {
      assignedTargets.add(targetField);
      suggestions.push({ sourceKey, targetField });
    }
  }

  return suggestions;
}
