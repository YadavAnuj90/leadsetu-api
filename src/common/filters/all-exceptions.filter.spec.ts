import { ArgumentsHost, BadRequestException } from '@nestjs/common';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { RequestIdMiddleware } from '../middleware/request-id.middleware';

describe('RequestIdMiddleware & AllExceptionsFilter', () => {
  it('generates and attaches X-Request-Id header when missing or reuses valid incoming X-Request-Id', () => {
    const middleware = new RequestIdMiddleware();
    const next = jest.fn();

    const req1: any = { headers: {} };
    const res1: any = { setHeader: jest.fn() };
    middleware.use(req1, res1, next);
    expect(req1.requestId).toBeDefined();
    expect(res1.setHeader).toHaveBeenCalledWith('X-Request-Id', req1.requestId);
    expect(next).toHaveBeenCalledTimes(1);

    const req2: any = { headers: { 'x-request-id': 'trace_987654321' } };
    const res2: any = { setHeader: jest.fn() };
    middleware.use(req2, res2, next);
    expect(req2.requestId).toBe('trace_987654321');
    expect(res2.setHeader).toHaveBeenCalledWith('X-Request-Id', 'trace_987654321');
  });

  it('logs full stack trace + tenant context on unhandled 500 error without leaking stack trace to client', () => {
    const filter = new AllExceptionsFilter();
    const errorSpy = jest
      .spyOn((filter as any).logger, 'error')
      .mockImplementation(() => {});

    const statusMock = jest.fn().mockReturnThis();
    const jsonMock = jest.fn();
    const setHeaderMock = jest.fn();

    const fakeJwtPayload = Buffer.from(
      JSON.stringify({ tenantId: 'tenant_999', sub: 'user_888' }),
    ).toString('base64url');

    const host = {
      getType: () => 'http',
      switchToHttp: () => ({
        getRequest: () => ({
          method: 'POST',
          originalUrl: '/v1/invoices',
          requestId: 'req-crash-500',
          headers: { authorization: `Bearer hdr.${fakeJwtPayload}.sig` },
        }),
        getResponse: () => ({
          setHeader: setHeaderMock,
          status: statusMock,
          json: jsonMock,
        }),
      }),
    } as unknown as ArgumentsHost;

    const dbCrash = new Error('MongoNetworkError: sensitive internal URI mongodb://admin:pw@db');
    filter.catch(dbCrash, host);

    expect(setHeaderMock).toHaveBeenCalledWith('X-Request-Id', 'req-crash-500');
    expect(statusMock).toHaveBeenCalledWith(500);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('"tenantId":"tenant_999"'),
      expect.stringContaining('MongoNetworkError'),
    );

    const clientBody = jsonMock.mock.calls[0][0];
    expect(clientBody).toEqual(
      expect.objectContaining({
        ok: false,
        statusCode: 500,
        requestId: 'req-crash-500',
        path: '/v1/invoices',
      }),
    );
    expect(JSON.stringify(clientBody)).not.toContain('mongodb://admin:pw');
    expect(clientBody.stack).toBeUndefined();
  });

  it('formats 4xx HttpException cleanly and logs warning', () => {
    const filter = new AllExceptionsFilter();
    const warnSpy = jest
      .spyOn((filter as any).logger, 'warn')
      .mockImplementation(() => {});

    const statusMock = jest.fn().mockReturnThis();
    const jsonMock = jest.fn();

    const host = {
      getType: () => 'http',
      switchToHttp: () => ({
        getRequest: () => ({
          method: 'GET',
          originalUrl: '/v1/leads/bad-id',
          requestId: 'req-bad-400',
          headers: {},
        }),
        getResponse: () => ({
          setHeader: jest.fn(),
          status: statusMock,
          json: jsonMock,
        }),
      }),
    } as unknown as ArgumentsHost;

    filter.catch(new BadRequestException('Invalid lead ID format'), host);

    expect(statusMock).toHaveBeenCalledWith(400);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        statusCode: 400,
        message: 'Invalid lead ID format',
        requestId: 'req-bad-400',
      }),
    );
  });
});
