import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectConnection } from '@nestjs/mongoose';
import type { Request } from 'express';
import { Connection, Types } from 'mongoose';

const ALLOWLIST_PREFIXES = [
  '/v1/auth',
  '/v1/billing',
  '/v1/health',
  '/v1/super-admin',
  '/v1/portal',
  '/v1/leads/webhook',
  '/v1/webhooks',
  '/v1/calls/public',
  '/v1/marketplace-sync/public',
  '/v1/public/booking',
  '/v1/public/forms',
  '/v1/analytics/notifications',
  '/v1/platform-tickets',
  '/docs',
  '/v1/docs',
];

/**
 * Global SaaS subscription enforcement guard:
 * When a tenant's plan expires (`trialEndsAt < now` or `status === 'suspended'`),
 * accounts and data remain completely intact, `/v1/billing` and `/v1/auth` stay open,
 * and all manual & AI workspace feature routes return 402 PLAN_EXPIRED for Admin, Manager & Team users.
 */
@Injectable()
export class PlanExpiryGuard implements CanActivate {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') {
      return true;
    }

    const req = context.switchToHttp().getRequest<Request>();
    const url = String(req.originalUrl || req.url || '').split('?')[0];

    if (ALLOWLIST_PREFIXES.some((prefix) => url.startsWith(prefix))) {
      return true;
    }

    const authHeader = req.headers?.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return true;
    }

    const token = authHeader.slice(7).trim();
    if (!token) return true;

    const secret =
      this.configService.get<string>('JWT_SECRET') ||
      'leadsetu_super_secret_access_key_2026';

    let payload: { tenantId?: string; role?: string } | null = null;
    try {
      payload = await this.jwtService.verifyAsync<{
        tenantId?: string;
        role?: string;
      }>(token, { secret });
    } catch {
      // Let route-level auth verifier raise 401 cleanly
      return true;
    }

    if (!payload || payload.role === 'super_admin') {
      return true;
    }

    const tenantId = String(payload.tenantId || '').trim();
    if (!tenantId || !Types.ObjectId.isValid(tenantId) || !this.connection.db) {
      return true;
    }

    const tenant = await this.connection.db
      .collection('tenants')
      .findOne(
        { _id: new Types.ObjectId(tenantId) },
        { projection: { isPlatformHq: 1, status: 1, trialEndsAt: 1, plan: 1 } },
      )
      .catch(() => null);

    if (!tenant || tenant.isPlatformHq) {
      return true;
    }

    const trialEndsAt = String(tenant.trialEndsAt || '').trim();
    const expiresMs = trialEndsAt ? Date.parse(trialEndsAt) : NaN;
    const isExpiredByDate =
      Boolean(trialEndsAt) && Number.isFinite(expiresMs) && Date.now() > expiresMs;

    if (tenant.status === 'suspended' || isExpiredByDate) {
      throw new HttpException(
        {
          statusCode: HttpStatus.PAYMENT_REQUIRED,
          error: 'Payment Required',
          code: 'PLAN_EXPIRED',
          expiredAt: trialEndsAt || null,
          plan: tenant.plan || 'growth',
          message:
            'Your workspace subscription plan has expired. Your data is safe, but all manual and AI features are paused until your Workspace Admin renews the plan in Billing.',
        },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }

    return true;
  }
}
