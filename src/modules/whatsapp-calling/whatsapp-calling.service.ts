import { InjectQueue } from '@nestjs/bull';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import type { Queue } from 'bull';
import { randomBytes } from 'crypto';
import { Model, Types } from 'mongoose';
import { AiBridgeService } from '../ai-bridge/ai-bridge.service';
import { uploadToCloudinary } from '../auth/cloudinary.util';
import {
  decryptSecret,
  maskPhoneNumber,
  normalizeIndianPhone,
  resolveOwnerScopeFilter,
} from '../auth/identity.util';
import {
  Tenant,
  TenantDocument,
  WhatsAppCloudConfig,
} from '../auth/schemas/tenant.schema';
import { User, UserDocument } from '../auth/schemas/user.schema';
import { Lead, LeadDocument } from '../leads/schemas/lead.schema';
import {
  PlatformConfig,
  PlatformConfigDocument,
  PlatformWhatsAppProviderConfig,
} from '../super-admin/schemas/platform-config.schema';
import { InboxGateway } from '../inbox/inbox.gateway';
import {
  InboxAuthContext,
  InboxService,
  extractLast10Digits,
} from '../inbox/inbox.service';
import { MetaWhatsAppService } from '../inbox/meta-whatsapp.service';
import {
  ChatMessage,
  ConversationDocument,
  ConversationThread,
} from '../inbox/schemas/conversation.schema';
import {
  AcceptInboundWhatsappCallDto,
  EnableWhatsappCallingSettingsDto,
  RequestWhatsappCallPermissionDto,
  StartOutboundWhatsappCallDto,
  TerminateWhatsappCallDto,
  TopupCallingWalletDto,
  UploadWhatsappCallRecordingDto,
} from './dto/whatsapp-calling.dto';
import {
  CallingWalletTransaction,
  CallingWalletTransactionDocument,
} from './schemas/calling-wallet-transaction.schema';
import {
  WhatsappCallLog,
  WhatsappCallLogDocument,
  WhatsappCallStatus,
} from './schemas/whatsapp-call-log.schema';
import {
  WhatsappCallPermission,
  WhatsappCallPermissionDocument,
  WhatsappCallPermissionStatus,
} from './schemas/whatsapp-call-permission.schema';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
const MAX_REQUESTS_PER_24H = 1;
const MAX_REQUESTS_PER_7D = 2;

@Injectable()
export class WhatsappCallingService implements OnModuleInit {
  private readonly logger = new Logger(WhatsappCallingService.name);

  constructor(
    @InjectModel(WhatsappCallPermission.name)
    private readonly permissionModel: Model<WhatsappCallPermissionDocument>,
    @InjectModel(WhatsappCallLog.name)
    private readonly callLogModel: Model<WhatsappCallLogDocument>,
    @InjectModel(Lead.name)
    private readonly leadModel: Model<LeadDocument>,
    @InjectModel(ConversationThread.name)
    private readonly convModel: Model<ConversationDocument>,
    @InjectModel(Tenant.name)
    private readonly tenantModel: Model<TenantDocument>,
    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>,
    @InjectModel(PlatformConfig.name)
    private readonly platformConfigModel: Model<PlatformConfigDocument>,
    private readonly configService: ConfigService,
    private readonly metaWhatsAppService: MetaWhatsAppService,
    private readonly inboxService: InboxService,
    private readonly inboxGateway: InboxGateway,
    @Optional() private readonly aiBridgeService?: AiBridgeService,
    @Optional()
    @InjectQueue('whatsapp-call-postprocess')
    private readonly postprocessQueue?: Queue,
    @Optional()
    @InjectModel(CallingWalletTransaction.name)
    private readonly walletTxModel?: Model<CallingWalletTransactionDocument>,
  ) {}

  onModuleInit() {
    this.inboxService.registerWhatsappCallingWebhookHandler({
      handleCallsWebhook: (params) => this.handleMetaCallsWebhook(params),
      handlePermissionReplyWebhook: (params) =>
        this.handleMetaPermissionReplyWebhook(params),
    });
  }

  /** Canonical `+91XXXXXXXXXX` phone format for unique compound indexing */
  normalizeE164Phone(raw?: string): string {
    const clean = String(raw || '').trim();
    if (!clean) return '';
    const digits = clean.replace(/\D/g, '');
    if (digits.length === 10 && /^[6-9]\d{9}$/.test(digits)) {
      return `+91${digits}`;
    }
    if (digits.length === 12 && digits.startsWith('91')) {
      return `+${digits}`;
    }
    if (digits.length === 11 && digits.startsWith('0')) {
      return `+91${digits.slice(1)}`;
    }
    if (digits.length >= 10) {
      return `+${digits}`;
    }
    return '';
  }

  shouldMaskPhoneForRole(role?: string): boolean {
    return !['owner', 'admin', 'super_admin'].includes(String(role || ''));
  }

  formatPhoneForRole(phone: string, role?: string): string {
    const pretty = normalizeIndianPhone(phone) || phone;
    return this.shouldMaskPhoneForRole(role)
      ? maskPhoneNumber(pretty)
      : pretty;
  }

  getOutboundRateInrPerMin(): number {
    const raw = Number(
      this.configService.get<string>(
        'WHATSAPP_CALLING_OUTBOUND_RATE_INR_PER_MIN',
      ) ?? '0.45',
    );
    return Number.isFinite(raw) && raw >= 0 ? raw : 0.45;
  }

  getStarterCreditInr(): number {
    const raw = Number(
      this.configService.get<string>('WHATSAPP_CALLING_STARTER_CREDIT_INR') ??
        '25',
    );
    return Number.isFinite(raw) && raw >= 0 ? raw : 25;
  }

  getLowBalanceThresholdInr(): number {
    const raw = Number(
      this.configService.get<string>('WHATSAPP_CALLING_LOW_BALANCE_INR') ??
        '25',
    );
    return Number.isFinite(raw) && raw >= 0 ? raw : 25;
  }

  async ensureTenantWalletInitialized(tenantId: string): Promise<{
    balanceInr: number;
    totalTopupInr: number;
    totalSpentInr: number;
    starterGranted: boolean;
  }> {
    const starterCredit = this.getStarterCreditInr();
    const tenantObjId = new Types.ObjectId(tenantId);

    const existing = await this.tenantModel
      .findById(tenantObjId)
      .select(
        'callingWalletBalanceInr callingWalletTotalTopupInr callingWalletTotalSpentInr callingWalletStarterGranted',
      )
      .lean()
      .exec();

    if (!existing) {
      throw new NotFoundException('Workspace tenant not found.');
    }

    if (
      existing.callingWalletBalanceInr === undefined ||
      existing.callingWalletBalanceInr === null
    ) {
      const updated = await this.tenantModel
        .findOneAndUpdate(
          {
            _id: tenantObjId,
            $or: [
              { callingWalletBalanceInr: { $exists: false } },
              { callingWalletBalanceInr: null },
            ],
          },
          {
            $set: {
              callingWalletBalanceInr: starterCredit,
              callingWalletTotalTopupInr: 0,
              callingWalletTotalSpentInr: 0,
              callingWalletStarterGranted: true,
            },
          },
          { new: true },
        )
        .select(
          'callingWalletBalanceInr callingWalletTotalTopupInr callingWalletTotalSpentInr callingWalletStarterGranted',
        )
        .lean()
        .exec();

      if (updated && starterCredit > 0 && this.walletTxModel) {
        await this.walletTxModel
          .create({
            tenantId: tenantObjId,
            type: 'starter_credit',
            amountInr: starterCredit,
            balanceAfterInr: starterCredit,
            referenceId: 'starter_trial',
            description: `Complimentary ₹${starterCredit} WhatsApp Calling starter trial credit`,
          })
          .catch(() => {});
      }

      return {
        balanceInr: Number(updated?.callingWalletBalanceInr ?? starterCredit),
        totalTopupInr: Number(updated?.callingWalletTotalTopupInr ?? 0),
        totalSpentInr: Number(updated?.callingWalletTotalSpentInr ?? 0),
        starterGranted: true,
      };
    }

    return {
      balanceInr: Number(existing.callingWalletBalanceInr ?? 0),
      totalTopupInr: Number(existing.callingWalletTotalTopupInr ?? 0),
      totalSpentInr: Number(existing.callingWalletTotalSpentInr ?? 0),
      starterGranted: Boolean(existing.callingWalletStarterGranted),
    };
  }

