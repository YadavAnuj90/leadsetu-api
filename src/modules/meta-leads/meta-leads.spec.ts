import { createHmac } from 'crypto';
import { ConfigService } from '@nestjs/config';
import {
  decryptMetaPageToken,
  encryptMetaPageToken,
  mapMetaFieldDataToLead,
  normalizeIndianMetaPhone,
  signMetaOAuthState,
  verifyMetaOAuthState,
  verifyMetaWebhookSignature,
} from './meta-leads.util';
import { MetaLeadsProcessor } from './meta-leads.processor';

describe('MetaLeads Integration Unit Suite', () => {
  describe('1. X-Hub-Signature-256 HMAC verification', () => {
    const appSecret = 'meta_app_secret_test_2026';
    const rawBody = JSON.stringify({
      object: 'page',
      entry: [
        {
          id: '1029384756',
          changes: [{ field: 'leadgen', value: { leadgen_id: 'lg_991122' } }],
        },
      ],
    });

    it('accepts a valid X-Hub-Signature-256 digest computed against rawBody', () => {
      const validSig =
        'sha256=' +
        createHmac('sha256', appSecret).update(rawBody).digest('hex');
      expect(
        verifyMetaWebhookSignature(Buffer.from(rawBody, 'utf8'), validSig, appSecret),
      ).toBe(true);
    });

    it('rejects tampered payloads, wrong secrets, or malformed signatures', () => {
      const validSig =
        'sha256=' +
        createHmac('sha256', appSecret).update(rawBody).digest('hex');
      expect(
        verifyMetaWebhookSignature(
          Buffer.from(rawBody + 'tampered', 'utf8'),
          validSig,
          appSecret,
        ),
      ).toBe(false);
      expect(
        verifyMetaWebhookSignature(rawBody, validSig, 'wrong_secret'),
      ).toBe(false);
      expect(
        verifyMetaWebhookSignature(rawBody, 'invalid_header', appSecret),
      ).toBe(false);
    });
  });

  describe('2. Indian phone number normalization', () => {
    it('normalizes 9876543210, 09876543210, and +91-98765 43210 to +919876543210', () => {
      expect(normalizeIndianMetaPhone('9876543210')).toBe('+919876543210');
      expect(normalizeIndianMetaPhone('09876543210')).toBe('+919876543210');
      expect(normalizeIndianMetaPhone('+91-98765 43210')).toBe('+919876543210');
      expect(normalizeIndianMetaPhone('91 98765-43210')).toBe('+919876543210');
    });
  });

  describe('3. AES-256-GCM Token Encryption & OAuth State Signing', () => {
    const hexKey =
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

    it('encrypts and decrypts Page Access Tokens losslessly with IV and AuthTag', () => {
      const token = 'EAAGm0PX4ZCpsBAKZCc1234567890PageToken';
      const encrypted = encryptMetaPageToken(token, hexKey);
      expect(encrypted.encryptedPageAccessToken).not.toContain(token);
      expect(encrypted.tokenIv).toHaveLength(24);
      expect(encrypted.tokenAuthTag).toHaveLength(32);

      const decrypted = decryptMetaPageToken({
        ...encrypted,
        encryptionKey: hexKey,
      });
      expect(decrypted).toBe(token);
    });

    it('signs and verifies OAuth state parameter with tenantId and userId', () => {
      const state = signMetaOAuthState(
        { tenantId: '65f000111222333444555666', userId: '65f000111222333444555777' },
        hexKey,
      );
      const verified = verifyMetaOAuthState(state, hexKey);
      expect(verified).toEqual({
        tenantId: '65f000111222333444555666',
        userId: '65f000111222333444555777',
      });
      expect(verifyMetaOAuthState(state, 'wrong_key')).toBeNull();
    });
  });

  describe('4. field_data mapping & unmapped rawFields preservation', () => {
    it('maps configured Meta questions to CRM fields and stores unmapped answers in rawFields', () => {
      const fieldData = [
        { name: 'full_name', values: ['Rajesh Sharma'] },
        { name: 'phone_number', values: ['+91-98765 43210'] },
        { name: 'work_email', values: ['Rajesh@RSElectricals.in'] },
        { name: 'firm_name', values: ['RS Electricals Pvt Ltd'] },
        { name: 'delivery_city', values: ['Noida'] },
        { name: 'project_budget', values: ['₹4,50,000'] },
        { name: 'voltage_rating_custom', values: ['415V Three Phase'] },
      ];

      const fieldMappings = [
        { metaFieldKey: 'full_name', crmFieldKey: 'name' },
        { metaFieldKey: 'phone_number', crmFieldKey: 'phone' },
        { metaFieldKey: 'work_email', crmFieldKey: 'email' },
        { metaFieldKey: 'firm_name', crmFieldKey: 'company' },
        { metaFieldKey: 'delivery_city', crmFieldKey: 'city' },
        { metaFieldKey: 'project_budget', crmFieldKey: 'estimatedValue' },
      ];

      const mapped = mapMetaFieldDataToLead(fieldData, fieldMappings);
      expect(mapped.name).toBe('Rajesh Sharma');
      expect(mapped.phone).toBe('+919876543210');
      expect(mapped.email).toBe('rajesh@rselectricals.in');
      expect(mapped.company).toBe('RS Electricals Pvt Ltd');
      expect(mapped.city).toBe('Noida');
      expect(mapped.estimatedValue).toBe(450000);
      expect(mapped.rawFields).toEqual({
        full_name: 'Rajesh Sharma',
        phone_number: '+91-98765 43210',
        work_email: 'Rajesh@RSElectricals.in',
        firm_name: 'RS Electricals Pvt Ltd',
        delivery_city: 'Noida',
        project_budget: '₹4,50,000',
        voltage_rating_custom: '415V Three Phase',
      });
    });
  });

  describe('5. leadgen_id queue deduplication', () => {
    it('deduplicates identical leadgen_id jobs in MetaLeadsProcessor queue', async () => {
      const mockPageModel = {
        findOne: jest.fn().mockReturnValue({
          sort: () => ({
            exec: async () => null,
          }),
        }),
      };
      const processor = new MetaLeadsProcessor(
        mockPageModel as never,
        {} as never,
        {} as never,
        {} as never,
        new ConfigService(),
      );

      const first = processor.enqueueLeadgenJob({
        jobId: 'lg_dup_1001',
        leadgenId: 'lg_dup_1001',
        pageId: 'page_1',
      });
      const second = processor.enqueueLeadgenJob({
        jobId: 'lg_dup_1001',
        leadgenId: 'lg_dup_1001',
        pageId: 'page_1',
      });

      expect(first.queued).toBe(true);
      expect(first.deduplicated).toBe(false);
      expect(second.queued).toBe(false);
      expect(second.deduplicated).toBe(true);

      await processor.waitForAllInFlight();
    });
  });
});
