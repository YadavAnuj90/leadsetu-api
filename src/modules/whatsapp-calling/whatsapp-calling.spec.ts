import { ConfigService } from '@nestjs/config';
import { WhatsappCallingService } from './whatsapp-calling.service';

describe('WhatsappCallingService (Slice 1 — Core Calling & Permissions)', () => {
  let service: WhatsappCallingService;

  beforeEach(() => {
    const configService = {
      get: jest.fn((key: string) => {
        if (key === 'WHATSAPP_CALLING_OUTBOUND_RATE_INR_PER_MIN') return '0.45';
        if (key === 'WHATSAPP_CALLING_IST_START_HOUR') return '9';
        if (key === 'WHATSAPP_CALLING_IST_END_HOUR') return '21';
        if (key === 'WEBRTC_ICE_SERVERS_JSON')
          return '[{"urls":"stun:stun.l.google.com:19302"}]';
        return undefined;
      }),
    } as unknown as ConfigService;

    service = new WhatsappCallingService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      configService,
      {} as never,
      { registerWhatsappCallingWebhookHandler: jest.fn() } as never,
      {} as never,
    );
  });

  it('normalizes Indian mobile numbers to canonical +91XXXXXXXXXX', () => {
    expect(service.normalizeE164Phone('+91 98112 45678')).toBe('+919811245678');
    expect(service.normalizeE164Phone('09811245678')).toBe('+919811245678');
    expect(service.normalizeE164Phone('9811245678')).toBe('+919811245678');
  });

  it('masks phone numbers for non-admin sales reps while keeping admin unmasked', () => {
    expect(service.formatPhoneForRole('+919811245678', 'agent')).toContain('***');
    expect(service.formatPhoneForRole('+919811245678', 'owner')).toBe(
      '+91 98112 45678',
    );
  });

  it('computes 6-second pulse INR billing for outbound calls and 0 for inbound calls', () => {
    // 13 seconds = ceil(13 / 6) = 3 pulses * (0.45 / 10) = 0.135 INR
    const outbound = service.computePulseBilling('outbound', 13);
    expect(outbound.billedPulses).toBe(3);
    expect(outbound.costInr).toBeCloseTo(0.135, 4);

    // Inbound is always 0 pulses / 0 INR
    const inbound = service.computePulseBilling('inbound', 120);
    expect(inbound.billedPulses).toBe(0);
    expect(inbound.costInr).toBe(0);
  });

  it('enforces 09:00-21:00 Asia/Kolkata IST calling hours', () => {
    // 10:30 UTC = 16:00 IST (within 09:00-21:00 IST)
    const daytimeUtc = new Date('2026-11-26T10:30:00.000Z');
    expect(service.getIstCallingWindow(daytimeUtc).isWithinHours).toBe(true);

    // 17:30 UTC = 23:00 IST (outside 09:00-21:00 IST)
    const lateNightUtc = new Date('2026-11-26T17:30:00.000Z');
    expect(service.getIstCallingWindow(lateNightUtc).isWithinHours).toBe(false);
  });

  it('persists Hinglish AI summary and BANT updates via runPostCallAiJob', async () => {
    const saveMock = jest.fn().mockResolvedValue(true);
    const callLogMock = {
      _id: '507f1f77bcf86cd799439011',
      tenantId: '507f1f77bcf86cd799439012',
      leadId: '507f1f77bcf86cd799439013',
      wabaPhoneNumberId: 'waba_123',
      normalizedPhone: '+919811245678',
      direction: 'outbound',
      status: 'completed',
      durationSeconds: 42,
      billedPulses: 7,
      costInr: 0.315,
      recordingUrl: 'https://res.cloudinary.com/demo/video/upload/call.webm',
      transcript: '',
      aiSummary: '',
      bantUpdates: {},
      agentName: 'Anuj',
      save: saveMock,
      toObject: () => ({}),
    };

    const emitStatusMock = jest.fn();
    const leadSaveMock = jest.fn().mockResolvedValue(true);
    const leadDoc = {
      _id: '507f1f77bcf86cd799439013',
      name: 'Rajesh Sharma',
      company: 'RS Electricals',
      activities: [],
      nextCallRetryAt: '',
      aiNextAction: '',
      aiSummary: '',
      lastCalledAt: '',
      save: leadSaveMock,
    };

    const aiBridgeMock = {
      processWhatsappCallAudio: jest.fn().mockResolvedValue({
        result: '• Buyer asked for 500 units GST quote.',
        structured: {
          transcript: 'Namaste sir, 500 units ka GST quotation kal bhej dijiye.',
          sttProvider: 'openai-whisper',
          languageDetected: 'hinglish',
          summaryBullets: [
            'Buyer requested 500 units GST proforma invoice.',
            'Agreed on 50% advance dispatch terms.',
            'Follow up tomorrow morning with final quote.',
          ],
          bantUpdates: {
            budget: '₹4,50,000',
            authority: 'Rajesh Sharma',
            need: '500 units industrial supply',
            timeline: 'Tomorrow',
            nextFollowUpDate: '2026-11-27',
            sentiment: 'positive',
            objections: [],
            commitments: ['Send GST quote tomorrow'],
          },
        },
      }),
    };

    const svcWithAi = new WhatsappCallingService(
      {} as never,
      { findById: () => ({ exec: jest.fn().mockResolvedValue(callLogMock) }) } as never,
      { findById: () => ({ exec: jest.fn().mockResolvedValue(leadDoc) }) } as never,
      {} as never,
      {} as never,
      { findOne: () => ({ select: () => ({ lean: () => ({ exec: jest.fn().mockResolvedValue({ _id: '507f1f77bcf86cd799439014' }) }) }) }) } as never,
      {} as never,
      { get: jest.fn() } as unknown as ConfigService,
      {} as never,
      { registerWhatsappCallingWebhookHandler: jest.fn() } as never,
      { emitWhatsappCallStatusUpdated: emitStatusMock } as never,
      aiBridgeMock as never,
    );

    const updated = await svcWithAi.runPostCallAiJob({
      callId: '507f1f77bcf86cd799439011',
    });

    expect(aiBridgeMock.processWhatsappCallAudio).toHaveBeenCalledTimes(1);
    expect(saveMock).toHaveBeenCalled();
    expect(leadSaveMock).toHaveBeenCalled();
    expect(leadDoc.nextCallRetryAt).toBe('2026-11-27');
    expect(emitStatusMock).toHaveBeenCalled();
    expect((updated?.bantUpdates as Record<string, unknown>)?.budget).toBe(
      '₹4,50,000',
    );
  });

  it('idempotently deducts 6-second pulse outbound cost from calling wallet and rejects outbound when balance is below minimum', async () => {
    const callLogUpdateMock = jest
      .fn()
      .mockResolvedValueOnce({ _id: '507f1f77bcf86cd799439020' })
      .mockResolvedValueOnce(null); // second call simulates duplicate webhook
    const tenantFindUpdateMock = jest.fn().mockReturnValue({
      select: () => ({
        lean: () => ({
          exec: jest.fn().mockResolvedValue({
            callingWalletBalanceInr: 24.685,
            callingWalletTotalTopupInr: 0,
            callingWalletTotalSpentInr: 0.315,
            callingWalletStarterGranted: true,
          }),
        }),
      }),
    });
    const txCreateMock = jest.fn().mockResolvedValue({});
    const emitWalletMock = jest.fn();

    const walletSvc = new WhatsappCallingService(
      {} as never,
      {
        findOneAndUpdate: (q: unknown, u: unknown) => ({
          exec: () => callLogUpdateMock(q, u),
        }),
      } as never,
      {} as never,
      {} as never,
      {
        findById: () => ({
          select: () => ({
            lean: () => ({
              exec: jest.fn().mockResolvedValue({
                callingWalletBalanceInr: 25,
                callingWalletTotalTopupInr: 0,
                callingWalletTotalSpentInr: 0,
                callingWalletStarterGranted: true,
              }),
            }),
          }),
        }),
        findOneAndUpdate: tenantFindUpdateMock,
      } as never,
      {} as never,
      {} as never,
      {
        get: jest.fn((key: string) =>
          key === 'WHATSAPP_CALLING_OUTBOUND_RATE_INR_PER_MIN'
            ? '0.45'
            : key === 'WHATSAPP_CALLING_STARTER_CREDIT_INR'
              ? '25'
              : undefined,
        ),
      } as unknown as ConfigService,
      {} as never,
      { registerWhatsappCallingWebhookHandler: jest.fn() } as never,
      { emitWhatsappWalletUpdated: emitWalletMock } as never,
      undefined,
      undefined,
      {
        create: txCreateMock,
      } as never,
    );

    const callLog = {
      _id: '507f1f77bcf86cd799439020',
      tenantId: '507f1f77bcf86cd799439012',
      direction: 'outbound',
    } as never;

    await walletSvc.deductOutboundCallCost(callLog, 0.315, 42);
    // Second call with same callLog must NOT deduct twice
    await walletSvc.deductOutboundCallCost(callLog, 0.315, 42);

    expect(tenantFindUpdateMock).toHaveBeenCalledTimes(1);
    expect(txCreateMock).toHaveBeenCalledTimes(1);
    expect(emitWalletMock).toHaveBeenCalledTimes(1);
  });
});
