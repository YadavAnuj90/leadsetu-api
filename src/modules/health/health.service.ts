import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';

export interface HealthReport {
  status: 'ok' | 'degraded';
  service: string;
  version: string;
  environment: string;
  timestamp: string;
  uptimeSeconds: number;
  checks: {
    mongodb: {
      status: 'up' | 'down';
      readyState: number;
      pingMs: number | null;
      error?: string;
    };
    memory: {
      rssMb: number;
      heapUsedMb: number;
      heapTotalMb: number;
    };
    readiness: {
      aiBridge: boolean;
      razorpayEnvConfigured: boolean;
      metaLeadsConfigured: boolean;
      universalWebhooksEncryptionReady: boolean;
    };
  };
}

@Injectable()
export class HealthService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    private readonly configService: ConfigService,
  ) {}

  async checkHealth(): Promise<HealthReport> {
    const startPing = Date.now();
    let dbUp = false;
    let pingMs: number | null = null;
    let dbError: string | undefined;

    try {
      if (this.connection?.readyState === 1 && this.connection?.db) {
        await this.connection.db.admin().ping();
        dbUp = true;
        pingMs = Date.now() - startPing;
      } else {
        dbError = `Mongoose readyState=${this.connection?.readyState ?? -1}`;
      }
    } catch (err) {
      dbError = err instanceof Error ? err.message : 'MongoDB ping failed';
    }

    const mem = process.memoryUsage();
    const toMb = (bytes: number) => Math.round((bytes / (1024 * 1024)) * 10) / 10;

    const aiBridgeUrl = (
      this.configService.get<string>('AI_BRIDGE_URL') ||
      this.configService.get<string>('GEMINI_API_KEY') ||
      ''
    ).trim();
    const razorpayKeyId = (
      this.configService.get<string>('RAZORPAY_KEY_ID') || ''
    ).trim();
    const metaAppId = (
      this.configService.get<string>('META_APP_ID') || ''
    ).trim();
    const webhookEncKey = (
      this.configService.get<string>('META_TOKEN_ENCRYPTION_KEY') ||
      this.configService.get<string>('JWT_SECRET') ||
      ''
    ).trim();

    return {
      status: dbUp ? 'ok' : 'degraded',
      service: 'leadsetu-api',
      version: process.env.npm_package_version || '0.1.0',
      environment: process.env.NODE_ENV || 'development',
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      checks: {
        mongodb: {
          status: dbUp ? 'up' : 'down',
          readyState: this.connection?.readyState ?? 0,
          pingMs,
          ...(dbError ? { error: dbError } : {}),
        },
        memory: {
          rssMb: toMb(mem.rss),
          heapUsedMb: toMb(mem.heapUsed),
          heapTotalMb: toMb(mem.heapTotal),
        },
        readiness: {
          aiBridge: Boolean(aiBridgeUrl),
          razorpayEnvConfigured: Boolean(razorpayKeyId),
          metaLeadsConfigured: Boolean(metaAppId),
          universalWebhooksEncryptionReady: Boolean(webhookEncKey),
        },
      },
    };
  }
}
