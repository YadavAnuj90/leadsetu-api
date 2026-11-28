import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  MethodNotAllowedException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import { randomBytes } from 'crypto';
import { Model, Types } from 'mongoose';
import {
  UniversalWebhook,
  UniversalWebhookAction,
  UniversalWebhookDocument,
  UniversalWebhookFieldMapping,
  UniversalWebhookMethod,
  UniversalWebhookStatus,
  UniversalDuplicateStrategy,
} from './schemas/universal-webhook.schema';
import {
  WebhookDeliveryLog,
  WebhookDeliveryLogDocument,
} from './schemas/webhook-delivery-log.schema';
import { UniversalWebhookProcessor } from './universal-webhook.processor';
import {
  SUPPORTED_UNIVERSAL_WEBHOOK_ACTIONS,
  autoSuggestFieldMappings,
  decryptWebhookSecret,
  encryptWebhookSecret,
  flattenWebhookPayload,
  timingSafeMatchSecret,
} from './universal-webhooks.util';

export interface WebhookAuthContext {
  userId: string;
  tenantId: string;
  email: string;
  role: string;
}

interface CapturedSampleRecord {
  webhookId: string;
  method: string;
  rawPayload: unknown;
  flattenedPayload: Record<string, string>;
  suggestedMappings: UniversalWebhookFieldMapping[];
  capturedAt: string;
  expiresAtMs: number;
}

@Injectable()
export class UniversalWebhooksService {
  /** Redis-equivalent 10-minute TTL sample-listener store (`webhook:listen:{webhookId}`) */
  private readonly listeningWindows = new Map<string, number>();
  /** Redis-equivalent 10-minute TTL captured sample store (`webhook:sample:{webhookId}`) */
  private readonly capturedSamples = new Map<string, CapturedSampleRecord>();
  /** Sliding-window 60 req/min rate limiter per `webhookId` */
  private readonly rateLimitBuckets = new Map<string, number[]>();

  constructor(
    @InjectModel(UniversalWebhook.name)
    private readonly webhookModel: Model<UniversalWebhookDocument>,
    @InjectModel(WebhookDeliveryLog.name)
    private readonly logModel: Model<WebhookDeliveryLogDocument>,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly processor: UniversalWebhookProcessor,
  ) {}

