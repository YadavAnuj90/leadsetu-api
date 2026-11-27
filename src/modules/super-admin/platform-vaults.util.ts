import type { ConfigService } from '@nestjs/config';
import type { Connection } from 'mongoose';
import { decryptSecret } from '../auth/identity.util';
import type {
  PlatformAiProviderConfig,
  PlatformGstinProviderConfig,
} from './schemas/platform-config.schema';

export type VaultConfigSource = 'super_admin' | 'env' | 'none';

export interface EffectiveGstinProviderConfig {
  enabled: boolean;
  providerName: string;
  apiUrlTemplate: string;
  apiKey: string;
  isLiveConfigured: boolean;
  source: VaultConfigSource;
}

export interface EffectiveAiProviderConfig {
  enabled: boolean;
  openaiApiKey: string;
  geminiApiKey: string;
  claudeApiKey: string;
  whisperReady: boolean;
  anyLiveLlm: boolean;
  openaiSource: VaultConfigSource;
  geminiSource: VaultConfigSource;
  claudeSource: VaultConfigSource;
  source: VaultConfigSource;
}

export async function resolveEffectiveGstinProviderConfig(
  db: Connection | undefined | null,
  configService?: ConfigService,
): Promise<EffectiveGstinProviderConfig> {
  let dbCfg: Partial<PlatformGstinProviderConfig> | undefined;
  if (db) {
    try {
      const doc = await db
        .collection('platform_configs')
        .findOne(
          { key: 'global' },
          { projection: { gstinProvider: 1 } },
        );
      dbCfg = (doc?.gstinProvider || undefined) as
        | Partial<PlatformGstinProviderConfig>
        | undefined;
    } catch {
      dbCfg = undefined;
    }
  }

  const envUrl = (
    configService?.get<string>('GST_VERIFY_API_URL') ||
    process.env.GST_VERIFY_API_URL ||
    ''
  ).trim();
  const envKey = (
    configService?.get<string>('GST_VERIFY_API_KEY') ||
    process.env.GST_VERIFY_API_KEY ||
    ''
  ).trim();

  const enabled = dbCfg?.enabled !== false;
  const vaultUrl = enabled ? String(dbCfg?.apiUrlTemplate || '').trim() : '';
  const vaultKey = enabled
    ? decryptSecret(dbCfg?.apiKeyEncrypted || '').trim()
    : '';
  const providerName =
    String(dbCfg?.providerName || '').trim() ||
    (vaultKey || envKey ? 'External GSTN API' : 'Offline Mod-36 Checksum Guard');

  const apiUrlTemplate = vaultUrl || envUrl;
  const apiKey = vaultKey || envKey;
  const usingVault = Boolean(enabled && (vaultUrl || vaultKey));
  const usingEnv = Boolean(!usingVault && (envUrl || envKey));

  return {
    enabled,
    providerName,
    apiUrlTemplate,
    apiKey,
    isLiveConfigured: Boolean(enabled && apiUrlTemplate && apiKey),
    source: usingVault ? 'super_admin' : usingEnv ? 'env' : 'none',
  };
}

export async function resolveEffectiveAiProviderConfig(
  db: Connection | undefined | null,
  configService?: ConfigService,
): Promise<EffectiveAiProviderConfig> {
  let dbCfg: Partial<PlatformAiProviderConfig> | undefined;
  if (db) {
    try {
      const doc = await db
        .collection('platform_configs')
        .findOne(
          { key: 'global' },
          { projection: { aiProvider: 1 } },
        );
      dbCfg = (doc?.aiProvider || undefined) as
        | Partial<PlatformAiProviderConfig>
        | undefined;
    } catch {
      dbCfg = undefined;
    }
  }

  const envOpenai = (
    configService?.get<string>('OPENAI_API_KEY') ||
    process.env.OPENAI_API_KEY ||
    ''
  ).trim();
  const envGemini = (
    configService?.get<string>('GEMINI_API_KEY') ||
    process.env.GEMINI_API_KEY ||
    ''
  ).trim();
  const envClaude = (
    configService?.get<string>('CLAUDE_API_KEY') ||
    process.env.CLAUDE_API_KEY ||
    ''
  ).trim();

  const enabled = dbCfg?.enabled !== false;
  const vaultOpenai = enabled
    ? decryptSecret(dbCfg?.openaiApiKeyEncrypted || '').trim()
    : '';
  const vaultGemini = enabled
    ? decryptSecret(dbCfg?.geminiApiKeyEncrypted || '').trim()
    : '';
  const vaultClaude = enabled
    ? decryptSecret(dbCfg?.claudeApiKeyEncrypted || '').trim()
    : '';

  const openaiApiKey = vaultOpenai || envOpenai;
  const geminiApiKey = vaultGemini || envGemini;
  const claudeApiKey = vaultClaude || envClaude;

  const openaiSource: VaultConfigSource = vaultOpenai
    ? 'super_admin'
    : envOpenai
      ? 'env'
      : 'none';
  const geminiSource: VaultConfigSource = vaultGemini
    ? 'super_admin'
    : envGemini
      ? 'env'
      : 'none';
  const claudeSource: VaultConfigSource = vaultClaude
    ? 'super_admin'
    : envClaude
      ? 'env'
      : 'none';

  const anyVault = Boolean(vaultOpenai || vaultGemini || vaultClaude);
  const anyEnv = Boolean(envOpenai || envGemini || envClaude);

  return {
    enabled,
    openaiApiKey,
    geminiApiKey,
    claudeApiKey,
    whisperReady: Boolean(enabled && openaiApiKey),
    anyLiveLlm: Boolean(enabled && (openaiApiKey || geminiApiKey || claudeApiKey)),
    openaiSource,
    geminiSource,
    claudeSource,
    source: anyVault ? 'super_admin' : anyEnv ? 'env' : 'none',
  };
}
