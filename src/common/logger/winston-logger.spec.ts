import { ExecutionContext } from '@nestjs/common';
import { of } from 'rxjs';
import {
  redactSensitiveMeta,
  createLeadsetuWinstonLogger,
} from './winston-logger.config';
import { HttpLoggingInterceptor } from './http-logging.interceptor';

describe('Winston Logger & HTTP Logging Interceptor', () => {
  it('redacts passwords, tokens, and webhook secrets recursively', () => {
    const raw = {
      tenantId: 't_123',
      email: 'owner@leadsetu.in',
      password: 'SuperSecretPassword!',
      nested: {
        accessToken: 'EAAG123456',
        secretToken: 'whsec_998877',
        encryptedPageAccessToken: 'deadbeef',
        safeField: 'Noida',
      },
      headers: {
        authorization: 'Bearer eyJhbGci...',
        'x-razorpay-signature': 'sig_123',
      },
    };

    const sanitized = redactSensitiveMeta(raw) as Record<string, any>;
    expect(sanitized.tenantId).toBe('t_123');
    expect(sanitized.email).toBe('owner@leadsetu.in');
    expect(sanitized.password).toBe('[REDACTED]');
    expect(sanitized.nested.accessToken).toBe('[REDACTED]');
    expect(sanitized.nested.secretToken).toBe('[REDACTED]');
    expect(sanitized.nested.encryptedPageAccessToken).toBe('[REDACTED]');
    expect(sanitized.nested.safeField).toBe('Noida');
    expect(sanitized.headers.authorization).toBe('[REDACTED]');
    expect(sanitized.headers['x-razorpay-signature']).toBe('[REDACTED]');
  });

  it('creates a NestJS LoggerService backed by Winston', () => {
    const logger = createLeadsetuWinstonLogger();
    expect(logger).toBeDefined();
    expect(typeof logger.log).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.warn).toBe('function');

    expect(() =>
      logger.log('Winston logger initialized for unit test', 'WinstonTest'),
    ).not.toThrow();
  });

  it('logs HTTP request method, URL, status code, duration, and tenantId via HttpLoggingInterceptor', (done) => {
    const interceptor = new HttpLoggingInterceptor();
    const logSpy = jest
      .spyOn((interceptor as any).logger, 'log')
      .mockImplementation(() => {});

    const mockContext = {
      getType: () => 'http',
      switchToHttp: () => ({
        getRequest: () => ({
          method: 'POST',
          originalUrl: '/v1/leads',
          requestId: 'req-abc12345',
          headers: {},
          user: { tenantId: '65f1a2b3c4d5e6f7a8b9c0d1' },
        }),
        getResponse: () => ({
          statusCode: 201,
          setHeader: jest.fn(),
        }),
      }),
    } as unknown as ExecutionContext;

    const next = {
      handle: () => of({ ok: true }),
    };

    interceptor.intercept(mockContext, next).subscribe({
      complete: () => {
        expect(logSpy).toHaveBeenCalledWith(
          expect.stringMatching(
            /^\[req:req-abc12345\] POST \/v1\/leads 201 - \d+ms \[tenant:65f1a2b3c4d5e6f7a8b9c0d1\]$/,
          ),
        );
        done();
      },
    });
  });
});