  private buildWalletSummaryPayload(params: {
    balanceInr: number;
    totalTopupInr: number;
    totalSpentInr: number;
    starterGranted: boolean;
    transactions?: Array<Record<string, unknown>>;
  }) {
    const rateInrPerMin = this.getOutboundRateInrPerMin();
    const lowBalanceThresholdInr = this.getLowBalanceThresholdInr();
    const balance = Math.max(0, Number(params.balanceInr.toFixed(2)));
    const estimatedMinutesRemaining =
      rateInrPerMin > 0 ? Math.floor(balance / rateInrPerMin) : 0;

    return {
      balanceInr: Number(params.balanceInr.toFixed(4)),
      displayBalanceInr: balance,
      totalTopupInr: Number(params.totalTopupInr.toFixed(2)),
      totalSpentInr: Number(params.totalSpentInr.toFixed(2)),
      starterGranted: params.starterGranted,
      rateInrPerMin,
      pulseSeconds: 6,
      minRequiredBalanceInr: rateInrPerMin,
      lowBalanceThresholdInr,
      isLowBalance: balance < lowBalanceThresholdInr,
      hasMinimumBalance: params.balanceInr >= rateInrPerMin,
      estimatedMinutesRemaining,
      ...(params.transactions ? { transactions: params.transactions } : {}),
    };
  }

  async getWalletSummary(auth: InboxAuthContext) {
    const wallet = await this.ensureTenantWalletInitialized(auth.tenantId);
    const txDocs = this.walletTxModel
      ? await this.walletTxModel
          .find({ tenantId: new Types.ObjectId(auth.tenantId) })
          .sort({ createdAt: -1 })
          .limit(20)
          .lean()
          .exec()
      : [];

    const transactions = txDocs.map((t) => ({
      id: String(t._id),
      type: t.type,
      amountInr: Number(t.amountInr || 0),
      balanceAfterInr: Number(t.balanceAfterInr || 0),
      referenceId: t.referenceId || '',
      description: t.description || '',
      actorEmail: t.actorEmail || '',
      createdAt: (t as { createdAt?: Date }).createdAt
        ? new Date((t as { createdAt?: Date }).createdAt!).toISOString()
        : new Date().toISOString(),
    }));

    return this.buildWalletSummaryPayload({
      ...wallet,
      transactions,
    });
  }

  async adminTopupWallet(auth: InboxAuthContext, dto: TopupCallingWalletDto) {
    if (!['owner', 'admin', 'super_admin'].includes(auth.role)) {
      throw new ForbiddenException(
        'Only Workspace Owner, Admin, or Super Admin can credit WhatsApp Calling balance.',
      );
    }
    const amountInr = Number(dto?.amountInr || 0);
    if (!Number.isFinite(amountInr) || amountInr < 10 || amountInr > 100000) {
      throw new BadRequestException(
        'Top-up amount must be between ₹10 and ₹1,00,000.',
      );
    }

    await this.ensureTenantWalletInitialized(auth.tenantId);
    const tenantObjId = new Types.ObjectId(auth.tenantId);
    const updated = await this.tenantModel
      .findOneAndUpdate(
        { _id: tenantObjId },
        {
          $inc: {
            callingWalletBalanceInr: amountInr,
            callingWalletTotalTopupInr: amountInr,
          },
          $set: { callingWalletStarterGranted: true },
        },
        { new: true },
      )
      .select(
        'callingWalletBalanceInr callingWalletTotalTopupInr callingWalletTotalSpentInr callingWalletStarterGranted',
      )
      .lean()
      .exec();

    const nextBal = Number(updated?.callingWalletBalanceInr ?? amountInr);
    if (this.walletTxModel) {
      await this.walletTxModel.create({
        tenantId: tenantObjId,
        type: 'admin_credit',
        amountInr,
        balanceAfterInr: nextBal,
        referenceId: `adm_${Date.now()}`,
        description:
          dto?.note?.trim() ||
          `Manual INR Calling Wallet top-up (+₹${amountInr})`,
        actorEmail: auth.email,
      });
    }

    const summary = await this.getWalletSummary(auth);
    this.inboxGateway?.emitWhatsappWalletUpdated?.(auth.tenantId, summary);
    return summary;
  }

  async deductOutboundCallCost(
    callLog: WhatsappCallLogDocument,
    billedCostInr: number,
    durationSeconds: number,
  ): Promise<void> {
    if (
      callLog.direction !== 'outbound' ||
      billedCostInr <= 0 ||
      durationSeconds <= 0
    ) {
      return;
    }

    // Atomic guard so finalizeCall + Meta webhook never double-deduct
    const claimed = await this.callLogModel
      .findOneAndUpdate(
        { _id: callLog._id, walletDeducted: { $ne: true } },
        { $set: { walletDeducted: true } },
        { new: true },
      )
      .exec();
    if (!claimed) {
      return;
    }

    const tenantIdStr = callLog.tenantId.toString();
    await this.ensureTenantWalletInitialized(tenantIdStr);

    const updated = await this.tenantModel
      .findOneAndUpdate(
        { _id: callLog.tenantId },
        {
          $inc: {
            callingWalletBalanceInr: -billedCostInr,
            callingWalletTotalSpentInr: billedCostInr,
          },
        },
        { new: true },
      )
      .select(
        'callingWalletBalanceInr callingWalletTotalTopupInr callingWalletTotalSpentInr callingWalletStarterGranted',
      )
      .lean()
      .exec();

    let nextBal = Number(updated?.callingWalletBalanceInr ?? 0);
    if (nextBal < 0) {
      nextBal = 0;
      await this.tenantModel
        .updateOne(
          { _id: callLog.tenantId },
          { $set: { callingWalletBalanceInr: 0 } },
        )
        .exec();
    }

    if (this.walletTxModel) {
      await this.walletTxModel
        .create({
          tenantId: callLog.tenantId,
          type: 'call_deduction',
          amountInr: -billedCostInr,
          balanceAfterInr: Number(nextBal.toFixed(4)),
          referenceId: callLog._id.toString(),
          description: `Outbound WhatsApp Call (${durationSeconds}s · ${Math.ceil(
            durationSeconds / 6,
          )} pulses @ 6s)`,
        })
        .catch(() => {});
    }

    const payload = this.buildWalletSummaryPayload({
      balanceInr: nextBal,
      totalTopupInr: Number(updated?.callingWalletTotalTopupInr ?? 0),
      totalSpentInr: Number(updated?.callingWalletTotalSpentInr ?? billedCostInr),
      starterGranted: Boolean(updated?.callingWalletStarterGranted),
    });
    this.inboxGateway?.emitWhatsappWalletUpdated?.(tenantIdStr, payload);
  }

