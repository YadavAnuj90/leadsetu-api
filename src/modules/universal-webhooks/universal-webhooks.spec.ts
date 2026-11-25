import {
  ExecutionContext,
  ForbiddenException,
  MethodNotAllowedException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import { HttpsOnlyGuard } from './https-only.guard';
import {
  flattenWebhookPayload,
  normalizeUniversalPhone,
  encryptWebhookSecret,
  decryptWebhookSecret,
} from './universal-webhooks.util';
import { UniversalWebhooksService } from './universal-webhooks.service';
import { UniversalWebhookProcessor } from './universal-webhook.processor';

describe('UniversalWebhooksModule Unit & Integration Suite', () => {
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
    jest.clearAllMocks();
  });

  // 1. HTTPS-Only Guard Tests
  describe('HttpsOnlyGuard', () => {
    const guard = new HttpsOnlyGuard();

    const makeMockContext = (reqOverrides: Record<string, any>): ExecutionContext =>
      ({
        switchToHttp: () => ({
          getRequest: () => ({
            protocol: 'http',
            secure: false,
            headers: {},
            hostname: 'crm.leadsetu.in',
            ...reqOverrides,
          }),
        }),
      }) as unknown as ExecutionContext;

    it('rejects plain HTTP requests in production with 403 Forbidden', () => {
      process.env.NODE_ENV = 'production';
      const ctx = makeMockContext({
        protocol: 'http',
        headers: { host: 'api.leadsetu.in' },
      });

      expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
      expect(() => guard.canActivate(ctx)).toThrow(
        'HTTPS is required for webhook endpoints',
      );
    });

    it('allows direct HTTPS requests (req.protocol === "https") in production', () => {
      process.env.NODE_ENV = 'production';
      const ctx = makeMockContext({
        protocol: 'https',
        secure: true,
        headers: { host: 'api.leadsetu.in' },
      });

      expect(guard.canActivate(ctx)).toBe(true);
    });

    it('allows proxy-terminated HTTPS requests via x-forwarded-proto header', () => {
      process.env.NODE_ENV = 'production';
      const ctx = makeMockContext({
        protocol: 'http',
        headers: {
          host: 'api.leadsetu.in',
          'x-forwarded-proto': 'https, http',
        },
      });

      expect(guard.canActivate(ctx)).toBe(true);
    });

    it('allows plain HTTP on localhost only when NODE_ENV === "development"', () => {
      process.env.NODE_ENV = 'development';
      const localhostCtx = makeMockContext({
        protocol: 'http',
        hostname: 'localhost',
        headers: { host: 'localhost:4000' },
      });
      expect(guard.canActivate(localhostCtx)).toBe(true);

      const nonLocalDevCtx = makeMockContext({
        protocol: 'http',
        hostname: '192.168.1.50',
        headers: { host: '192.168.1.50:4000' },
      });
      expect(() => guard.canActivate(nonLocalDevCtx)).toThrow(ForbiddenException);
    });
  });

  // 2. Nested Payload Flattening & Indian Phone Normalization
  describe('Payload Flattening & Phone Normalization Utilities', () => {
    it('flattens nested JSON objects into dot-notation keys', () => {
      const raw = {
        event: 'order.created',
        customer: {
          mobile: '09876543210',
          profile: {
            fullName: 'Vikramaditya Rao',
            city: 'Pune',
          },
        },
        tags: ['industrial', 'urgent'],
      };

      const flat = flattenWebhookPayload(raw);
      expect(flat).toEqual({
        event: 'order.created',
        'customer.mobile': '09876543210',
        'customer.profile.fullName': 'Vikramaditya Rao',
        'customer.profile.city': 'Pune',
        tags: 'industrial, urgent',
      });
    });

    it('normalizes 10-digit, 0-prefixed, and +91-formatted Indian phone numbers to +91XXXXXXXXXX', () => {
      expect(normalizeUniversalPhone('9876543210')).toBe('+919876543210');
      expect(normalizeUniversalPhone('09876543210')).toBe('+919876543210');
      expect(normalizeUniversalPhone('919876543210')).toBe('+919876543210');
      expect(normalizeUniversalPhone('+91-98765 43210')).toBe('+919876543210');
      expect(normalizeUniversalPhone('(+91) 98765-43210')).toBe('+919876543210');
      expect(normalizeUniversalPhone('12345')).toBe('');
      expect(normalizeUniversalPhone('')).toBe('');
    });

    it('encrypts and decrypts webhook secret tokens via AES-256-GCM', () => {
      const secret = 'whsec_test_998877665544332211';
      const encrypted = encryptWebhookSecret(secret);
      expect(encrypted.encryptedSecretToken).toBeDefined();
      const roundtrip = decryptWebhookSecret({
        encryptedSecretToken: encrypted.encryptedSecretToken,
        tokenIv: encrypted.tokenIv,
        tokenAuthTag: encrypted.tokenAuthTag,
      });
      expect(roundtrip).toBe(secret);
    });
  });

  // 3. Method Enforcement (GET vs POST -> 405 Method Not Allowed) & Sample Capture
  describe('UniversalWebhooksService.handleIncomingWebhook', () => {
    const secretToken = 'whsec_valid_secret_12345';
    const encrypted = encryptWebhookSecret(secretToken);
    const tenantId = new Types.ObjectId();

    const makeWebhookDoc = (overrides: Record<string, any> = {}) => ({
      _id: new Types.ObjectId(),
      tenantId,
      name: 'Website Form Webhook',
      webhookId: 'wh_test_001',
      ...encrypted,
      allowedMethod: 'POST',
      targetAction: 'create_lead',
      status: 'active',
      duplicateStrategy: 'fill_empty',
      fieldMappings: [
        { sourceKey: 'customer.mobile', targetField: 'phone' },
        { sourceKey: 'customer.name', targetField: 'name' },
      ],
      save: jest.fn().mockResolvedValue(true),
      ...overrides,
    });

    const mockJwtService: any = {};
    const mockConfigService: any = {
      get: jest.fn().mockReturnValue(''),
    };

    it('throws 405 Method Not Allowed when a GET request hits a POST-only webhook', async () => {
      const mockWebhookModel: any = {
        findOne: jest.fn().mockReturnValue({
          exec: jest
            .fn()
            .mockResolvedValue(makeWebhookDoc({ allowedMethod: 'POST' })),
        }),
      };
      const mockLogModel: any = {};
      const mockProcessor: any = {};

      const service = new UniversalWebhooksService(
        mockWebhookModel,
        mockLogModel,
        mockJwtService,
        mockConfigService,
        mockProcessor,
      );

      await expect(
        service.handleIncomingWebhook({
          webhookId: 'wh_test_001',
          secretToken,
          method: 'GET',
          payload: { phone: '9876543210' },
        }),
      ).rejects.toThrow(MethodNotAllowedException);
    });

    it('captures sample payload in listening mode and returns 200 OK with mode: sample_captured', async () => {
      const listeningDoc = makeWebhookDoc({ status: 'listening', allowedMethod: 'POST' });
      const mockWebhookModel: any = {
        findOne: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue(listeningDoc),
        }),
      };
      const mockLogModel: any = {
        create: jest.fn().mockResolvedValue({ _id: new Types.ObjectId() }),
      };
      const mockProcessor: any = {};

      const service = new UniversalWebhooksService(
        mockWebhookModel,
        mockLogModel,
        mockJwtService,
        mockConfigService,
        mockProcessor,
      );

      const res = await service.handleIncomingWebhook({
        webhookId: 'wh_test_001',
        secretToken,
        method: 'POST',
        payload: { customer: { name: 'Aarti Sharma', mobile: '9811122233' } },
      });

      expect(res.statusCode).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.mode).toBe('sample_captured');
      expect(res.body.flattenedKeys).toEqual(['customer.name', 'customer.mobile']);
      expect(mockLogModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: 'sample_captured',
          webhookId: 'wh_test_001',
        }),
      );
    });
  });

  // 4. Smart Phone-Based Upsert Deduplication (fill_empty vs overwrite_non_empty)
  describe('UniversalWebhookProcessor Atomic Phone Upsert & Deduplication', () => {
    const tenantId = new Types.ObjectId();
    const defaultOwnerId = new Types.ObjectId();

    const setupProcessorWithInMemoryLeads = (webhookDocRef: { current: any }) => {
      const leadsStore: any[] = [];

      const mockLeadModel: any = {
        findOne: jest.fn((filter: any) => ({
          exec: jest.fn(async () => {
            const normTarget = filter?.$or?.[0]?.normalizedPhone;
            return (
              leadsStore.find(
                (l) =>
                  String(l.tenantId) === String(filter.tenantId) &&
                  l.normalizedPhone === normTarget,
              ) || null
            );
          }),
        })),
        create: jest.fn(async (doc: any) => {
          const newDoc = {
            _id: new Types.ObjectId(),
            ...doc,
            timeline: doc.timeline || [],
            markModified: jest.fn(),
            save: jest.fn(async function () {
              return this;
            }),
          };
          leadsStore.push(newDoc);
          return newDoc;
        }),
      };

      const mockWebhookModel: any = {
        findOne: jest.fn(() => ({
          exec: jest.fn(async () => webhookDocRef.current),
        })),
        updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
      };

      const mockLogModel: any = {
        create: jest.fn().mockResolvedValue({ _id: new Types.ObjectId() }),
        find: jest.fn().mockReturnValue({
          sort: () => ({
            skip: () => ({
              select: () => ({
                lean: () => ({
                  exec: jest.fn().mockResolvedValue([]),
                }),
              }),
            }),
          }),
        }),
      };

      const mockTenantModel: any = {
        findById: jest.fn().mockReturnValue({
          lean: () => ({
            exec: jest.fn().mockResolvedValue({ _id: tenantId, companyName: 'Test Co' }),
          }),
        }),
      };

      const mockUserModel: any = {
        findOne: jest.fn().mockReturnValue({
          sort: () => ({
            select: () => ({
              lean: () => ({
                exec: jest
                  .fn()
                  .mockResolvedValue({ _id: defaultOwnerId, name: 'Sales Rep 1' }),
              }),
            }),
          }),
          select: () => ({
            lean: () => ({
              exec: jest
                .fn()
                .mockResolvedValue({ _id: defaultOwnerId, name: 'Sales Rep 1' }),
            }),
          }),
        }),
      };

      const processor = new UniversalWebhookProcessor(
        mockWebhookModel,
        mockLogModel,
        mockLeadModel,
        {} as any,
        {} as any,
        mockTenantModel,
        mockUserModel,
      );

      return { processor, leadsStore, mockWebhookModel, mockLogModel };
    };

    it('creates a new Lead on first hit and updates existing Lead on second hit with same normalized phone without creating duplicates (fill_empty vs overwrite_non_empty)', async () => {
      const webhookDocRef = {
        current: {
          _id: new Types.ObjectId(),
          tenantId,
          name: 'Landing Page RFQ',
          webhookId: 'wh_dedup_test',
          targetAction: 'create_lead',
          duplicateStrategy: 'fill_empty',
          triggerWhatsappOnNew: false,
          triggerWhatsappOnRepeat: false,
          fieldMappings: [
            { sourceKey: 'phone', targetField: 'phone' },
            { sourceKey: 'name', targetField: 'name' },
            { sourceKey: 'company', targetField: 'company' },
            { sourceKey: 'city', targetField: 'city' },
            { sourceKey: 'budget', targetField: 'estimatedValue' },
          ],
        },
      };

      const { processor, leadsStore } = setupProcessorWithInMemoryLeads(webhookDocRef);

      // First hit: 10-digit phone '9820451290', company is empty
      const firstResult = await processor.processWebhookJob({
        webhookId: 'wh_dedup_test',
        method: 'POST',
        rawPayload: { phone: '9820451290', name: 'Rohan Kulkarni', city: 'Mumbai' },
        flattenedPayload: { phone: '9820451290', name: 'Rohan Kulkarni', city: 'Mumbai' },
      });

      expect(firstResult.outcome).toBe('created');
      expect(firstResult.normalizedPhone).toBe('+919820451290');
      expect(leadsStore).toHaveLength(1);
      expect(leadsStore[0].name).toBe('Rohan Kulkarni');
      expect(leadsStore[0].city).toBe('Mumbai');
      expect(leadsStore[0].company).toBe('');

      // Simulate sales rep advancing pipeline stage to 'qualified'
      leadsStore[0].status = 'qualified';
      const originalOwnerId = leadsStore[0].ownerId;

      // Second hit (same phone formatted as '+91-98204 51290') with fill_empty strategy:
      // sends new company ('Kulkarni Motors Pvt Ltd') and different city ('Pune')
      const secondResult = await processor.processWebhookJob({
        webhookId: 'wh_dedup_test',
        method: 'POST',
        rawPayload: {
          phone: '+91-98204 51290',
          name: 'Rohan K. Updated',
          company: 'Kulkarni Motors Pvt Ltd',
          city: 'Pune',
        },
        flattenedPayload: {
          phone: '+91-98204 51290',
          name: 'Rohan K. Updated',
          company: 'Kulkarni Motors Pvt Ltd',
          city: 'Pune',
        },
      });

      expect(secondResult.outcome).toBe('updated');
      expect(leadsStore).toHaveLength(1); // No duplicate created!
      // Under fill_empty: blank 'company' is populated, while existing non-empty 'city' and 'name' are preserved
      expect(leadsStore[0].company).toBe('Kulkarni Motors Pvt Ltd');
      expect(leadsStore[0].city).toBe('Mumbai');
      expect(leadsStore[0].name).toBe('Rohan Kulkarni');
      // Pipeline stage & assigned owner are strictly preserved
      expect(leadsStore[0].status).toBe('qualified');
      expect(leadsStore[0].ownerId).toEqual(originalOwnerId);

      // Third hit with 'overwrite_non_empty' strategy: updates city & budget while preserving stage & owner
      webhookDocRef.current = {
        ...webhookDocRef.current,
        duplicateStrategy: 'overwrite_non_empty',
      };

      const thirdResult = await processor.processWebhookJob({
        webhookId: 'wh_dedup_test',
        method: 'POST',
        rawPayload: {
          phone: '09820451290',
          city: 'Bengaluru',
          budget: '750000',
        },
        flattenedPayload: {
          phone: '09820451290',
          city: 'Bengaluru',
          budget: '750000',
        },
      });

      expect(thirdResult.outcome).toBe('updated');
      expect(leadsStore).toHaveLength(1);
      expect(leadsStore[0].city).toBe('Bengaluru');
      expect(leadsStore[0].estimatedValue).toBe(750000);
      expect(leadsStore[0].status).toBe('qualified');
      expect(leadsStore[0].ownerId).toEqual(originalOwnerId);
    });

    it('marks delivery log as failed with "Missing or invalid phone number" when phone cannot be normalized', async () => {
      const webhookDocRef = {
        current: {
          _id: new Types.ObjectId(),
          tenantId,
          name: 'Broken Payload Webhook',
          webhookId: 'wh_invalid_phone',
          targetAction: 'create_lead',
          duplicateStrategy: 'fill_empty',
          fieldMappings: [{ sourceKey: 'phone', targetField: 'phone' }],
        },
      };

      const { processor, leadsStore } = setupProcessorWithInMemoryLeads(webhookDocRef);

      const res = await processor.processWebhookJob({
        webhookId: 'wh_invalid_phone',
        method: 'POST',
        rawPayload: { phone: 'not-a-phone' },
        flattenedPayload: { phone: 'not-a-phone' },
      });

      expect(res.outcome).toBe('failed');
      expect(res.errorReason).toContain('Missing or invalid phone number');
      expect(leadsStore).toHaveLength(0);
    });
  });
});
