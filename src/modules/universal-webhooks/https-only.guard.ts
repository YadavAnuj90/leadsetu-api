import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';

@Injectable()
export class HttpsOnlyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const protocol = String(req?.protocol || '').toLowerCase();
    const forwardedProto = String(
      req?.headers?.['x-forwarded-proto'] || '',
    ).toLowerCase();

    if (protocol === 'https' || forwardedProto.includes('https')) {
      return true;
    }

    const nodeEnv = String(process.env.NODE_ENV || '').toLowerCase();
    const hostHeader = String(
      req?.headers?.host || req?.hostname || '',
    ).toLowerCase();
    const hostOnly = hostHeader.split(':')[0];

    if (
      nodeEnv === 'development' &&
      (hostOnly === 'localhost' || hostOnly === '127.0.0.1')
    ) {
      return true;
    }

    throw new ForbiddenException('HTTPS is required for webhook endpoints');
  }
}
