import { HealthService } from './health.service';

describe('HealthService (/v1/health)', () => {
  it('returns status "ok" with MongoDB pingMs and memory/readiness checks when connected', async () => {
    const mockConn: any = {
      readyState: 1,
      db: {
        admin: () => ({
          ping: jest.fn().mockResolvedValue({ ok: 1 }),
        }),
      },
    };
    const mockConfig: any = {
      get: jest.fn((key: string) => {
        if (key === 'AI_BRIDGE_URL') return 'http://localhost:3002';
        if (key === 'RAZORPAY_KEY_ID') return 'rzp_test_123';
        if (key === 'JWT_SECRET') return 'secret_abc';
        return '';
      }),
    };

    const service = new HealthService(mockConn, mockConfig);
    const report = await service.checkHealth();

    expect(report.status).toBe('ok');
    expect(report.checks.mongodb.status).toBe('up');
    expect(typeof report.checks.mongodb.pingMs).toBe('number');
    expect(report.checks.memory.rssMb).toBeGreaterThan(0);
    expect(report.checks.readiness.aiBridge).toBe(true);
    expect(report.checks.readiness.razorpayEnvConfigured).toBe(true);
    expect(report.checks.readiness.universalWebhooksEncryptionReady).toBe(true);
  });

  it('returns status "degraded" when MongoDB is disconnected', async () => {
    const mockConn: any = {
      readyState: 0,
      db: null,
    };
    const mockConfig: any = {
      get: jest.fn().mockReturnValue(''),
    };

    const service = new HealthService(mockConn, mockConfig);
    const report = await service.checkHealth();

    expect(report.status).toBe('degraded');
    expect(report.checks.mongodb.status).toBe('down');
    expect(report.checks.mongodb.pingMs).toBeNull();
  });
});
