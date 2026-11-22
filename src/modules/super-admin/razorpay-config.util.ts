import type { ConfigService } from '@nestjs/config';
import type { Connection } from 'mongoose';
import { decryptSecret } from '../auth/identity.util';
import type { PlatformRazorpayGatewayConfig } from './schemas/platform-config.schema';

export type RazorpayMode = 'test' | 'live' | 'unconfigured';
export type RazorpayConfigSource = 'super_admin' | 'env' | 'none';

export interface EffectiveRazorpayConfig {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
  signingSecret: string;
  apiBase: string;
  enabled: boolean;
  isLiveConfigured: boolean;
  mode: RazorpayMode;
  source: RazorpayConfigSource;
}

export function detectRazorpayMode(keyId?: string | null): RazorpayMode {
  const clean = String(keyId || '').trim();
  if (!clean || clean === 'rzp_test_leadsetu_sandbox') return 'unconfigured';
  if (clean.startsWith('rzp_live_')) return 'live';
  if (clean.startsWith('rzp_test_')) return 'test';
  return 'test';
}

/**
 * Resolves central Razorpay credentials with Super Admin encrypted config overriding `.env`.
 */
export async function resolveEffectiveRazorpayConfig(
  db: Connection | undefined | null,
  configService?: ConfigService,
): Promise<EffectiveRazorpayConfig> {
  let dbGw: Partial<PlatformRazorpayGatewayConfig> | undefined;
  if (db) {
    try {
      const doc = await db
        .collection('platform_configs')
        .findOne(
          { key: 'global' },
          { projection: { razorpayGateway: 1 } },
        );
      dbGw = (doc?.razorpayGateway || undefined) as
        | Partial<PlatformRazorpayGatewayConfig>
        | undefined;
    } catch {
      dbGw = undefined;
    }
  }

  const envKeyId = (
    configService?.get<string>('RAZORPAY_KEY_ID') ||
    process.env.RAZORPAY_KEY_ID ||
    ''
  ).trim();
  const envKeySecret = (
    configService?.get<string>('RAZORPAY_KEY_SECRET') ||
    process.env.RAZORPAY_KEY_SECRET ||
    ''
  ).trim();
  const envWebhookSecret = (
    configService?.get<string>('RAZORPAY_WEBHOOK_SECRET') ||
    process.env.RAZORPAY_WEBHOOK_SECRET ||
    ''
  ).trim();
  const apiBase = (
    configService?.get<string>('RAZORPAY_API_BASE') ||
    process.env.RAZORPAY_API_BASE ||
    'https://api.razorpay.com/v1'
  )
    .trim()
    .replace(/\/+$/, '');

  const vaultEnabled = dbGw?.enabled !== false;
  const vaultKeyId = vaultEnabled
    ? decryptSecret(dbGw?.keyIdEncrypted || '').trim()
    : '';
  const vaultKeySecret = vaultEnabled
    ? decryptSecret(dbGw?.keySecretEncrypted || '').trim()
    : '';
  const vaultWebhookSecret = vaultEnabled
    ? decryptSecret(dbGw?.webhookSecretEncrypted || '').trim()
    : '';

  const effectiveKeyId = vaultKeyId || envKeyId;
  const effectiveKeySecret = vaultKeySecret || envKeySecret;
  const effectiveWebhookSecret =
    vaultWebhookSecret ||
    envWebhookSecret ||
    effectiveKeySecret ||
    'leadsetu_razorpay_default_secret_2026';
  const signingSecret =
    effectiveKeySecret || 'leadsetu_razorpay_default_secret_2026';

  const usingSuperAdmin = Boolean(
    vaultEnabled && (vaultKeyId || vaultKeySecret || vaultWebhookSecret),
  );
  const usingEnv = Boolean(!usingSuperAdmin && (envKeyId || envKeySecret || envWebhookSecret));

  const isLiveConfigured = Boolean(effectiveKeyId && effectiveKeySecret);
  const mode = isLiveConfigured
    ? detectRazorpayMode(effectiveKeyId)
    : 'unconfigured';

  return {
    keyId: effectiveKeyId || 'rzp_test_leadsetu_sandbox',
    keySecret: effectiveKeySecret,
    webhookSecret: effectiveWebhookSecret,
    signingSecret,
    apiBase,
    enabled: vaultEnabled,
    isLiveConfigured,
    mode,
    source: usingSuperAdmin ? 'super_admin' : usingEnv ? 'env' : 'none',
  };
}
