import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import * as winston from 'winston';
import { WinstonModule, type WinstonModuleOptions } from 'nest-winston';

const SENSITIVE_KEY_REGEX =
  /^(password|pass|token|accesstoken|refreshtoken|secrettoken|authorization|x-webhook-secret|x-razorpay-signature|x-hub-signature-256|keysecret|encryptedsecret|encryptedpageaccesstoken|otp|totpsecret)$/i;

/**
 * Recursively masks sensitive credentials, tokens, and secrets before writing to logs.
 */
export function redactSensitiveMeta(input: unknown, depth = 0): unknown {
  if (depth > 4 || input === null || input === undefined) return input;
  if (Array.isArray(input)) {
    return input.map((item) => redactSensitiveMeta(item, depth + 1));
  }
  if (typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (SENSITIVE_KEY_REGEX.test(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = redactSensitiveMeta(v, depth + 1);
      }
    }
    return out;
  }
  return input;
}

const redactFormat = winston.format((info) => {
  const cleaned = redactSensitiveMeta(info) as winston.Logform.TransformableInfo;
  return { ...info, ...cleaned };
});

export function createLeadsetuWinstonOptions(): WinstonModuleOptions {
  const env = process.env.NODE_ENV || 'development';
  const isProd = env === 'production';
  const isTest = env === 'test';
  const logLevel = process.env.LOG_LEVEL || (isProd ? 'info' : 'debug');

  const consoleFormat = isProd
    ? winston.format.combine(
        winston.format.timestamp(),
        redactFormat(),
        winston.format.errors({ stack: true }),
        winston.format.json(),
      )
    : winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        redactFormat(),
        winston.format.errors({ stack: true }),
        winston.format.colorize({ all: true }),
        winston.format.printf(
          ({ timestamp, level, message, context, stack, ...meta }) => {
            const ctxLabel = context ? `[${String(context)}]` : '[Leadsetu]';
            const metaKeys = Object.keys(meta).filter(
              (k) => k !== 'service' && meta[k] !== undefined,
            );
            const metaStr =
              metaKeys.length > 0
                ? ` ${JSON.stringify(
                    Object.fromEntries(metaKeys.map((k) => [k, meta[k]])),
                  )}`
                : '';
            const stackStr = stack ? `\n${String(stack)}` : '';
            return `${String(timestamp)} ${String(level)} ${ctxLabel} ${String(message)}${metaStr}${stackStr}`;
          },
        ),
      );

  const transports: winston.transport[] = [
    new winston.transports.Console({
      level: logLevel,
      silent: isTest && process.env.ENABLE_TEST_LOGS !== 'true',
      format: consoleFormat,
    }),
  ];

  if (!isTest) {
    const logsDir = process.env.LOG_DIR || join(process.cwd(), 'logs');
    try {
      if (!existsSync(logsDir)) {
        mkdirSync(logsDir, { recursive: true });
      }
      const fileFormat = winston.format.combine(
        winston.format.timestamp(),
        redactFormat(),
        winston.format.errors({ stack: true }),
        winston.format.json(),
      );

      transports.push(
        new winston.transports.File({
          filename: join(logsDir, 'error.log'),
          level: 'error',
          maxsize: 10 * 1024 * 1024, // 10 MB rotation
          maxFiles: 5,
          tailable: true,
          format: fileFormat,
        }),
        new winston.transports.File({
          filename: join(logsDir, 'combined.log'),
          level: logLevel,
          maxsize: 10 * 1024 * 1024, // 10 MB rotation
          maxFiles: 5,
          tailable: true,
          format: fileFormat,
        }),
      );
    } catch {
      // Fallback to console-only if filesystem is read-only
    }
  }

  return {
    level: logLevel,
    defaultMeta: { service: 'leadsetu-api' },
    transports,
  };
}

export function createLeadsetuWinstonLogger() {
  return WinstonModule.createLogger(createLeadsetuWinstonOptions());
}