  getIstCallingWindow(now = new Date()): {
    isWithinHours: boolean;
    istHour: number;
    startHour: number;
    endHour: number;
    timezone: 'Asia/Kolkata';
  } {
    const startHour = Number(
      this.configService.get<string>('WHATSAPP_CALLING_IST_START_HOUR') ?? '9',
    );
    const endHour = Number(
      this.configService.get<string>('WHATSAPP_CALLING_IST_END_HOUR') ?? '21',
    );
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Kolkata',
      hour: 'numeric',
      hour12: false,
    }).formatToParts(now);
    const hourStr = parts.find((p) => p.type === 'hour')?.value || '12';
    const istHour = Number(hourStr) % 24;
    const isWithinHours = istHour >= startHour && istHour < endHour;

    return {
      isWithinHours,
      istHour,
      startHour,
      endHour,
      timezone: 'Asia/Kolkata',
    };
  }

  getWebRtcIceServers(): Array<Record<string, unknown>> {
    const rawJson = this.configService
      .get<string>('WEBRTC_ICE_SERVERS_JSON')
      ?.trim();
    if (rawJson) {
      try {
        const parsed = JSON.parse(rawJson);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed as Array<Record<string, unknown>>;
        }
      } catch {
        // Fallback to default STUN list
      }
    }
    return [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
    ];
  }

  computePulseBilling(
    direction: 'inbound' | 'outbound',
    durationSeconds: number,
  ): {
    durationSeconds: number;
    billedPulses: number;
    costInr: number;
    rateInrPerMin: number;
  } {
    const cleanDuration = Math.max(0, Math.round(Number(durationSeconds || 0)));
    const rateInrPerMin = this.getOutboundRateInrPerMin();
    if (direction === 'inbound' || cleanDuration <= 0) {
      return {
        durationSeconds: cleanDuration,
        billedPulses: 0,
        costInr: 0,
        rateInrPerMin,
      };
    }
    const billedPulses = Math.ceil(cleanDuration / 6);
    const ratePerPulse = rateInrPerMin / 10;
    const costInr = Number((billedPulses * ratePerPulse).toFixed(4));
    return {
      durationSeconds: cleanDuration,
      billedPulses,
      costInr,
      rateInrPerMin,
    };
  }

  private async resolveTenantWabaCredentials(tenantId: string): Promise<{
    tenant: TenantDocument;
    phoneNumberId: string;
    accessToken: string;
    verifiedPhoneNumber: string;
    businessDisplayName: string;
  }> {
    if (!Types.ObjectId.isValid(tenantId)) {
      throw new BadRequestException('Invalid workspace tenant ID.');
    }
    const [tenant, platformDoc] = await Promise.all([
      this.tenantModel.findById(tenantId).exec(),
      this.platformConfigModel.findOne({ key: 'global' }).lean().exec(),
    ]);
    if (!tenant) {
      throw new NotFoundException('Workspace tenant not found.');
    }

    const cfg = (tenant.whatsappCloud || {}) as Partial<WhatsAppCloudConfig>;
    const ownToken = decryptSecret(cfg.accessTokenEncrypted);
    const rawPlatform = (platformDoc?.whatsappProvider ||
      {}) as Partial<PlatformWhatsAppProviderConfig>;
    const managedPhoneNumberId =
      rawPlatform.managedPhoneNumberId?.trim() ||
      this.configService.get<string>('META_MANAGED_PHONE_NUMBER_ID')?.trim() ||
      this.configService.get<string>('WHATSAPP_PHONE_NUMBER_ID')?.trim() ||
      '';
    const managedAccessToken =
      decryptSecret(rawPlatform.managedAccessTokenEncrypted) ||
      this.configService.get<string>('META_MANAGED_ACCESS_TOKEN')?.trim() ||
      this.configService.get<string>('WHATSAPP_ACCESS_TOKEN')?.trim() ||
      '';

    const phoneNumberId =
      cfg.phoneNumberId?.trim() ||
      managedPhoneNumberId ||
      `sim_waba_${tenant._id.toString().slice(-6)}`;
    const accessToken = ownToken || managedAccessToken || '';

    return {
      tenant,
      phoneNumberId,
      accessToken,
      verifiedPhoneNumber:
        cfg.verifiedPhoneNumber || rawPlatform.managedDisplayNumber || '',
      businessDisplayName:
        cfg.businessDisplayName ||
        rawPlatform.managedDisplayName ||
        tenant.companyName ||
        'Leadsetu Workspace',
    };
  }

  private async resolveAccessibleLead(
    auth: InboxAuthContext,
    leadId: string,
  ): Promise<{ lead: LeadDocument; normalizedPhone: string }> {
    if (!Types.ObjectId.isValid(leadId)) {
      throw new BadRequestException('Valid CRM Lead ID is required.');
    }
    const scopeFilter = await resolveOwnerScopeFilter(this.leadModel.db, auth);
    const lead = await this.leadModel
      .findOne({
        _id: new Types.ObjectId(leadId),
        tenantId: new Types.ObjectId(auth.tenantId),
        ...scopeFilter,
      })
      .exec();
    if (!lead) {
      throw new NotFoundException(
        'Lead not found or you do not have permission to call this lead.',
      );
    }
    const normalizedPhone = this.normalizeE164Phone(lead.phone);
    if (!normalizedPhone) {
      throw new BadRequestException(
        'Lead does not have a valid phone number configured.',
      );
    }
    return { lead, normalizedPhone };
  }

  private computePermissionSummary(
    doc: WhatsappCallPermissionDocument | null,
    now = new Date(),
  ): {
    status: WhatsappCallPermissionStatus;
    isPermitted: boolean;
    grantedAt: string | null;
    expiresAt: string | null;
    remainingSeconds: number;
    remainingLabel: string;
    connectedCallsUsed: number;
    requestsLast24h: number;
    requestsLast7d: number;
    remainingQuota24h: number;
    remainingQuota7d: number;
    canRequestPermission: boolean;
    nextRequestAllowedAt: string | null;
  } {
    const timestamps = (doc?.permissionRequestsTimestamps || [])
      .map((d) => new Date(d))
      .filter((d) => !Number.isNaN(d.getTime()))
      .sort((a, b) => a.getTime() - b.getTime());

    const cutoff24h = now.getTime() - TWENTY_FOUR_HOURS_MS;
    const cutoff7d = now.getTime() - SEVEN_DAYS_MS;

    const recent24h = timestamps.filter((d) => d.getTime() > cutoff24h);
    const recent7d = timestamps.filter((d) => d.getTime() > cutoff7d);

    let effectiveStatus: WhatsappCallPermissionStatus = doc?.status || 'none';
    let remainingSeconds = 0;

    if (effectiveStatus === 'granted' && doc?.expiresAt) {
      const diffMs = new Date(doc.expiresAt).getTime() - now.getTime();
      if (diffMs > 0) {
        remainingSeconds = Math.floor(diffMs / 1000);
      } else {
        effectiveStatus = 'expired';
      }
    }

    const days = Math.floor(remainingSeconds / 86400);
    const hours = Math.floor((remainingSeconds % 86400) / 3600);
    const minutes = Math.floor((remainingSeconds % 3600) / 60);
    const remainingLabel =
      remainingSeconds <= 0
        ? '0h left'
        : days > 0
          ? `${days}d ${hours}h left`
          : hours > 0
            ? `${hours}h ${minutes}m left`
            : `${minutes}m left`;

    const remainingQuota24h = Math.max(
      0,
      MAX_REQUESTS_PER_24H - recent24h.length,
    );
    const remainingQuota7d = Math.max(0, MAX_REQUESTS_PER_7D - recent7d.length);

    let nextRequestAllowedAt: string | null = null;
    if (remainingQuota24h === 0 && recent24h[0]) {
      nextRequestAllowedAt = new Date(
        recent24h[0].getTime() + TWENTY_FOUR_HOURS_MS,
      ).toISOString();
    } else if (remainingQuota7d === 0 && recent7d[0]) {
      nextRequestAllowedAt = new Date(
        recent7d[0].getTime() + SEVEN_DAYS_MS,
      ).toISOString();
    }

    const isPermitted = effectiveStatus === 'granted' && remainingSeconds > 0;
    const canRequestPermission =
      !isPermitted && remainingQuota24h > 0 && remainingQuota7d > 0;

    return {
      status: effectiveStatus,
      isPermitted,
      grantedAt: doc?.grantedAt ? new Date(doc.grantedAt).toISOString() : null,
      expiresAt: doc?.expiresAt ? new Date(doc.expiresAt).toISOString() : null,
      remainingSeconds,
      remainingLabel,
      connectedCallsUsed: Number(doc?.connectedCallsUsed || 0),
      requestsLast24h: recent24h.length,
      requestsLast7d: recent7d.length,
      remainingQuota24h,
      remainingQuota7d,
      canRequestPermission,
      nextRequestAllowedAt,
    };
  }

  async getCallingSettings(auth: InboxAuthContext) {
    const waba = await this.resolveTenantWabaCredentials(auth.tenantId);
    const istWindow = this.getIstCallingWindow();
    return {
      wabaPhoneNumberId: waba.phoneNumberId,
      verifiedPhoneNumber: waba.verifiedPhoneNumber,
      businessDisplayName: waba.businessDisplayName,
      outboundRateInrPerMin: this.getOutboundRateInrPerMin(),
      pulseSeconds: 6,
      inboundRateInrPerMin: 0,
      istWindow,
      iceServers: this.getWebRtcIceServers(),
    };
  }

  async enableCallingSettings(
    auth: InboxAuthContext,
    dto: EnableWhatsappCallingSettingsDto,
  ) {
    if (!['owner', 'admin', 'super_admin'].includes(auth.role)) {
      throw new ForbiddenException(
        'Only Workspace Owner or Admin can configure WABA Calling settings.',
      );
    }
    const waba = await this.resolveTenantWabaCredentials(auth.tenantId);
    const phoneNumberId = dto.phoneNumberId?.trim() || waba.phoneNumberId;

    const result = await this.metaWhatsAppService.enableCallingSettings({
      phoneNumberId,
      accessToken: waba.accessToken,
      callIconVisibility: dto.callIconVisibility || 'DEFAULT',
      callbackPermissionStatus: dto.callbackPermissionStatus || 'ENABLED',
    });

    if (!result.ok) {
      throw new BadRequestException(
        result.error ||
          'Failed to enable WhatsApp Business Calling on Meta Graph API.',
      );
    }

    const currentSettings = await this.getCallingSettings(auth);
    return {
      ...currentSettings,
      enabled: true,
      simulated: Boolean(result.simulated),
      wabaPhoneNumberId: phoneNumberId,
      callIconVisibility: dto.callIconVisibility || 'DEFAULT',
      callbackPermissionStatus: dto.callbackPermissionStatus || 'ENABLED',
    };
  }

  async getLeadCallPermission(auth: InboxAuthContext, leadId: string) {
    const [{ lead, normalizedPhone }, waba] = await Promise.all([
      this.resolveAccessibleLead(auth, leadId),
      this.resolveTenantWabaCredentials(auth.tenantId),
    ]);

    const doc = await this.permissionModel
      .findOne({
        tenantId: new Types.ObjectId(auth.tenantId),
        wabaPhoneNumberId: waba.phoneNumberId,
        normalizedPhone,
      })
      .exec();

    const now = new Date();
    if (
      doc &&
      doc.status === 'granted' &&
      doc.expiresAt &&
      doc.expiresAt.getTime() <= now.getTime()
    ) {
      doc.status = 'expired';
      await doc.save();
    }

    const summary = this.computePermissionSummary(doc, now);
    const istWindow = this.getIstCallingWindow(now);

    return {
      leadId: lead._id.toString(),
      leadName: lead.name,
      company: lead.company || '',
      displayPhone: this.formatPhoneForRole(lead.phone, auth.role),
      wabaPhoneNumberId: waba.phoneNumberId,
      ...summary,
      istWindow,
      outboundRateInrPerMin: this.getOutboundRateInrPerMin(),
      iceServers: this.getWebRtcIceServers(),
    };
  }

  private async findOrCreateLeadConversation(params: {
    tenant: TenantDocument;
    lead: LeadDocument;
    conversationId?: string;
  }): Promise<ConversationDocument> {
    if (
      params.conversationId &&
      Types.ObjectId.isValid(params.conversationId)
    ) {
      const byId = await this.convModel
        .findOne({
          _id: new Types.ObjectId(params.conversationId),
          tenantId: params.tenant._id,
        })
        .exec();
      if (byId) return byId;
    }

    const last10 = extractLast10Digits(params.lead.phone || '');
    const existing = await this.convModel
      .find({
        tenantId: params.tenant._id,
        channel: 'whatsapp',
      })
      .sort({ updatedAt: -1 })
      .exec();

    const matched = existing.find(
      (c) =>
        (c.linkedEntityType === 'lead' &&
          c.linkedEntityId === params.lead._id.toString()) ||
        (last10.length === 10 && extractLast10Digits(c.phone || '') === last10),
    );
    if (matched) return matched;

    return this.convModel.create({
      tenantId: params.tenant._id,
      ownerId: params.lead.ownerId,
      contactName: params.lead.name,
      company: params.lead.company || '',
      phone: params.lead.phone,
      city: params.lead.city || params.tenant.city || 'Delhi-NCR',
      channel: 'whatsapp',
      status: 'open',
      aiScore: params.lead.aiScore ?? 80,
      estimatedValue: params.lead.estimatedValue || 0,
      linkedEntityType: 'lead',
      linkedEntityId: params.lead._id.toString(),
      linkedEntityLabel: params.lead.company
        ? `${params.lead.name} (${params.lead.company})`
        : params.lead.name,
      unreadCount: 0,
      messages: [],
    });
  }

  private async appendConversationTimelineMessage(params: {
    conv: ConversationDocument;
    direction: 'inbound' | 'outbound';
    content: string;
    senderName: string;
    externalMessageId?: string;
    templateName?: string;
  }) {
    const nowIso = new Date().toISOString();
    const msg: ChatMessage = {
      id: randomBytes(6).toString('hex'),
      direction: params.direction,
      content: params.content,
      senderName: params.senderName,
      status: 'delivered',
      deliveryProvider: 'meta_cloud',
      ...(params.externalMessageId
        ? { externalMessageId: params.externalMessageId }
        : {}),
      ...(params.templateName ? { templateName: params.templateName } : {}),
      createdAt: nowIso,
    };
    params.conv.messages = [...(params.conv.messages || []), msg];
    params.conv.markModified('messages');
    await params.conv.save();

    this.inboxGateway.emitConversationUpdated(
      params.conv.tenantId.toString(),
      {
        id: params.conv._id.toString(),
        tenantId: params.conv.tenantId.toString(),
        contactName: params.conv.contactName,
        linkedEntityType: params.conv.linkedEntityType,
        linkedEntityId: params.conv.linkedEntityId,
        lastMessage: msg.content,
        lastMessageAt: nowIso,
      },
      params.direction === 'inbound' ? 'message.inbound' : 'message.outbound',
    );
  }

  async requestLeadCallPermission(
    auth: InboxAuthContext,
    leadId: string,
    dto: RequestWhatsappCallPermissionDto,
  ) {
    const now = new Date();
    const istWindow = this.getIstCallingWindow(now);
    if (!istWindow.isWithinHours) {
      throw new BadRequestException(
        `WhatsApp call permission requests are only allowed between ${String(istWindow.startHour).padStart(2, '0')}:00 and ${String(istWindow.endHour).padStart(2, '0')}:00 IST (Asia/Kolkata).`,
      );
    }

    const [{ lead, normalizedPhone }, waba] = await Promise.all([
      this.resolveAccessibleLead(auth, leadId),
      this.resolveTenantWabaCredentials(auth.tenantId),
    ]);

    const existing = await this.permissionModel
      .findOne({
        tenantId: new Types.ObjectId(auth.tenantId),
        wabaPhoneNumberId: waba.phoneNumberId,
        normalizedPhone,
      })
      .exec();

    const summary = this.computePermissionSummary(existing, now);
    if (summary.isPermitted) {
      throw new BadRequestException(
        `Callback permission is already granted for this lead (${summary.remainingLabel}).`,
      );
    }
    if (summary.remainingQuota24h <= 0) {
      throw new BadRequestException(
        'Meta WhatsApp limit reached: maximum 1 call permission request per 24 hours for this buyer.',
      );
    }
    if (summary.remainingQuota7d <= 0) {
      throw new BadRequestException(
        'Meta WhatsApp limit reached: maximum 2 ungranted call permission requests per 7 days for this buyer.',
      );
    }

    const conv = await this.findOrCreateLeadConversation({
      tenant: waba.tenant,
      lead,
      conversationId: dto.conversationId,
    });

    const reasonText =
      (dto.reasonText || '').trim() ||
      `Namaste ${lead.name} ji! Can our team call you on WhatsApp regarding ${lead.company || 'your inquiry'}?`;

    const sendRes = await this.metaWhatsAppService.sendCallPermissionRequest({
      phoneNumberId: waba.phoneNumberId,
      accessToken: waba.accessToken,
      toPhone: normalizedPhone,
      bodyText: reasonText,
    });

    if (!sendRes.ok) {
      throw new BadRequestException(
        sendRes.error ||
          'Failed to send WhatsApp call permission request via Meta Cloud API.',
      );
    }

    const cutoff7d = now.getTime() - SEVEN_DAYS_MS;
    const retainedTimestamps = (existing?.permissionRequestsTimestamps || [])
      .map((d) => new Date(d))
      .filter((d) => !Number.isNaN(d.getTime()) && d.getTime() > cutoff7d);
    retainedTimestamps.push(now);

    const updatedDoc = await this.permissionModel
      .findOneAndUpdate(
        {
          tenantId: new Types.ObjectId(auth.tenantId),
          wabaPhoneNumberId: waba.phoneNumberId,
          normalizedPhone,
        },
        {
          $set: {
            status: 'requested',
            permissionRequestsTimestamps: retainedTimestamps,
            leadId: lead._id,
            conversationId: conv._id,
            lastResponseSource: 'agent_request',
          },
        },
        { upsert: true, new: true },
      )
      .exec();

    await this.appendConversationTimelineMessage({
      conv,
      direction: 'outbound',
      content: `📞 [WhatsApp Call Permission Request Sent] ${reasonText}`,
      senderName: auth.name,
      externalMessageId: sendRes.externalMessageId,
      templateName: 'call_permission_request',
    });

    await this.inboxService.logWhatsAppTimelineActivity(
      auth.tenantId,
      'lead',
      lead._id.toString(),
      auth.name,
      'Sent WhatsApp interactive Call Permission Request.',
    );

    const nextSummary = this.computePermissionSummary(updatedDoc, now);
    const payload = {
      leadId: lead._id.toString(),
      conversationId: conv._id.toString(),
      wabaPhoneNumberId: waba.phoneNumberId,
      ...nextSummary,
      istWindow,
    };

    this.inboxGateway.emitWhatsappPermissionUpdated(auth.tenantId, payload);
    return payload;
  }

  async startOutboundCall(
    auth: InboxAuthContext,
    dto: StartOutboundWhatsappCallDto,
  ) {
    if (!dto.sdpOffer || !dto.sdpOffer.trim()) {
      throw new BadRequestException('WebRTC sdpOffer is required.');
    }

    const now = new Date();
    const istWindow = this.getIstCallingWindow(now);
    if (!istWindow.isWithinHours) {
      throw new BadRequestException(
        `Outbound WhatsApp calls are only permitted between ${String(istWindow.startHour).padStart(2, '0')}:00 and ${String(istWindow.endHour).padStart(2, '0')}:00 IST (Asia/Kolkata).`,
      );
    }

    const [{ lead, normalizedPhone }, waba] = await Promise.all([
      this.resolveAccessibleLead(auth, dto.leadId),
      this.resolveTenantWabaCredentials(auth.tenantId),
    ]);

    const permDoc = await this.permissionModel
      .findOne({
        tenantId: new Types.ObjectId(auth.tenantId),
        wabaPhoneNumberId: waba.phoneNumberId,
        normalizedPhone,
      })
      .exec();

    const permSummary = this.computePermissionSummary(permDoc, now);
    if (!permSummary.isPermitted) {
      throw new ForbiddenException(
        'WhatsApp Callback Permission is not currently granted or has expired for this lead. Please request call permission first.',
      );
    }

    const wallet = await this.ensureTenantWalletInitialized(auth.tenantId);
    const minRequired = this.getOutboundRateInrPerMin();
    if (wallet.balanceInr < minRequired) {
      throw new ForbiddenException(
        `Insufficient WhatsApp Calling wallet balance (₹${wallet.balanceInr.toFixed(
          2,
        )}). Minimum ₹${minRequired.toFixed(
          2,
        )} required for outbound calls. Top up in Settings -> Billing -> Top-Up Credits.`,
      );
    }

    const conv = await this.findOrCreateLeadConversation({
      tenant: waba.tenant,
      lead,
      conversationId: dto.conversationId,
    });

    const signalRes = await this.metaWhatsAppService.signalWhatsAppCall({
      phoneNumberId: waba.phoneNumberId,
      accessToken: waba.accessToken,
      action: 'connect',
      toPhone: normalizedPhone,
      session: {
        sdp_type: 'offer',
        sdp: dto.sdpOffer,
      },
    });

    if (!signalRes.ok) {
      throw new BadRequestException(
        signalRes.error ||
          'Meta WhatsApp Cloud API rejected outbound WebRTC call offer.',
      );
    }

    const callLog = await this.callLogModel.create({
      tenantId: new Types.ObjectId(auth.tenantId),
      leadId: lead._id,
      conversationId: conv._id,
      wabaPhoneNumberId: waba.phoneNumberId,
      normalizedPhone,
      metaCallId: signalRes.metaCallId || `wacall_${randomBytes(6).toString('hex')}`,
      direction: 'outbound',
      status: 'ringing',
      durationSeconds: 0,
      billedPulses: 0,
      costInr: 0,
      agentUserId: Types.ObjectId.isValid(auth.userId)
        ? new Types.ObjectId(auth.userId)
        : undefined,
      agentName: auth.name,
      startedAt: now,
    });

    const dtoOut = this.toCallLogDto(callLog, auth.role, lead);
    this.inboxGateway.emitWhatsappCallStatusUpdated(auth.tenantId, dtoOut);

    return {
      callId: callLog._id.toString(),
      metaCallId: callLog.metaCallId,
      sdpAnswer: signalRes.sdpAnswer || '',
      simulated: Boolean(signalRes.simulated),
      status: callLog.status,
      direction: callLog.direction,
      leadId: lead._id.toString(),
      leadName: lead.name,
      displayPhone: this.formatPhoneForRole(lead.phone, auth.role),
      outboundRateInrPerMin: this.getOutboundRateInrPerMin(),
      iceServers: this.getWebRtcIceServers(),
    };
  }

  private async grantSevenDayPermission(params: {
    tenantId: Types.ObjectId;
    wabaPhoneNumberId: string;
    normalizedPhone: string;
    leadId?: Types.ObjectId;
    conversationId?: Types.ObjectId;
    source: 'inbound_call' | 'permission_reply_accept';
  }): Promise<WhatsappCallPermissionDocument> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SEVEN_DAYS_MS);
    const updated = await this.permissionModel
      .findOneAndUpdate(
        {
          tenantId: params.tenantId,
          wabaPhoneNumberId: params.wabaPhoneNumberId,
          normalizedPhone: params.normalizedPhone,
        },
        {
          $set: {
            status: 'granted',
            grantedAt: now,
            expiresAt,
            connectedCallsUsed: 0,
            ...(params.leadId ? { leadId: params.leadId } : {}),
            ...(params.conversationId
              ? { conversationId: params.conversationId }
              : {}),
            lastResponseSource: params.source,
          },
        },
        { upsert: true, new: true },
      )
      .exec();

    const summary = this.computePermissionSummary(updated, now);
    this.inboxGateway.emitWhatsappPermissionUpdated(
      params.tenantId.toString(),
      {
        leadId: params.leadId?.toString() || updated.leadId?.toString() || '',
        conversationId:
          params.conversationId?.toString() ||
          updated.conversationId?.toString() ||
          '',
        wabaPhoneNumberId: params.wabaPhoneNumberId,
        ...summary,
        istWindow: this.getIstCallingWindow(now),
      },
    );
    return updated;
  }

  private async resolveCallLogForTenant(
    tenantId: string,
    callIdOrMetaId: string,
  ): Promise<WhatsappCallLogDocument> {
    const tenantObjId = new Types.ObjectId(tenantId);
    const byId = Types.ObjectId.isValid(callIdOrMetaId)
      ? await this.callLogModel
          .findOne({ _id: new Types.ObjectId(callIdOrMetaId), tenantId: tenantObjId })
          .exec()
      : null;
    if (byId) return byId;

    const byMeta = await this.callLogModel
      .findOne({ metaCallId: callIdOrMetaId, tenantId: tenantObjId })
      .exec();
    if (!byMeta) {
      throw new NotFoundException('WhatsApp call session not found.');
    }
    return byMeta;
  }

  async acceptInboundCall(
    auth: InboxAuthContext,
    callId: string,
    dto: AcceptInboundWhatsappCallDto,
  ) {
    if (!dto.sdpAnswer || !dto.sdpAnswer.trim()) {
      throw new BadRequestException('WebRTC sdpAnswer is required.');
    }

    const [callLog, waba] = await Promise.all([
      this.resolveCallLogForTenant(auth.tenantId, callId),
      this.resolveTenantWabaCredentials(auth.tenantId),
    ]);

    if (callLog.metaCallId) {
      await this.metaWhatsAppService.signalWhatsAppCall({
        phoneNumberId: callLog.wabaPhoneNumberId || waba.phoneNumberId,
        accessToken: waba.accessToken,
        action: 'pre_accept',
        callId: callLog.metaCallId,
        session: {
          sdp_type: 'answer',
          sdp: dto.sdpAnswer,
        },
      });

      const acceptRes = await this.metaWhatsAppService.signalWhatsAppCall({
        phoneNumberId: callLog.wabaPhoneNumberId || waba.phoneNumberId,
        accessToken: waba.accessToken,
        action: 'accept',
        callId: callLog.metaCallId,
        session: {
          sdp_type: 'answer',
          sdp: dto.sdpAnswer,
        },
      });
      if (!acceptRes.ok) {
        throw new BadRequestException(
          acceptRes.error || 'Failed to accept inbound WhatsApp call on Meta Graph API.',
        );
      }
    }

    const now = new Date();
    callLog.status = 'in_progress';
    callLog.connectedAt = now;
    if (Types.ObjectId.isValid(auth.userId)) {
      callLog.agentUserId = new Types.ObjectId(auth.userId);
    }
    callLog.agentName = auth.name;
    await callLog.save();

    await this.grantSevenDayPermission({
      tenantId: callLog.tenantId,
      wabaPhoneNumberId: callLog.wabaPhoneNumberId || waba.phoneNumberId,
      normalizedPhone: callLog.normalizedPhone,
      leadId: callLog.leadId,
      conversationId: callLog.conversationId,
      source: 'inbound_call',
    });

    const out = this.toCallLogDto(callLog, auth.role);
    this.inboxGateway.emitWhatsappCallStatusUpdated(auth.tenantId, out);
    return out;
  }

  async rejectCall(
    auth: InboxAuthContext,
    callId: string,
    dto?: TerminateWhatsappCallDto,
  ) {
    return this.finalizeCall(auth, callId, 'reject', dto);
  }

  async terminateCall(
    auth: InboxAuthContext,
    callId: string,
    dto?: TerminateWhatsappCallDto,
  ) {
    return this.finalizeCall(auth, callId, 'terminate', dto);
  }

  private async finalizeCall(
    auth: InboxAuthContext,
    callId: string,
    action: 'reject' | 'terminate',
    dto?: TerminateWhatsappCallDto,
  ) {
    const [callLog, waba] = await Promise.all([
      this.resolveCallLogForTenant(auth.tenantId, callId),
      this.resolveTenantWabaCredentials(auth.tenantId),
    ]);

    if (callLog.metaCallId && !['completed', 'missed', 'rejected', 'failed'].includes(callLog.status)) {
      await this.metaWhatsAppService.signalWhatsAppCall({
        phoneNumberId: callLog.wabaPhoneNumberId || waba.phoneNumberId,
        accessToken: waba.accessToken,
        action,
        callId: callLog.metaCallId,
      });
    }

    const now = new Date();
    let durationSeconds = Number(dto?.durationSeconds ?? 0);
    if (
      action === 'terminate' &&
      durationSeconds <= 0 &&
      callLog.connectedAt
    ) {
      durationSeconds = Math.max(
        1,
        Math.round((now.getTime() - new Date(callLog.connectedAt).getTime()) / 1000),
      );
    }
    if (action === 'reject') {
      durationSeconds = 0;
    }

    const billing = this.computePulseBilling(callLog.direction, durationSeconds);

    callLog.status =
      action === 'reject'
        ? 'rejected'
        : billing.durationSeconds > 0
          ? 'completed'
          : 'missed';
    callLog.durationSeconds = billing.durationSeconds;
    callLog.billedPulses = billing.billedPulses;
    callLog.costInr = billing.costInr;
    callLog.endedAt = now;
    if (dto?.reason) {
      callLog.failureReason = dto.reason;
    }
    await callLog.save();

    if (callLog.direction === 'outbound' && billing.durationSeconds > 0) {
      await this.permissionModel
        .updateOne(
          {
            tenantId: callLog.tenantId,
            wabaPhoneNumberId: callLog.wabaPhoneNumberId,
            normalizedPhone: callLog.normalizedPhone,
          },
          { $inc: { connectedCallsUsed: 1 } },
        )
        .exec();

      await this.deductOutboundCallCost(
        callLog,
        billing.costInr,
        billing.durationSeconds,
      );
    }

    if (callLog.conversationId) {
      const conv = await this.convModel.findById(callLog.conversationId).exec();
      if (conv) {
        const label =
          callLog.status === 'completed'
            ? `📞 [WhatsApp Voice Call • ${callLog.direction === 'outbound' ? 'Outbound' : 'Inbound'} • ${callLog.durationSeconds}s${callLog.direction === 'outbound' ? ` • ${callLog.billedPulses} pulses (₹${callLog.costInr.toFixed(2)})` : ' • Free Inbound'}]`
            : `📞 [WhatsApp Voice Call ${callLog.status.toUpperCase()} • ${callLog.direction === 'outbound' ? 'Outbound' : 'Inbound'}]`;
        await this.appendConversationTimelineMessage({
          conv,
          direction: callLog.direction,
          content: label,
          senderName: auth.name || conv.contactName,
        });
      }
    }

    const out = this.toCallLogDto(callLog, auth.role);
    this.inboxGateway.emitWhatsappCallStatusUpdated(auth.tenantId, out);

    if (
      callLog.status === 'completed' &&
      callLog.durationSeconds > 0 &&
      callLog.recordingUrl
    ) {
      void this.enqueuePostCallJob(callLog._id.toString());
    }

    return out;
  }

  /**
   * Stores captured WebRTC call audio in Cloudinary (`leadsetu/{tenantId}/whatsapp-calls`),
   * attaches `recordingUrl` to `WhatsappCallLog`, and enqueues post-call Whisper Hinglish AI job.
   */
  async uploadCallRecording(
    auth: InboxAuthContext,
    callId: string,
    dto: UploadWhatsappCallRecordingDto,
  ) {
    if (!dto.audioDataUrl || !dto.audioDataUrl.trim()) {
      throw new BadRequestException('audioDataUrl is required.');
    }

    const callLog = await this.resolveCallLogForTenant(auth.tenantId, callId);
    const recordingUrl = await uploadToCloudinary(dto.audioDataUrl, {
      folder: `leadsetu/${auth.tenantId}/whatsapp-calls`,
      publicId: `wa_call_${callLog._id.toString()}`,
      resourceType: 'auto',
    });

    callLog.recordingUrl = recordingUrl;
    if (
      typeof dto.durationSeconds === 'number' &&
      dto.durationSeconds > 0 &&
      callLog.durationSeconds === 0
    ) {
      const billing = this.computePulseBilling(
        callLog.direction,
        dto.durationSeconds,
      );
      callLog.durationSeconds = billing.durationSeconds;
      callLog.billedPulses = billing.billedPulses;
      callLog.costInr = billing.costInr;
    }
    await callLog.save();

    const out = this.toCallLogDto(callLog, auth.role);
    this.inboxGateway.emitWhatsappCallStatusUpdated(auth.tenantId, out);

    void this.enqueuePostCallJob(callLog._id.toString());
    return out;
  }

  async triggerPostCallAi(
    auth: InboxAuthContext,
    callId: string,
    body?: { transcript?: string },
  ) {
    const callLog = await this.resolveCallLogForTenant(auth.tenantId, callId);
    const updated = await this.runPostCallAiJob({
      callId: callLog._id.toString(),
      transcript: body?.transcript,
      actorRole: auth.role,
    });
    return updated || this.toCallLogDto(callLog, auth.role);
  }

  async enqueuePostCallJob(
    callId: string,
    opts?: { transcript?: string },
  ): Promise<void> {
    if (!callId) return;
    if (this.postprocessQueue) {
      try {
        await Promise.race([
          this.postprocessQueue.add(
            'analyze',
            { callId, ...(opts?.transcript ? { transcript: opts.transcript } : {}) },
            {
              attempts: 3,
              backoff: { type: 'exponential', delay: 2000 },
              removeOnComplete: true,
            },
          ),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Bull queue enqueue timeout')), 1500),
          ),
        ]);
        return;
      } catch (err) {
        this.logger.warn(
          `Bull queue unavailable (${err instanceof Error ? err.message : 'redis offline'}); running post-call AI job inline.`,
        );
      }
    }

    void this.runPostCallAiJob({ callId, transcript: opts?.transcript }).catch(
      (err) => {
        this.logger.warn(
          `Inline post-call AI job failed (${callId}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      },
    );
  }

  async runPostCallAiJob(params: {
    callId: string;
    transcript?: string;
    actorRole?: string;
  }): Promise<Record<string, unknown> | null> {
    if (!params?.callId || !Types.ObjectId.isValid(params.callId)) {
      return null;
    }
    const callLog = await this.callLogModel.findById(params.callId).exec();
    if (!callLog) return null;

    const lead = callLog.leadId
      ? await this.leadModel.findById(callLog.leadId).exec()
      : null;

    const userId =
      callLog.agentUserId?.toString() ||
      (
        await this.userModel
          .findOne({ tenantId: callLog.tenantId })
          .select('_id')
          .lean()
          .exec()
      )?._id?.toString() ||
      callLog.tenantId.toString();

    const transcriptInput = String(
      params.transcript || callLog.transcript || '',
    ).trim();

    let transcript = transcriptInput;
    let aiSummary = '';
    let bantUpdates: Record<string, unknown> = {};

    if (this.aiBridgeService) {
      const aiRes = await this.aiBridgeService.processWhatsappCallAudio({
        tenantId: callLog.tenantId.toString(),
        userId,
        userRole: params.actorRole || 'agent',
        context: {
          ...(callLog.recordingUrl
            ? { recordingUrl: callLog.recordingUrl }
            : {}),
          ...(transcriptInput ? { transcript: transcriptInput } : {}),
          buyerName: lead?.name || 'Buyer',
          company: lead?.company || '',
          agentName: callLog.agentName || 'Sales Rep',
          direction: callLog.direction,
          durationSeconds: callLog.durationSeconds,
        },
      });

      const structured = aiRes?.structured;
      if (structured) {
        transcript = String(structured.transcript || transcript || '').trim();
        aiSummary = String(
          structured.aiSummary ||
            (Array.isArray(structured.summaryBullets)
              ? structured.summaryBullets.map((b) => `• ${b}`).join('\n')
              : aiRes.result || ''),
        ).trim();
        bantUpdates = {
          ...(structured.bantUpdates || {}),
          languageDetected: structured.languageDetected || 'hinglish',
          sttProvider: structured.sttProvider || 'openai-whisper',
          summaryBullets: Array.isArray(structured.summaryBullets)
            ? structured.summaryBullets
            : [],
        };
      }
    }

    if (!aiSummary) {
      const who = lead?.name || 'Buyer';
      const bullets = [
        `${callLog.direction === 'inbound' ? 'Inbound' : 'Outbound'} WhatsApp voice call with ${who} (${callLog.durationSeconds}s).`,
        callLog.recordingUrl
          ? 'Call audio saved securely on Cloudinary for playback & QA.'
          : 'Call logged directly in CRM inbox timeline.',
        'Schedule follow-up quotation/dispatch confirmation on WhatsApp.',
      ];
      transcript =
        transcript ||
        `[${callLog.direction} WhatsApp call with ${who}, ${callLog.durationSeconds}s]`;
      aiSummary = bullets.map((b) => `• ${b}`).join('\n');
      bantUpdates = {
        budget: null,
        authority: who,
        need: null,
        timeline: null,
        nextFollowUpDate: null,
        sentiment: 'neutral',
        objections: [],
        commitments: [],
        summaryBullets: bullets,
        sttProvider: 'fallback',
      };
    }

    callLog.transcript = transcript;
    callLog.aiSummary = aiSummary;
    callLog.bantUpdates = bantUpdates;
    await callLog.save();

    if (lead) {
      const nextFollowUpDate =
        typeof bantUpdates.nextFollowUpDate === 'string' &&
        bantUpdates.nextFollowUpDate.trim()
          ? bantUpdates.nextFollowUpDate.trim()
          : '';
      if (nextFollowUpDate) {
        lead.nextCallRetryAt = nextFollowUpDate;
        lead.aiNextAction = `Follow up on ${nextFollowUpDate}${
          typeof bantUpdates.need === 'string' && bantUpdates.need
            ? ` — ${bantUpdates.need}`
            : ''
        }`;
      }
      lead.aiSummary = aiSummary;
      lead.lastCalledAt = new Date().toISOString();
      lead.activities = [
        ...(Array.isArray(lead.activities) ? lead.activities : []),
        {
          id: randomBytes(6).toString('hex'),
          type: 'whatsapp',
          description: `WhatsApp Call AI Summary (${callLog.durationSeconds}s): ${aiSummary.replace(/\n/g, ' ')}`,
          authorName: callLog.agentName || 'SetuAI Call Intelligence',
          createdAt: new Date().toISOString(),
        },
      ];
      await lead.save();
    }

    const dtoOut = this.toCallLogDto(
      callLog,
      params.actorRole || 'agent',
      lead,
    );
    this.inboxGateway.emitWhatsappCallStatusUpdated(
      callLog.tenantId.toString(),
      dtoOut,
    );
    return dtoOut;
  }

  async listCallLogs(
    auth: InboxAuthContext,
    filters?: { leadId?: string; conversationId?: string; limit?: number },
  ) {
    const query: Record<string, unknown> = {
      tenantId: new Types.ObjectId(auth.tenantId),
    };
    if (filters?.leadId && Types.ObjectId.isValid(filters.leadId)) {
      query.leadId = new Types.ObjectId(filters.leadId);
    }
    if (
      filters?.conversationId &&
      Types.ObjectId.isValid(filters.conversationId)
    ) {
      query.conversationId = new Types.ObjectId(filters.conversationId);
    }

    const limit = Math.min(100, Math.max(1, Number(filters?.limit || 25)));
    const docs = await this.callLogModel
      .find(query)
      .sort({ createdAt: -1 })
      .limit(limit)
      .exec();

    return docs.map((d) => this.toCallLogDto(d, auth.role));
  }

  /**
   * Webhook handler for Meta `value.calls` events (`connect`, `terminate`, status updates)
   */
  async handleMetaCallsWebhook(params: {
    tenant: TenantDocument;
    phoneNumberId: string;
    calls: Array<Record<string, unknown>>;
    contactsMeta?: Array<{ wa_id?: string; profile?: { name?: string } }>;
  }): Promise<number> {
    let processed = 0;

    for (const rawCall of params.calls) {
      const metaCallId = String(rawCall.id || rawCall.call_id || '').trim();
      const event = String(
        rawCall.event || rawCall.status || '',
      ).toLowerCase();
      const directionRaw = String(
        rawCall.direction || 'USER_INITIATED',
      ).toUpperCase();
      const isInbound = !directionRaw.includes('BUSINESS');
      const fromPhone = String(
        rawCall.from || rawCall.to || '',
      ).trim();
      const normalizedPhone = this.normalizeE164Phone(fromPhone);
      const session = (rawCall.session || {}) as {
        sdp?: string;
        sdp_type?: string;
      };

      if (!metaCallId) continue;

      if (event === 'connect' || event === 'ringing') {
        if (!normalizedPhone) continue;

        const last10 = extractLast10Digits(normalizedPhone);
        const [leadCandidates, convCandidates] = await Promise.all([
          this.leadModel
            .find({ tenantId: params.tenant._id, phone: { $ne: '' } })
            .sort({ updatedAt: -1 })
            .exec(),
          this.convModel
            .find({
              tenantId: params.tenant._id,
              channel: 'whatsapp',
              phone: { $ne: '' },
            })
            .sort({ updatedAt: -1 })
            .exec(),
        ]);

        const matchedLead =
          leadCandidates.find(
            (l) =>
              last10.length === 10 &&
              extractLast10Digits(l.phone || '') === last10,
          ) || null;
        const matchedConv =
          convCandidates.find(
            (c) =>
              last10.length === 10 &&
              extractLast10Digits(c.phone || '') === last10,
          ) || null;

        const now = new Date();
        const callLog = await this.callLogModel
          .findOneAndUpdate(
            { metaCallId },
            {
              $setOnInsert: {
                tenantId: params.tenant._id,
                leadId: matchedLead?._id,
                conversationId: matchedConv?._id,
                wabaPhoneNumberId: params.phoneNumberId,
                normalizedPhone,
                metaCallId,
                direction: isInbound ? 'inbound' : 'outbound',
                status: 'ringing',
                durationSeconds: 0,
                billedPulses: 0,
                costInr: 0,
                startedAt: now,
              },
            },
            { upsert: true, new: true },
          )
          .exec();

        // Auto-grant 7-day callback permission on inbound customer call
        if (isInbound) {
          await this.grantSevenDayPermission({
            tenantId: params.tenant._id,
            wabaPhoneNumberId: params.phoneNumberId,
            normalizedPhone,
            leadId: matchedLead?._id,
            conversationId: matchedConv?._id,
            source: 'inbound_call',
          });
        }

        const callerName =
          matchedLead?.name ||
          matchedConv?.contactName ||
          params.contactsMeta?.[0]?.profile?.name ||
          'WhatsApp Caller';

        this.inboxGateway.emitIncomingWhatsappCall(
          params.tenant._id.toString(),
          {
            callId: callLog._id.toString(),
            metaCallId,
            direction: callLog.direction,
            status: callLog.status,
            leadId: matchedLead?._id.toString() || '',
            conversationId: matchedConv?._id.toString() || '',
            callerName,
            company: matchedLead?.company || matchedConv?.company || '',
            maskedPhone: maskPhoneNumber(
              normalizeIndianPhone(normalizedPhone) || normalizedPhone,
            ),
            sdpOffer: session.sdp || '',
            iceServers: this.getWebRtcIceServers(),
            startedAt: now.toISOString(),
          },
        );
        processed++;
        continue;
      }

      if (
        ['terminate', 'completed', 'missed', 'rejected', 'failed'].includes(
          event,
        )
      ) {
        const callLog = await this.callLogModel
          .findOne({ metaCallId, tenantId: params.tenant._id })
          .exec();
        if (!callLog) continue;

        const now = new Date();
        const rawDuration = Number(
          rawCall.duration ?? rawCall.duration_seconds ?? 0,
        );
        const measuredDuration =
          rawDuration > 0
            ? rawDuration
            : callLog.connectedAt
              ? Math.max(
                  1,
                  Math.round(
                    (now.getTime() - new Date(callLog.connectedAt).getTime()) /
                      1000,
                  ),
                )
              : callLog.durationSeconds;

        const billing = this.computePulseBilling(
          callLog.direction,
          measuredDuration,
        );

        let nextStatus: WhatsappCallStatus = 'completed';
        if (event === 'rejected') nextStatus = 'rejected';
        else if (event === 'failed') nextStatus = 'failed';
        else if (billing.durationSeconds <= 0) nextStatus = 'missed';

        callLog.status = nextStatus;
        callLog.durationSeconds = billing.durationSeconds;
        callLog.billedPulses = billing.billedPulses;
        callLog.costInr = billing.costInr;
        callLog.endedAt = now;
        await callLog.save();

        if (callLog.direction === 'outbound' && billing.durationSeconds > 0) {
          await this.permissionModel
            .updateOne(
              {
                tenantId: callLog.tenantId,
                wabaPhoneNumberId: callLog.wabaPhoneNumberId,
                normalizedPhone: callLog.normalizedPhone,
              },
              { $inc: { connectedCallsUsed: 1 } },
            )
            .exec();

          await this.deductOutboundCallCost(
            callLog,
            billing.costInr,
            billing.durationSeconds,
          );
        }

        const out = this.toCallLogDto(callLog, 'agent');
        this.inboxGateway.emitWhatsappCallStatusUpdated(
          params.tenant._id.toString(),
          out,
        );
        if (billing.durationSeconds > 0) {
          void this.enqueuePostCallJob(callLog._id.toString());
        }
        processed++;
      }
    }

    return processed;
  }

  /**
   * Webhook handler for Meta `interactive.type === 'call_permission_reply'`
   */
  async handleMetaPermissionReplyWebhook(params: {
    tenant: TenantDocument;
    phoneNumberId: string;
    fromPhone: string;
    response: 'accept' | 'reject';
    leadId?: Types.ObjectId;
    conversationId?: Types.ObjectId;
  }): Promise<WhatsappCallPermissionDocument | null> {
    const normalizedPhone = this.normalizeE164Phone(params.fromPhone);
    if (!normalizedPhone) return null;

    if (params.response === 'accept') {
      return this.grantSevenDayPermission({
        tenantId: params.tenant._id,
        wabaPhoneNumberId: params.phoneNumberId,
        normalizedPhone,
        leadId: params.leadId,
        conversationId: params.conversationId,
        source: 'permission_reply_accept',
      });
    }

    const now = new Date();
    const updated = await this.permissionModel
      .findOneAndUpdate(
        {
          tenantId: params.tenant._id,
          wabaPhoneNumberId: params.phoneNumberId,
          normalizedPhone,
        },
        {
          $set: {
            status: 'revoked',
            ...(params.leadId ? { leadId: params.leadId } : {}),
            ...(params.conversationId
              ? { conversationId: params.conversationId }
              : {}),
            lastResponseSource: 'permission_reply_reject',
          },
        },
        { upsert: true, new: true },
      )
      .exec();

    const summary = this.computePermissionSummary(updated, now);
    this.inboxGateway.emitWhatsappPermissionUpdated(
      params.tenant._id.toString(),
      {
        leadId: params.leadId?.toString() || updated.leadId?.toString() || '',
        conversationId:
          params.conversationId?.toString() ||
          updated.conversationId?.toString() ||
          '',
        wabaPhoneNumberId: params.phoneNumberId,
        ...summary,
        istWindow: this.getIstCallingWindow(now),
      },
    );

    return updated;
  }

  private toCallLogDto(
    doc: WhatsappCallLogDocument,
    role?: string,
    lead?: LeadDocument | null,
  ): Record<string, unknown> {
    const raw = doc.toObject() as unknown as Record<string, unknown> & {
      createdAt?: Date;
      updatedAt?: Date;
    };
    return {
      id: doc._id.toString(),
      callId: doc._id.toString(),
      tenantId: doc.tenantId.toString(),
      leadId: doc.leadId?.toString() || '',
      leadName: lead?.name || '',
      conversationId: doc.conversationId?.toString() || '',
      wabaPhoneNumberId: doc.wabaPhoneNumberId,
      displayPhone: this.formatPhoneForRole(doc.normalizedPhone, role),
      metaCallId: doc.metaCallId || '',
      direction: doc.direction,
      status: doc.status,
      durationSeconds: doc.durationSeconds || 0,
      billedPulses: doc.billedPulses || 0,
      costInr: doc.costInr || 0,
      recordingUrl: doc.recordingUrl || '',
      transcript: doc.transcript || '',
      aiSummary: doc.aiSummary || '',
      bantUpdates: doc.bantUpdates || {},
      agentUserId: doc.agentUserId?.toString() || '',
      agentName: doc.agentName || '',
      startedAt: doc.startedAt ? new Date(doc.startedAt).toISOString() : null,
      connectedAt: doc.connectedAt
        ? new Date(doc.connectedAt).toISOString()
        : null,
      endedAt: doc.endedAt ? new Date(doc.endedAt).toISOString() : null,
      createdAt: raw.createdAt
        ? new Date(raw.createdAt).toISOString()
        : new Date().toISOString(),
    };
  }
}
