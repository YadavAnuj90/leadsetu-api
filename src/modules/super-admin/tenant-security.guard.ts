import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { Model, Types } from 'mongoose';
import { Tenant, TenantDocument } from '../auth/schemas/tenant.schema';
import { User, UserDocument } from '../auth/schemas/user.schema';

export function extractClientIp(req: Request): string {
  const fwd = req.headers['x-forwarded-for'];
  let ip = '';
  if (typeof fwd === 'string' && fwd.trim()) {
    ip = fwd.split(',')[0].trim();
  } else {
    ip = req.ip || req.socket?.remoteAddress || '';
  }
  if (ip.startsWith('::ffff:')) {
    ip = ip.slice(7);
  }
  if (ip === '::1') {
    return '127.0.0.1';
  }
  return ip;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let out = 0;
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    const n = Number(p);
    if (n < 0 || n > 255) return null;
    out = (out << 8) | n;
  }
  return out >>> 0;
}

export function isIpAllowed(clientIp: string, allowlist?: string[]): boolean {
  const list = (allowlist || []).map((s) => s.trim()).filter(Boolean);
  if (list.length === 0) return true;

  const normalized = clientIp.startsWith('::ffff:')
    ? clientIp.slice(7)
    : clientIp === '::1'
      ? '127.0.0.1'
      : clientIp;

  for (const rawEntry of list) {
    const entry =
      rawEntry === '::1'
        ? '127.0.0.1'
        : rawEntry.startsWith('::ffff:')
          ? rawEntry.slice(7)
          : rawEntry;

    if (entry === '*' || entry === normalized) return true;

    // Prefix wildcard e.g. 103.21.44.*
    if (entry.endsWith('.*')) {
      const prefix = entry.slice(0, -1);
      if (normalized.startsWith(prefix)) return true;
    }

    // IPv4 CIDR e.g. 103.21.44.0/24
    if (entry.includes('/')) {
      const [baseIp, bitsStr] = entry.split('/');
      const bits = Number(bitsStr);
      const baseInt = ipv4ToInt(baseIp);
      const clientInt = ipv4ToInt(normalized);
      if (
        baseInt !== null &&
        clientInt !== null &&
        Number.isInteger(bits) &&
        bits >= 0 &&
        bits <= 32
      ) {
        const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
        if ((baseInt & mask) === (clientInt & mask)) {
          return true;
        }
      }
    }
  }

  return false;
}

@Injectable()
export class TenantSecurityGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(Tenant.name) private readonly tenantModel: Model<TenantDocument>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const req = context.switchToHttp().getRequest<Request>();
    const path = (req.originalUrl || req.url || '').split('?')[0];

    // Skip auth public endpoints, super-admin vault routes, webhooks, and Swagger
    if (
      path.includes('/super-admin') ||
      path.includes('/auth/login') ||
      path.includes('/auth/register') ||
      path.includes('/auth/signup') ||
      path.includes('/auth/refresh') ||
      path.includes('/auth/logout') ||
      path.includes('/webhooks/') ||
      path.includes('/docs')
    ) {
      return true;
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return true;
    }

    const token = authHeader.slice(7).trim();
    const secret =
      this.configService.get<string>('JWT_SECRET') ||
      'leadsetu_super_secret_access_key_2026_delhi_ncr';

    let payload: {
      sub?: string;
      tenantId?: string;
      role?: string;
      sv?: number;
      tsv?: number;
      isImpersonation?: boolean;
    };
    try {
      payload = await this.jwtService.verifyAsync(token, { secret });
    } catch {
      return true;
    }

    if (payload.role === 'super_admin' || payload.isImpersonation) {
      return true;
    }

    if (!payload.sub || !Types.ObjectId.isValid(payload.sub)) {
      return true;
    }

    const [user, tenant] = await Promise.all([
      this.userModel
        .findById(payload.sub)
        .select('isActive sessionVersion role')
        .lean()
        .exec(),
      payload.tenantId && Types.ObjectId.isValid(payload.tenantId)
        ? this.tenantModel
            .findById(payload.tenantId)
            .select('status sessionVersion securityPolicy dpdpRetention')
            .lean()
            .exec()
        : Promise.resolve(null),
    ]);

    if (!user || !user.isActive) {
      throw new UnauthorizedException('User account is deactivated or missing.');
    }

    if ((payload.sv ?? 1) < (user.sessionVersion ?? 1)) {
      throw new UnauthorizedException({
        statusCode: 401,
        error: 'Unauthorized',
        code: 'SESSION_REVOKED',
        message:
          'Your session was force-revoked by Leadsetu Security Authority. Please sign in again.',
      });
    }

    if (tenant) {
      if (tenant.dpdpRetention?.purgedAt || tenant.dpdpRetention?.softDeletedAt) {
        throw new ForbiddenException(
          'This workspace is deactivated under DPDP retention/erasure policy.',
        );
      }
      if (tenant.status === 'suspended') {
        throw new ForbiddenException(
          'This workspace has been suspended by Leadsetu HQ.',
        );
      }
      if ((payload.tsv ?? 1) < (tenant.sessionVersion ?? 1)) {
        throw new UnauthorizedException({
          statusCode: 401,
          error: 'Unauthorized',
          code: 'TENANT_SESSIONS_REVOKED',
          message:
            'All workspace sessions were revoked by Security Admin. Please sign in again.',
        });
      }

      const clientIp = extractClientIp(req);
      if (!isIpAllowed(clientIp, tenant.securityPolicy?.ipAllowlist)) {
        throw new ForbiddenException({
          statusCode: 403,
          error: 'Forbidden',
          code: 'IP_NOT_ALLOWLISTED',
          message: `Access denied: Your IP (${clientIp}) is outside the workspace IP allowlist enforced by Leadsetu HQ.`,
        });
      }
    }

    return true;
  }
}
