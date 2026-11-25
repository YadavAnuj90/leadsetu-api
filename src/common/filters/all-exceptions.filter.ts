import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  resolveOrGenerateRequestId,
  type RequestWithContext,
} from '../middleware/request-id.middleware';

/**
 * Extracts tenantId/userId from req.user or (non-authoritatively, for error telemetry only)
 * from a Bearer JWT payload when auth verification happens inside service methods.
 */
function extractDiagnosticActor(req: RequestWithContext): {
  tenantId?: string;
  userId?: string;
} {
  if (req.user?.tenantId || req.user?.userId || req.user?.sub) {
    return {
      tenantId: req.user.tenantId,
      userId: req.user.userId || req.user.sub,
    };
  }

  const authHeader = req.headers?.authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    const parts = authHeader.slice(7).trim().split('.');
    if (parts.length === 3) {
      try {
        const payload = JSON.parse(
          Buffer.from(parts[1], 'base64url').toString('utf8'),
        ) as { tenantId?: unknown; sub?: unknown; userId?: unknown };
        return {
          tenantId:
            typeof payload.tenantId === 'string' ? payload.tenantId : undefined,
          userId:
            typeof payload.sub === 'string'
              ? payload.sub
              : typeof payload.userId === 'string'
                ? payload.userId
                : undefined,
        };
      } catch {
        // Ignore malformed tokens
      }
    }
  }
  return {};
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') {
      this.logger.error(
        'Non-HTTP unhandled exception',
        exception instanceof Error ? exception.stack : String(exception),
      );
      return;
    }

    const ctx = host.switchToHttp();
    const req = ctx.getRequest<RequestWithContext>();
    const res = ctx.getResponse<Response>();

    const requestId =
      req.requestId || resolveOrGenerateRequestId(req.headers?.['x-request-id']);
    if (typeof res.setHeader === 'function') {
      res.setHeader('X-Request-Id', requestId);
    }

    const method = req.method || 'UNKNOWN';
    const path = req.originalUrl || req.url || '/';
    const { tenantId, userId } = extractDiagnosticActor(req);

    let statusCode = HttpStatus.INTERNAL_SERVER_ERROR;
    let errorLabel = 'Internal Server Error';
    let clientMessage: string | string[] = 'An unexpected internal error occurred.';

    if (exception instanceof HttpException) {
      statusCode = exception.getStatus();
      const responseBody = exception.getResponse();
      if (typeof responseBody === 'string') {
        clientMessage = responseBody;
        errorLabel = exception.name.replace(/Exception$/, '');
      } else if (responseBody && typeof responseBody === 'object') {
        const bodyObj = responseBody as Record<string, unknown>;
        if (
          typeof bodyObj.message === 'string' ||
          Array.isArray(bodyObj.message)
        ) {
          clientMessage = bodyObj.message as string | string[];
        } else {
          clientMessage = exception.message;
        }
        errorLabel =
          typeof bodyObj.error === 'string'
            ? bodyObj.error
            : exception.name.replace(/Exception$/, '');
      } else {
        clientMessage = exception.message;
      }
    } else if (exception instanceof Error) {
      // Handle MongoDB duplicate-key or validation errors gracefully without leaking internals
      const mongoCode = (exception as { code?: number }).code;
      if (mongoCode === 11000) {
        statusCode = HttpStatus.CONFLICT;
        errorLabel = 'Conflict';
        clientMessage = 'A record with the same unique key already exists.';
      }
    }

    const logMeta = {
      requestId,
      method,
      path,
      statusCode,
      tenantId: tenantId || 'anonymous',
      userId: userId || 'anonymous',
      errorName: exception instanceof Error ? exception.name : typeof exception,
    };

    if (statusCode >= 500) {
      const internalMsg =
        exception instanceof Error ? exception.message : String(exception);
      const stack = exception instanceof Error ? exception.stack : undefined;
      this.logger.error(
        `[req:${requestId}] ${method} ${path} -> ${statusCode}: ${internalMsg} ${JSON.stringify(logMeta)}`,
        stack,
      );
      // Guarantee clean generic message for 500+ responses (never expose stack or DB details)
      if (!(exception instanceof HttpException)) {
        clientMessage = 'Internal server error. Please reference X-Request-Id if reporting.';
      }
    } else {
      this.logger.warn(
        `[req:${requestId}] ${method} ${path} -> ${statusCode}: ${JSON.stringify(clientMessage)} [tenant:${logMeta.tenantId}]`,
      );
    }

    res.status(statusCode).json({
      ok: false,
      statusCode,
      error: errorLabel,
      message: clientMessage,
      requestId,
      path,
      timestamp: new Date().toISOString(),
    });
  }
}