  async verifyAuth(authHeader?: string): Promise<WebhookAuthContext> {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Authorization token is required.');
    }
    const token = authHeader.slice(7).trim();
    const secret =
      this.configService.get<string>('JWT_SECRET') ||
      'leadsetu_super_secret_access_key_2026';
    try {
      const payload = await this.jwtService.verifyAsync<{
        sub: string;
        tenantId: string;
        email: string;
        role?: string;
      }>(token, { secret });
      return {
        userId: payload.sub,
        tenantId: payload.tenantId,
        email: payload.email,
        role: payload.role || 'owner',
      };
    } catch {
      throw new UnauthorizedException('Invalid or expired session.');
    }
  }

  private getEncryptionKey(): string {
    return (
      this.configService.get<string>('META_TOKEN_ENCRYPTION_KEY') ||
      process.env.META_TOKEN_ENCRYPTION_KEY ||
      this.configService.get<string>('JWT_SECRET') ||
      ''
    ).trim();
  }

  private resolveHttpsPublicBase(): string {
    const raw = (
      this.configService.get<string>('PUBLIC_WEBHOOK_BASE_URL') ||
      process.env.PUBLIC_WEBHOOK_BASE_URL ||
      'https://api.leadsetu.in/v1'
    )
      .trim()
      .replace(/\/+$/, '');
    return raw.startsWith('http://') ? raw.replace(/^http:\/\//, 'https://') : raw;
  }

  private isListeningActive(webhookId: string, status: string): boolean {
    const expiresAt = this.listeningWindows.get(webhookId);
    if (expiresAt && Date.now() < expiresAt) return true;
    if (expiresAt && Date.now() >= expiresAt) {
      this.listeningWindows.delete(webhookId);
    }
    return status === 'listening';
  }

  private toWebhookDto(doc: UniversalWebhookDocument) {
    const secretToken = decryptWebhookSecret({
      encryptedSecretToken: doc.encryptedSecretToken,
      tokenIv: doc.tokenIv,
      tokenAuthTag: doc.tokenAuthTag,
      encryptionKey: this.getEncryptionKey(),
    });
    const endpointPath = `/v1/webhooks/in/${doc.webhookId}/${secretToken}`;
    const httpsEndpointUrl = `${this.resolveHttpsPublicBase().replace(/\/v1$/, '')}${endpointPath}`;
    const listeningActive = this.isListeningActive(doc.webhookId, doc.status);

    return {
      id: String(doc._id),
      tenantId: String(doc.tenantId),
      name: doc.name,
      webhookId: doc.webhookId,
      secretToken,
      endpointPath,
      httpsEndpointUrl,
      allowedMethod: doc.allowedMethod,
      targetAction: doc.targetAction,
      status: listeningActive ? 'listening' : doc.status,
      duplicateStrategy: doc.duplicateStrategy || 'fill_empty',
      triggerWhatsappOnNew: Boolean(doc.triggerWhatsappOnNew),
      triggerWhatsappOnRepeat: Boolean(doc.triggerWhatsappOnRepeat),
      whatsappTemplateId: doc.whatsappTemplateId || '',
      defaultAssigneeId: doc.defaultAssigneeId
        ? String(doc.defaultAssigneeId)
        : '',
      optionalHeaderSecret: doc.optionalHeaderSecret || '',
      fieldMappings: Array.isArray(doc.fieldMappings) ? doc.fieldMappings : [],
      stats: {
        created: Number(doc.stats?.created || 0),
        updated: Number(doc.stats?.updated || 0),
        failed: Number(doc.stats?.failed || 0),
      },
      lastReceivedAt: doc.lastReceivedAt
        ? new Date(doc.lastReceivedAt).toISOString()
        : null,
    };
  }

  getSupportedActions() {
    return {
      actions: SUPPORTED_UNIVERSAL_WEBHOOK_ACTIONS,
    };
  }

  async createWebhook(
    auth: WebhookAuthContext,
    dto: {
      name: string;
      allowedMethod?: UniversalWebhookMethod;
      targetAction?: UniversalWebhookAction;
      duplicateStrategy?: UniversalDuplicateStrategy;
      triggerWhatsappOnNew?: boolean;
      triggerWhatsappOnRepeat?: boolean;
      whatsappTemplateId?: string;
      defaultAssigneeId?: string;
      optionalHeaderSecret?: string;
      fieldMappings?: UniversalWebhookFieldMapping[];
    },
  ) {
    const name = String(dto?.name || '').trim();
    if (!name) {
      throw new BadRequestException('Webhook name is required.');
    }

    const webhookId = `whk_${randomBytes(8).toString('hex')}`;
    const plainSecret = `sec_${randomBytes(16).toString('hex')}`;
    const encrypted = encryptWebhookSecret(plainSecret, this.getEncryptionKey());

    const created = await this.webhookModel.create({
      tenantId: new Types.ObjectId(auth.tenantId),
      name,
      webhookId,
      encryptedSecretToken: encrypted.encryptedSecretToken,
      tokenIv: encrypted.tokenIv,
      tokenAuthTag: encrypted.tokenAuthTag,
      allowedMethod: dto.allowedMethod === 'GET' ? 'GET' : 'POST',
      targetAction: dto.targetAction || 'create_lead',
      status: 'listening',
      duplicateStrategy: dto.duplicateStrategy || 'fill_empty',
      triggerWhatsappOnNew: Boolean(dto.triggerWhatsappOnNew),
      triggerWhatsappOnRepeat: Boolean(dto.triggerWhatsappOnRepeat),
      whatsappTemplateId: String(dto.whatsappTemplateId || '').trim(),
      defaultAssigneeId:
        dto.defaultAssigneeId && Types.ObjectId.isValid(dto.defaultAssigneeId)
          ? new Types.ObjectId(dto.defaultAssigneeId)
          : null,
      optionalHeaderSecret: String(dto.optionalHeaderSecret || '').trim(),
      fieldMappings: Array.isArray(dto.fieldMappings) ? dto.fieldMappings : [],
      stats: { created: 0, updated: 0, failed: 0 },
    });

    // Enable 10-minute sample listener window (`webhook:listen:{webhookId}`)
    this.listeningWindows.set(webhookId, Date.now() + 10 * 60_000);

    return this.toWebhookDto(created);
  }

  async listWebhooks(auth: WebhookAuthContext) {
    const docs = await this.webhookModel
      .find({ tenantId: new Types.ObjectId(auth.tenantId) })
      .sort({ createdAt: -1 })
      .exec();
    return {
      webhooks: docs.map((d) => this.toWebhookDto(d)),
    };
  }

  private async findTenantWebhook(tenantId: string, idOrWebhookId: string) {
    const tenantOid = new Types.ObjectId(tenantId);
    const filter = Types.ObjectId.isValid(idOrWebhookId)
      ? {
          tenantId: tenantOid,
          $or: [
            { _id: new Types.ObjectId(idOrWebhookId) },
            { webhookId: idOrWebhookId },
          ],
        }
      : { tenantId: tenantOid, webhookId: idOrWebhookId };
    const doc = await this.webhookModel.findOne(filter).exec();
    if (!doc) throw new NotFoundException('Universal webhook not found.');
    return doc;
  }

  async getWebhookById(auth: WebhookAuthContext, id: string) {
    const doc = await this.findTenantWebhook(auth.tenantId, id);
    return this.toWebhookDto(doc);
  }

  async updateWebhook(
    auth: WebhookAuthContext,
    id: string,
    dto: Partial<{
      name: string;
      allowedMethod: UniversalWebhookMethod;
      targetAction: UniversalWebhookAction;
      status: UniversalWebhookStatus;
      duplicateStrategy: UniversalDuplicateStrategy;
      triggerWhatsappOnNew: boolean;
      triggerWhatsappOnRepeat: boolean;
      whatsappTemplateId: string;
      defaultAssigneeId: string;
      optionalHeaderSecret: string;
      fieldMappings: UniversalWebhookFieldMapping[];
    }>,
  ) {
    const doc = await this.findTenantWebhook(auth.tenantId, id);

    if (dto.name !== undefined && dto.name.trim()) doc.name = dto.name.trim();
    if (dto.allowedMethod === 'GET' || dto.allowedMethod === 'POST') {
      doc.allowedMethod = dto.allowedMethod;
    }
    if (dto.targetAction) doc.targetAction = dto.targetAction;
    if (dto.status) {
      doc.status = dto.status;
      if (dto.status === 'listening') {
        this.listeningWindows.set(doc.webhookId, Date.now() + 10 * 60_000);
      } else {
        this.listeningWindows.delete(doc.webhookId);
      }
    }
    if (dto.duplicateStrategy) doc.duplicateStrategy = dto.duplicateStrategy;
    if (dto.triggerWhatsappOnNew !== undefined) {
      doc.triggerWhatsappOnNew = Boolean(dto.triggerWhatsappOnNew);
    }
    if (dto.triggerWhatsappOnRepeat !== undefined) {
      doc.triggerWhatsappOnRepeat = Boolean(dto.triggerWhatsappOnRepeat);
    }
    if (dto.whatsappTemplateId !== undefined) {
      doc.whatsappTemplateId = String(dto.whatsappTemplateId).trim();
    }
    if (dto.defaultAssigneeId !== undefined) {
      doc.defaultAssigneeId =
        dto.defaultAssigneeId && Types.ObjectId.isValid(dto.defaultAssigneeId)
          ? new Types.ObjectId(dto.defaultAssigneeId)
          : null;
    }
    if (dto.optionalHeaderSecret !== undefined) {
      doc.optionalHeaderSecret = String(dto.optionalHeaderSecret).trim();
    }
    if (Array.isArray(dto.fieldMappings)) {
      doc.fieldMappings = dto.fieldMappings
        .map((m) => ({
          sourceKey: String(m.sourceKey || '').trim(),
          targetField: String(m.targetField || '').trim(),
        }))
        .filter((m) => Boolean(m.sourceKey && m.targetField));
      // When user saves fieldMappings while in listening mode, activate automatically unless explicitly kept listening
      if (doc.status === 'listening' && dto.status === undefined) {
        doc.status = 'active';
        this.listeningWindows.delete(doc.webhookId);
      }
    }

    doc.markModified('fieldMappings');
    await doc.save();
    return this.toWebhookDto(doc);
  }

  async startSampleListening(auth: WebhookAuthContext, id: string) {
    const doc = await this.findTenantWebhook(auth.tenantId, id);
    doc.status = 'listening';
    await doc.save();
    this.listeningWindows.set(doc.webhookId, Date.now() + 10 * 60_000);
    this.capturedSamples.delete(doc.webhookId);
    return {
      ...this.toWebhookDto(doc),
      listeningExpiresInSeconds: 600,
    };
  }

  async getCapturedSample(auth: WebhookAuthContext, id: string) {
    const doc = await this.findTenantWebhook(auth.tenantId, id);
    const cached = this.capturedSamples.get(doc.webhookId);
    if (cached && Date.now() < cached.expiresAtMs) {
      return {
        hasSample: true,
        ...cached,
      };
    }

    // Fallback to most recent delivery log if Redis/memory sample expired
    const latestLog = await this.logModel
      .findOne({ webhookId: doc.webhookId })
      .sort({ createdAt: -1 })
      .lean()
      .exec();

    if (!latestLog) {
      return {
        hasSample: false,
        webhookId: doc.webhookId,
        flattenedPayload: {},
        suggestedMappings: [],
      };
    }

    const flat = (latestLog.flattenedPayload || {}) as Record<string, string>;
    return {
      hasSample: true,
      webhookId: doc.webhookId,
      method: latestLog.method,
      rawPayload: latestLog.rawPayload,
      flattenedPayload: flat,
      suggestedMappings: autoSuggestFieldMappings(flat, doc.targetAction),
      capturedAt: new Date(latestLog.createdAt).toISOString(),
    };
  }

  async rotateSecret(auth: WebhookAuthContext, id: string) {
    const doc = await this.findTenantWebhook(auth.tenantId, id);
    const plainSecret = `sec_${randomBytes(16).toString('hex')}`;
    const encrypted = encryptWebhookSecret(plainSecret, this.getEncryptionKey());
    doc.encryptedSecretToken = encrypted.encryptedSecretToken;
    doc.tokenIv = encrypted.tokenIv;
    doc.tokenAuthTag = encrypted.tokenAuthTag;
    await doc.save();
    return this.toWebhookDto(doc);
  }

  async listDeliveryLogs(auth: WebhookAuthContext, id: string) {
    const doc = await this.findTenantWebhook(auth.tenantId, id);
    const logs = await this.logModel
      .find({ webhookId: doc.webhookId, tenantId: doc.tenantId })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean()
      .exec();

    return {
      webhookId: doc.webhookId,
      logs: logs.map((l) => ({
        id: String(l._id),
        webhookId: l.webhookId,
        method: l.method,
        rawPayload: l.rawPayload,
        flattenedPayload: l.flattenedPayload || {},
        normalizedPhone: l.normalizedPhone || '',
        outcome: l.outcome,
        matchedRecordId: l.matchedRecordId ? String(l.matchedRecordId) : '',
        matchedEntityType: l.matchedEntityType || '',
        errorReason: l.errorReason || '',
        createdAt: new Date(l.createdAt).toISOString(),
      })),
    };
  }

  async replayDeliveryLog(
    auth: WebhookAuthContext,
    id: string,
    logId: string,
  ) {
    const doc = await this.findTenantWebhook(auth.tenantId, id);
    if (!Types.ObjectId.isValid(logId)) {
      throw new BadRequestException('Invalid log ID.');
    }
    const log = await this.logModel
      .findOne({
        _id: new Types.ObjectId(logId),
        webhookId: doc.webhookId,
        tenantId: doc.tenantId,
      })
      .lean()
      .exec();
    if (!log) {
      throw new NotFoundException('Webhook delivery log not found.');
    }

    const result = await this.processor.processWebhookJob({
      webhookId: doc.webhookId,
      method: log.method,
      rawPayload: log.rawPayload,
      flattenedPayload: (log.flattenedPayload || {}) as Record<string, string>,
    });

    return {
      replayed: true,
      logId,
      ...result,
    };
  }

  private assertRateLimit(webhookId: string) {
    const now = Date.now();
    const windowStart = now - 60_000;
    const prev = (this.rateLimitBuckets.get(webhookId) || []).filter(
      (t) => t > windowStart,
    );
    if (prev.length >= 60) {
      throw new HttpException(
        'Rate limit exceeded (60 requests/min per webhookId).',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    prev.push(now);
    this.rateLimitBuckets.set(webhookId, prev);
  }

  /**
   * Public receiver handler for `GET` and `POST /webhooks/in/:webhookId/:secretToken`
   */
  async handleIncomingWebhook(params: {
    webhookId: string;
    secretToken: string;
    method: string;
    headerSecret?: string;
    payload: Record<string, unknown>;
  }) {
    const cleanId = String(params.webhookId || '').trim();
    this.assertRateLimit(cleanId);

    const webhook = await this.webhookModel
      .findOne({ webhookId: cleanId })
      .exec();
    if (!webhook) {
      throw new NotFoundException('Webhook endpoint not found.');
    }

    const expectedSecret = decryptWebhookSecret({
      encryptedSecretToken: webhook.encryptedSecretToken,
      tokenIv: webhook.tokenIv,
      tokenAuthTag: webhook.tokenAuthTag,
      encryptionKey: this.getEncryptionKey(),
    });

    if (!timingSafeMatchSecret(expectedSecret, params.secretToken)) {
      throw new UnauthorizedException('Invalid webhook secret token.');
    }

    if (
      webhook.optionalHeaderSecret &&
      !timingSafeMatchSecret(
        webhook.optionalHeaderSecret,
        String(params.headerSecret || ''),
      )
    ) {
      throw new UnauthorizedException('Invalid X-Webhook-Secret header.');
    }

    const reqMethod = String(params.method || 'POST').toUpperCase();
    if (reqMethod !== webhook.allowedMethod) {
      throw new MethodNotAllowedException(
        `Webhook "${webhook.name}" only accepts ${webhook.allowedMethod} requests.`,
      );
    }

    const flattenedPayload = flattenWebhookPayload(params.payload || {});

    // 1. Sample Capture Mode (`listening` status or active 10-min Redis listener)
    if (this.isListeningActive(webhook.webhookId, webhook.status)) {
      const suggestedMappings = autoSuggestFieldMappings(
        flattenedPayload,
        webhook.targetAction,
      );
      this.capturedSamples.set(webhook.webhookId, {
        webhookId: webhook.webhookId,
        method: reqMethod,
        rawPayload: params.payload || {},
        flattenedPayload,
        suggestedMappings,
        capturedAt: new Date().toISOString(),
        expiresAtMs: Date.now() + 600_000,
      });

      webhook.lastReceivedAt = new Date();
      await webhook.save();

      await this.logModel.create({
        tenantId: webhook.tenantId,
        webhookId: webhook.webhookId,
        method: reqMethod,
        rawPayload: params.payload || {},
        flattenedPayload,
        normalizedPhone: '',
        outcome: 'sample_captured',
        createdAt: new Date(),
      });

      return {
        statusCode: HttpStatus.OK,
        body: {
          ok: true,
          mode: 'sample_captured',
          flattenedKeys: Object.keys(flattenedPayload),
          suggestedMappings,
        },
      };
    }

    // 2. Paused Mode
    if (webhook.status === 'paused') {
      return {
        statusCode: HttpStatus.OK,
        body: {
          ok: true,
          ignored: 'paused',
        },
      };
    }

    // 3. Live Ingestion Mode -> push to BullMQ / UniversalWebhookProcessor queue & return 202 Accepted
    this.processor.enqueueJob({
      webhookId: webhook.webhookId,
      method: reqMethod,
      rawPayload: params.payload || {},
      flattenedPayload,
    });

    return {
      statusCode: HttpStatus.ACCEPTED,
      body: {
        ok: true,
        queued: true,
      },
    };
  }
}
