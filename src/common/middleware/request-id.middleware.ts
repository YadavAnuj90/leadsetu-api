import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { NextFunction, Request, Response } from 'express';

export interface RequestWithContext extends Request {
  requestId?: string;
  user?: {
    sub?: string;
    userId?: string;
    tenantId?: string;
    email?: string;
    role?: string;
  };
}

const VALID_REQUEST_ID_REGEX = /^[a-zA-Z0-9._-]{8,64}$/;

export function resolveOrGenerateRequestId(headerValue?: string | string[]): string {
  const candidate = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  const trimmed = typeof candidate === 'string' ? candidate.trim() : '';
  if (trimmed && VALID_REQUEST_ID_REGEX.test(trimmed)) {
    return trimmed;
  }
  return randomUUID();
}

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: RequestWithContext, res: Response, next: NextFunction): void {
    const requestId = resolveOrGenerateRequestId(req.headers['x-request-id']);
    req.requestId = requestId;
    req.headers['x-request-id'] = requestId;
    res.setHeader('X-Request-Id', requestId);
    next();
  }
}
