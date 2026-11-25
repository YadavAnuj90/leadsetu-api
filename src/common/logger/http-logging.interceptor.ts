import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import type { Response } from 'express';
import { Observable, tap } from 'rxjs';
import {
  resolveOrGenerateRequestId,
  type RequestWithContext,
} from '../middleware/request-id.middleware';

@Injectable()
export class HttpLoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const httpCtx = context.switchToHttp();
    const req = httpCtx.getRequest<RequestWithContext>();
    const res = httpCtx.getResponse<Response>();

    const requestId =
      req.requestId || resolveOrGenerateRequestId(req.headers?.['x-request-id']);
    req.requestId = requestId;
    if (typeof res?.setHeader === 'function') {
      res.setHeader('X-Request-Id', requestId);
    }

    const method = req.method;
    const url = req.originalUrl || req.url;
    const startTime = Date.now();

    return next.handle().pipe(
      tap({
        next: () => {
          const durationMs = Date.now() - startTime;
          const statusCode = res.statusCode || 200;
          const tenantTag = req.user?.tenantId
            ? ` [tenant:${req.user.tenantId}]`
            : '';
          const msg = `[req:${requestId}] ${method} ${url} ${statusCode} - ${durationMs}ms${tenantTag}`;

          if (statusCode >= 500) {
            this.logger.error(msg);
          } else if (statusCode >= 400) {
            this.logger.warn(msg);
          } else {
            this.logger.log(msg);
          }
        },
        error: (err: { status?: number; getStatus?: () => number; message?: string }) => {
          const durationMs = Date.now() - startTime;
          const statusCode =
            (typeof err?.getStatus === 'function' ? err.getStatus() : err?.status) ||
            500;
          const errMsg = err?.message || 'Unhandled error';
          const msg = `[req:${requestId}] ${method} ${url} ${statusCode} - ${durationMs}ms (${errMsg})`;

          if (statusCode >= 500) {
            this.logger.error(msg);
          } else {
            this.logger.warn(msg);
          }
        },
      }),
    );
  }
}
