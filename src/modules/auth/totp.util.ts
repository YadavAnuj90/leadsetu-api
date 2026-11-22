import { createHmac, randomBytes } from 'crypto';
import * as QRCode from 'qrcode';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function generateBase32Secret(byteLength = 20): string {
  const bytes = randomBytes(byteLength);
  let bits = 0;
  let value = 0;
  let output = '';

  for (let i = 0; i < bytes.length; i += 1) {
    value = (value << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

function decodeBase32(secret: string): Buffer {
  const cleaned = secret.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];

  for (let i = 0; i < cleaned.length; i += 1) {
    const idx = BASE32_ALPHABET.indexOf(cleaned[i]);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpToken(
  base32Secret: string,
  timeStepOffset = 0,
  stepSeconds = 30,
  digits = 6,
): string {
  const key = decodeBase32(base32Secret);
  const counter = Math.floor(Date.now() / 1000 / stepSeconds) + timeStepOffset;
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  counterBuf.writeUInt32BE(counter >>> 0, 4);

  const hmac = createHmac('sha1', key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  const otp = binary % 10 ** digits;
  return String(otp).padStart(digits, '0');
}

export function verifyTotpCode(
  base32Secret: string,
  candidateCode?: string,
  windowSteps = 1,
): boolean {
  const clean = String(candidateCode || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(clean) || !base32Secret) return false;

  for (let offset = -windowSteps; offset <= windowSteps; offset += 1) {
    if (generateTotpToken(base32Secret, offset) === clean) {
      return true;
    }
  }
  return false;
}

export function buildOtpAuthUri(params: {
  secret: string;
  accountEmail: string;
  issuer?: string;
}): string {
  const issuer = params.issuer || 'Leadsetu CRM';
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(params.accountEmail)}`;
  return `otpauth://totp/${label}?secret=${encodeURIComponent(params.secret)}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

export async function generateTotpQrDataUrl(otpAuthUri: string): Promise<string> {
  return QRCode.toDataURL(otpAuthUri, {
    width: 220,
    margin: 1,
    color: {
      dark: '#0F172A',
      light: '#FFFFFF',
    },
  });
}

export function generateBackupRecoveryCodes(count = 8): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const raw = randomBytes(4).toString('hex').toUpperCase();
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4)}`);
  }
  return codes;
}
