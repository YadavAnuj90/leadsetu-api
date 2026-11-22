import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import { randomBytes } from 'crypto';
import { Model, Types } from 'mongoose';
import { AuditService } from '../audit/audit.module';
import { uploadToCloudinary } from '../auth/cloudinary.util';
import {
  decryptSecret,
  encryptSecret,
  maskPhoneNumber,
  maskSecret,
  normalizeIndianPhone,
  resolveOwnerScopeFilter,
} from '../auth/identity.util';
import {
  Tenant,
  TenantDocument,
  WhatsAppCloudConfig,
} from '../auth/schemas/tenant.schema';
import { User, UserDocument } from '../auth/schemas/user.schema';
import { Contact, ContactDocument } from '../contacts/contacts.service';
import { Deal, DealDocument } from '../deals/schemas/deal.schema';
import { Lead, LeadDocument } from '../leads/schemas/lead.schema';
import {
  DEFAULT_PLATFORM_WHATSAPP_PROVIDER,
  PlatformConfig,
  PlatformConfigDocument,
  PlatformWhatsAppProviderConfig,
} from '../super-admin/schemas/platform-config.schema';
import { SuperAdminService } from '../super-admin/super-admin.service';
import { AiBridgeService } from '../ai-bridge/ai-bridge.service';
import { MetaCapiService } from '../meta-capi/meta-capi.service';
import { Ticket, TicketDocument } from '../tickets/tickets.service';
import { MetaWhatsAppService } from './meta-whatsapp.service';
import {
  buildConciergeFallbackReply,
  extractBuyerSignals,
  isWithinIstBusinessHours,
  normalizeAiAgentPolicy,
  type AiActionLogItem,
  type AiQualifiedData,
  type AiSalesAgentPolicy,
  type KnowledgeDocBrief,
} from './ai-concierge.util';
import {
  AiKnowledgeCategory,
  AiKnowledgeEntry,
  AiKnowledgeEntryDocument,
} from './schemas/ai-knowledge-entry.schema';
import {
  ChatAttachment,
  ChatMessage,
  ConversationDocument,
  ConversationThread,
  LinkedCrmEntityType,
} from './schemas/conversation.schema';
import {
  WhatsAppTemplate,
  WhatsAppTemplateCategory,
  WhatsAppTemplateDocument,
  WhatsAppTemplateLanguage,
} from './schemas/whatsapp-template.schema';

export interface WhatsAppVariableMeta {
  key: string;
  token: string;
  label: string;
  example: string;
}

export const SUPPORTED_WHATSAPP_VARIABLES: WhatsAppVariableMeta[] = [
  { key: 'buyer_name', token: '{{buyer_name}}', label: 'Buyer Name', example: 'Rajesh Sharma' },
  { key: 'company', token: '{{company}}', label: 'Company Name', example: 'Apex Steel Pvt Ltd' },
  { key: 'deal_value', token: '{{deal_value}}', label: 'Deal / Est. Value', example: '₹2,50,000' },
  { key: 'city', token: '{{city}}', label: 'City', example: 'Delhi-NCR' },
  { key: 'phone', token: '{{phone}}', label: 'Phone Number', example: '+91 98112 45678' },
  { key: 'agent_name', token: '{{agent_name}}', label: 'Your Name (Agent)', example: 'Anuj' },
  { key: 'quote_link', token: '{{quote_link}}', label: 'Quotation Link', example: 'https://leadsetu.in/quote/demo' },
  { key: 'call_link', token: '{{call_link}}', label: 'Click-to-Call Link', example: 'https://leadsetu.in/call/demo' },
];

export const DEFAULT_WHATSAPP_TEMPLATES: Array<{
  name: string;
  category: WhatsAppTemplateCategory;
  language: WhatsAppTemplateLanguage;
  body: string;
}> = [
  {
    name: 'Intro & Inquiry Follow-up',
    category: 'greeting',
    language: 'Hinglish',
    body: 'Namaste {{buyer_name}} ji! This is {{agent_name}} connecting regarding your requirement for {{company}} ({{city}}). When is a good time for a quick chat?',
  },
  {
    name: '18% GST Proforma Quotation',
    category: 'quotation',
    language: 'Hinglish',
    body: 'Namaste {{buyer_name}} ji, sharing the 18% GST proforma quotation & bulk price list for {{company}} (Est. {{deal_value}}). Please review and confirm dispatch quantity.',
  },
  {
    name: '5-Minute Discovery Call',
    category: 'followup',
    language: 'English',
    body: 'Hi {{buyer_name}}, can we schedule a quick 5-minute discovery call for {{company}}? You can also join directly via our voice link: {{call_link}}',
  },
  {
    name: 'Booking Advance / Payment Confirmation',
    category: 'payment',
    language: 'Hinglish',
    body: 'Namaste {{buyer_name}} ji, please share confirmation once the booking advance for {{company}} ({{deal_value}}) is initiated so our dispatch team can block your stock.',
  },
  {
    name: 'Re-engage Dormant Lead',
    category: 'followup',
    language: 'Hinglish',
    body: 'Hello {{buyer_name}} ji, following up on {{company}} requirement in {{city}}. Let us know if you need revised pricing or updated stock availability from {{agent_name}}.',
  },
];

export function extractVariables(body: string): string[] {
  const seen = new Set<string>();
  const regex = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(body || '')) !== null) {
    seen.add(match[1].toLowerCase());
  }
  return Array.from(seen);
}

export function slugifyTemplateName(name: string): string {
  const slug = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return slug || 'custom_template';
}

export function renderTemplateBody(
  body: string,
  vars: Record<string, string>,
): { rendered: string; variables: string[]; unresolvedVariables: string[] } {
  const normalizedVars: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars || {})) {
    normalizedVars[k.toLowerCase()] = String(v ?? '').trim();
  }
  const variables = extractVariables(body);
  const unresolvedSet = new Set<string>();
  const rendered = String(body || '').replace(
    /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g,
    (full, key: string) => {
      const lower = key.toLowerCase();
      const val = normalizedVars[lower];
      if (!val) {
        unresolvedSet.add(lower);
        return full;
      }
      return val;
    },
  );
  return {
    rendered,
    variables,
    unresolvedVariables: Array.from(unresolvedSet),
  };
}

export function extractLast10Digits(phone?: string): string {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

export interface InboxAuthContext {
  userId: string;
  tenantId: string;
  email: string;
  name: string;
  role: string;
}

interface CrmEntitySnapshot {
  entityLabel: string;
  contactName: string;
  company: string;
  phone: string;
  city: string;
  estimatedValue: number;
  aiScore?: number;
}

export interface MetaTemplateSendInput {
  name: string;
  languageCode?: string;
  bodyParams?: string[];
}

export interface SendInboxMessageInput {
  content?: string;
  isAiDrafted?: boolean;
  templateId?: string;
  via?: 'inbox' | 'wa_me';
  logToTimeline?: boolean;
  sendMode?: 'text' | 'meta_template';
  metaTemplate?: MetaTemplateSendInput;
  attachment?: ChatAttachment;
}

export interface StartConversationInput {
  linkedEntityType?: LinkedCrmEntityType;
  linkedEntityId?: string;
  contactName?: string;
  company?: string;
  phone?: string;
  city?: string;
  estimatedValue?: number;
  channel?: 'whatsapp' | 'indiamart' | 'email';
  initialMessage?: string;
  templateId?: string;
  via?: 'inbox' | 'wa_me';
  isAiDrafted?: boolean;
  logToTimeline?: boolean;
  sendMode?: 'text' | 'meta_template';
  metaTemplate?: MetaTemplateSendInput;
  attachment?: ChatAttachment;
}

export interface UpdateWhatsAppConfigInput {
  enabled?: boolean;
  phoneNumberId?: string;
  wabaId?: string;
  accessToken?: string;
  appSecret?: string;
  verifyToken?: string;
  clearAccessToken?: boolean;
  clearAppSecret?: boolean;
}

const DELIVERY_STATUS_RANK: Record<string, number> = {
  sent: 1,
  delivered: 2,
  read: 3,
};

@Injectable()
export class InboxService {
  private realtimeEmitter?: (
    tenantId: string,
    conversation: Record<string, unknown>,
    eventType:
      | 'message.inbound'
      | 'message.outbound'
      | 'message.status'
      | 'conversation.updated',
  ) => void;

  constructor(
    @InjectModel(ConversationThread.name)
    private readonly convModel: Model<ConversationDocument>,
    @InjectModel(WhatsAppTemplate.name)
    private readonly templateModel: Model<WhatsAppTemplateDocument>,
    @InjectModel(Tenant.name)
    private readonly tenantModel: Model<TenantDocument>,
    @InjectModel(PlatformConfig.name)
    private readonly platformConfigModel: Model<PlatformConfigDocument>,
    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>,
    @InjectModel(Lead.name)
    private readonly leadModel: Model<LeadDocument>,
    @InjectModel(Deal.name)
    private readonly dealModel: Model<DealDocument>,
    @InjectModel(Contact.name)
    private readonly contactModel: Model<ContactDocument>,
    @InjectModel(Ticket.name)
    private readonly ticketModel: Model<TicketDocument>,
    @InjectModel(AiKnowledgeEntry.name)
    private readonly kbModel: Model<AiKnowledgeEntryDocument>,
    private readonly metaWhatsAppService: MetaWhatsAppService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    @Optional() private readonly auditService?: AuditService,
    @Optional() private readonly superAdminService?: SuperAdminService,
    @Optional() private readonly aiBridge?: AiBridgeService,
    @Optional() private readonly metaCapiService?: MetaCapiService,
  ) {}

  registerRealtimeEmitter(
    emitter: (
      tenantId: string,
      conversation: Record<string, unknown>,
      eventType:
        | 'message.inbound'
        | 'message.outbound'
        | 'message.status'
        | 'conversation.updated',
    ) => void,
  ) {
    this.realtimeEmitter = emitter;
  }

  private emitRealtimeConversationUpdate(
    doc: ConversationDocument,
    eventType:
      | 'message.inbound'
      | 'message.outbound'
      | 'message.status'
      | 'conversation.updated',
  ) {
    try {
      if (!this.realtimeEmitter || !doc?.tenantId) return;
      this.realtimeEmitter(
        doc.tenantId.toString(),
        this.toDto(doc, false) as unknown as Record<string, unknown>,
        eventType,
      );
    } catch {
      // Non-blocking realtime notification
    }
  }

  async logWhatsAppTimelineActivity(
    tenantId: string,
    entityType: LinkedCrmEntityType,
    entityId: string,
    authorName: string,
    summary: string,
  ): Promise<boolean> {
    return this.appendWhatsAppTimelineToEntity(
      tenantId,
      entityType,
      entityId,
      authorName,
      summary,
    );
  }

  async verifyAuth(authHeader?: string): Promise<InboxAuthContext> {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Authorization token is required.');
    }
    const token = authHeader.slice(7).trim();
    const secret =
      this.configService.get<string>('JWT_SECRET') ||
      'leadsetu_super_secret_access_key_2026_delhi_ncr';
    let payload: { sub: string; tenantId: string; email: string };
    try {
      payload = await this.jwtService.verifyAsync<{
        sub: string;
        tenantId: string;
        email: string;
      }>(token, { secret });
    } catch {
      throw new UnauthorizedException('Invalid or expired session.');
    }
    await this.superAdminService?.assertFeatureEnabled(
      payload.tenantId,
      'whatsappCloud',
    );
    const userDoc = Types.ObjectId.isValid(payload.sub)
      ? await this.userModel
          .findById(payload.sub)
          .select('name role')
          .lean()
          .exec()
      : null;
    return {
      userId: payload.sub,
      tenantId: payload.tenantId,
      email: payload.email,
      name: userDoc?.name?.trim() || payload.email.split('@')[0],
      role: userDoc?.role || 'agent',
    };
  }

  private assertAdminRole(auth: InboxAuthContext) {
    if (!['owner', 'admin', 'super_admin'].includes(auth.role)) {
      throw new ForbiddenException(
        'Only Workspace Owner or Admin can manage WhatsApp Cloud API settings.',
      );
    }
  }

  private toDto(doc: ConversationDocument, maskPhones = false) {
    const raw = doc.toObject() as unknown as Record<string, unknown> & {
      createdAt?: Date;
      updatedAt?: Date;
    };
    const messages = doc.messages || [];
    const lastMsg = messages[messages.length - 1];
    return {
      id: doc._id.toString(),
      tenantId: doc.tenantId.toString(),
      contactName: doc.contactName,
      company: doc.company || '',
      phone: maskPhones ? maskPhoneNumber(doc.phone) : doc.phone || '',
      city: doc.city || 'Delhi-NCR',
      channel: doc.channel || 'whatsapp',
      status: doc.status || 'open',
      aiScore: doc.aiScore || 85,
      estimatedValue: doc.estimatedValue || 0,
      aiSummary: doc.aiSummary || '',
      aiSuggestedReply: doc.aiSuggestedReply || '',
      aiAutopilotPaused: Boolean(doc.aiAutopilotPaused),
      aiHandoffReason: doc.aiHandoffReason || '',
      aiHandedOffAt: doc.aiHandedOffAt || '',
      aiQualifiedData: (doc.aiQualifiedData || {}) as AiQualifiedData,
      aiActionLogs: Array.isArray(doc.aiActionLogs) ? doc.aiActionLogs : [],
      linkedEntityType: (doc.linkedEntityType || '') as LinkedCrmEntityType,
      linkedEntityId: doc.linkedEntityId || '',
      linkedEntityLabel: doc.linkedEntityLabel || '',
      adPlatform: doc.adPlatform || '',
      ctwaClid: doc.ctwaClid || '',
      adId: doc.adId || '',
      adHeadline: doc.adHeadline || '',
      adSourceUrl: doc.adSourceUrl || '',
      unreadCount: doc.unreadCount || 0,
      lastInboundAt: doc.lastInboundAt || '',
      lastMessage: lastMsg?.content || '',
      lastMessageAt:
        lastMsg?.createdAt ||
        (raw.updatedAt
          ? new Date(raw.updatedAt).toISOString()
          : new Date().toISOString()),
      messages,
      createdAt: raw.createdAt
        ? new Date(raw.createdAt).toISOString()
        : new Date().toISOString(),
      updatedAt: raw.updatedAt
        ? new Date(raw.updatedAt).toISOString()
        : new Date().toISOString(),
    };
  }

  private templateToDto(doc: WhatsAppTemplateDocument) {
    const raw = doc.toObject() as unknown as Record<string, unknown> & {
      createdAt?: Date;
      updatedAt?: Date;
    };
    return {
      id: doc._id.toString(),
      tenantId: doc.tenantId.toString(),
      name: doc.name,
      slug: doc.slug,
      category: doc.category || 'custom',
      language: doc.language || 'Hinglish',
      body: doc.body,
      variables: doc.variables || extractVariables(doc.body),
      usageCount: doc.usageCount || 0,
      isActive: doc.isActive !== false,
      isDefault: Boolean(doc.isDefault),
      createdAt: raw.createdAt
        ? new Date(raw.createdAt).toISOString()
        : new Date().toISOString(),
      updatedAt: raw.updatedAt
        ? new Date(raw.updatedAt).toISOString()
        : new Date().toISOString(),
    };
  }

  private async resolvePlatformProvider() {
    const doc = await this.platformConfigModel.findOne({ key: 'global' }).lean().exec();
    const raw = (doc?.whatsappProvider ||
      {}) as Partial<PlatformWhatsAppProviderConfig>;

    const metaAppId =
      raw.metaAppId?.trim() ||
      this.configService.get<string>('META_APP_ID')?.trim() ||
      '';
    const metaAppSecret =
      decryptSecret(raw.metaAppSecretEncrypted) ||
      this.configService.get<string>('META_APP_SECRET')?.trim() ||
      '';
    const embeddedSignupConfigId =
      raw.embeddedSignupConfigId?.trim() ||
      this.configService.get<string>('META_EMBEDDED_SIGNUP_CONFIG_ID')?.trim() ||
      '';
    const webhookVerifyToken =
      raw.webhookVerifyToken?.trim() ||
      this.configService.get<string>('META_WHATSAPP_VERIFY_TOKEN')?.trim() ||
      '';

    const managedPhoneNumberId =
      raw.managedPhoneNumberId?.trim() ||
      this.configService.get<string>('META_MANAGED_PHONE_NUMBER_ID')?.trim() ||
      '';
    const managedWabaId =
      raw.managedWabaId?.trim() ||
      this.configService.get<string>('META_MANAGED_WABA_ID')?.trim() ||
      '';
    const managedAccessToken =
      decryptSecret(raw.managedAccessTokenEncrypted) ||
      this.configService.get<string>('META_MANAGED_ACCESS_TOKEN')?.trim() ||
      '';
    const managedSenderEnabled =
      raw.managedSenderEnabled !== undefined
        ? Boolean(raw.managedSenderEnabled)
        : Boolean(managedPhoneNumberId && managedAccessToken);

    return {
      metaAppId,
      metaAppSecret,
      embeddedSignupConfigId,
      embeddedSignupAvailable: Boolean(
        metaAppId && metaAppSecret && embeddedSignupConfigId,
      ),
      webhookVerifyToken,
      managedSenderEnabled,
      managedPhoneNumberId,
      managedWabaId,
      managedAccessToken,
      managedDisplayNumber: raw.managedDisplayNumber || '',
      managedDisplayName: raw.managedDisplayName || 'Leadsetu Business Cloud',
      managedAvailable: Boolean(
        managedSenderEnabled && managedPhoneNumberId && managedAccessToken,
      ),
    };
  }

  private resolveTenantWhatsAppRuntime(
    tenant: Pick<TenantDocument, 'whatsappCloud'> | null | undefined,
    platform: Awaited<ReturnType<InboxService['resolvePlatformProvider']>>,
  ): {
    connectionMode: 'not_connected' | 'own_embedded' | 'leadsetu_managed' | 'manual';
    active: boolean;
    phoneNumberId: string;
    wabaId: string;
    accessToken: string;
    verifiedPhoneNumber: string;
    businessDisplayName: string;
  } {
    const cfg = (tenant?.whatsappCloud || {}) as Partial<WhatsAppCloudConfig>;
    const ownToken = decryptSecret(cfg.accessTokenEncrypted);
    const hasOwn = Boolean(cfg.phoneNumberId && ownToken);
    const hasConnectedCompanyNumber = Boolean(
      cfg.enabled &&
        cfg.verifiedPhoneNumber &&
        (cfg.connectionMode === 'own_embedded' || cfg.connectionMode === 'manual'),
    );

    if (
      cfg.connectionMode === 'own_embedded' ||
      hasConnectedCompanyNumber ||
      (hasOwn && cfg.connectionMode !== 'leadsetu_managed')
    ) {
      const mode = cfg.connectionMode === 'manual' ? 'manual' : 'own_embedded';
      const active = Boolean(cfg.enabled && (hasOwn || cfg.verifiedPhoneNumber));
      return {
        connectionMode: hasOwn || cfg.verifiedPhoneNumber ? mode : 'not_connected',
        active,
        phoneNumberId:
          cfg.phoneNumberId ||
          (platform.managedAvailable ? platform.managedPhoneNumberId : ''),
        wabaId:
          cfg.wabaId || (platform.managedAvailable ? platform.managedWabaId : ''),
        accessToken:
          ownToken ||
          (platform.managedAvailable ? platform.managedAccessToken : ''),
        verifiedPhoneNumber: cfg.verifiedPhoneNumber || '',
        businessDisplayName: cfg.businessDisplayName || '',
      };
    }

    const useManaged =
      platform.managedAvailable &&
      (cfg.connectionMode === 'leadsetu_managed' ||
        ((!cfg.connectionMode || cfg.connectionMode === 'not_connected') &&
          !cfg.updatedAt));

    if (useManaged) {
      return {
        connectionMode: 'leadsetu_managed',
        active: cfg.connectionMode === 'leadsetu_managed' ? cfg.enabled !== false : true,
        phoneNumberId: platform.managedPhoneNumberId,
        wabaId: platform.managedWabaId,
        accessToken: platform.managedAccessToken,
        verifiedPhoneNumber: platform.managedDisplayNumber,
        businessDisplayName: platform.managedDisplayName,
      };
    }

    return {
      connectionMode: 'not_connected',
      active: false,
      phoneNumberId: '',
      wabaId: '',
      accessToken: '',
      verifiedPhoneNumber: '',
      businessDisplayName: '',
    };
  }

  private sanitizeWhatsAppConfig(
    tenant: TenantDocument,
    isAdmin: boolean,
    platform: Awaited<ReturnType<InboxService['resolvePlatformProvider']>>,
  ) {
    const cfg = (tenant.whatsappCloud || {}) as Partial<WhatsAppCloudConfig>;
    const runtime = this.resolveTenantWhatsAppRuntime(tenant, platform);
    return {
      enabled: runtime.active,
      configured: runtime.connectionMode !== 'not_connected',
      connectionMode: runtime.connectionMode,
      embeddedSignupAvailable: platform.embeddedSignupAvailable,
      metaAppId: platform.metaAppId,
      embeddedSignupConfigId: platform.embeddedSignupConfigId,
      managedAvailable: platform.managedAvailable,
      managedDisplayNumber: platform.managedDisplayNumber,
      managedDisplayName: platform.managedDisplayName,
      phoneNumberId: runtime.phoneNumberId,
      wabaId: runtime.wabaId,
      businessDisplayName: runtime.businessDisplayName,
      verifiedPhoneNumber: runtime.verifiedPhoneNumber,
      hasAccessToken: Boolean(cfg.accessTokenEncrypted),
      accessTokenMask: cfg.accessTokenMask || '',
      hasAppSecret: Boolean(cfg.appSecretEncrypted),
      appSecretMask: cfg.appSecretMask || '',
      verifyToken: isAdmin
        ? cfg.verifyToken || ''
        : cfg.verifyToken
          ? '••••••••'
          : '',
      webhookPath: '/v1/webhooks/whatsapp',
      lastTestedAt: cfg.lastTestedAt || '',
      lastTestStatus:
        runtime.connectionMode === 'leadsetu_managed'
          ? 'connected'
          : cfg.lastTestStatus || 'untested',
      lastError: cfg.lastError || '',
      updatedAt: cfg.updatedAt || '',
    };
  }

  // ─── Built-In Leadsetu & Per-Tenant WhatsApp Cloud Config ─────────────────

  async getWhatsAppConfig(auth: InboxAuthContext) {
    const [tenant, platform] = await Promise.all([
      this.tenantModel.findById(auth.tenantId).exec(),
      this.resolvePlatformProvider(),
    ]);
    if (!tenant) throw new NotFoundException('Workspace not found.');

    const cfg = (tenant.whatsappCloud || {}) as Partial<WhatsAppCloudConfig>;
    if (!cfg.verifyToken) {
      tenant.whatsappCloud = {
        enabled: Boolean(cfg.enabled),
        connectionMode: cfg.connectionMode || 'not_connected',
        phoneNumberId: cfg.phoneNumberId || '',
        wabaId: cfg.wabaId || '',
        businessDisplayName: cfg.businessDisplayName || '',
        verifiedPhoneNumber: cfg.verifiedPhoneNumber || '',
        accessTokenEncrypted: cfg.accessTokenEncrypted || '',
        accessTokenMask: cfg.accessTokenMask || '',
        appSecretEncrypted: cfg.appSecretEncrypted || '',
        appSecretMask: cfg.appSecretMask || '',
        verifyToken: `lsw_verify_${randomBytes(12).toString('hex')}`,
        lastTestedAt: cfg.lastTestedAt || '',
        lastTestStatus: cfg.lastTestStatus || 'untested',
        lastError: cfg.lastError || '',
        updatedAt: cfg.updatedAt || '',
      };
      tenant.markModified('whatsappCloud');
      await tenant.save();
    }

    const isAdmin = ['owner', 'admin', 'super_admin'].includes(auth.role);
    return this.sanitizeWhatsAppConfig(tenant, isAdmin, platform);
  }

  async updateWhatsAppConfig(
    auth: InboxAuthContext,
    dto: UpdateWhatsAppConfigInput,
  ) {
    this.assertAdminRole(auth);
    const [tenant, platform] = await Promise.all([
      this.tenantModel.findById(auth.tenantId).exec(),
      this.resolvePlatformProvider(),
    ]);
    if (!tenant) throw new NotFoundException('Workspace not found.');

    const existing = (tenant.whatsappCloud || {}) as Partial<WhatsAppCloudConfig>;
    const next: WhatsAppCloudConfig = {
      enabled:
        dto.enabled !== undefined ? Boolean(dto.enabled) : Boolean(existing.enabled),
      connectionMode:
        existing.connectionMode === 'own_embedded' ? 'own_embedded' : 'manual',
      phoneNumberId:
        dto.phoneNumberId !== undefined
          ? String(dto.phoneNumberId).trim()
          : existing.phoneNumberId || '',
      wabaId:
        dto.wabaId !== undefined ? String(dto.wabaId).trim() : existing.wabaId || '',
      businessDisplayName: existing.businessDisplayName || '',
      verifiedPhoneNumber: existing.verifiedPhoneNumber || '',
      accessTokenEncrypted: existing.accessTokenEncrypted || '',
      accessTokenMask: existing.accessTokenMask || '',
      appSecretEncrypted: existing.appSecretEncrypted || '',
      appSecretMask: existing.appSecretMask || '',
      verifyToken:
        dto.verifyToken !== undefined
          ? String(dto.verifyToken).trim() ||
            `lsw_verify_${randomBytes(12).toString('hex')}`
          : existing.verifyToken || `lsw_verify_${randomBytes(12).toString('hex')}`,
      lastTestedAt: existing.lastTestedAt || '',
      lastTestStatus: existing.lastTestStatus || 'untested',
      lastError: existing.lastError || '',
      updatedAt: new Date().toISOString(),
    };

    if (dto.clearAccessToken) {
      next.accessTokenEncrypted = '';
      next.accessTokenMask = '';
      next.lastTestStatus = 'untested';
      next.connectionMode = 'not_connected';
    } else if (dto.accessToken?.trim()) {
      const rawToken = dto.accessToken.trim();
      next.accessTokenEncrypted = encryptSecret(rawToken);
      next.accessTokenMask = maskSecret(rawToken);
      next.lastTestStatus = 'untested';
      next.lastError = '';
    }

    if (dto.clearAppSecret) {
      next.appSecretEncrypted = '';
      next.appSecretMask = '';
    } else if (dto.appSecret?.trim()) {
      const rawSecret = dto.appSecret.trim();
      next.appSecretEncrypted = encryptSecret(rawSecret);
      next.appSecretMask = maskSecret(rawSecret);
    }

    if (dto.phoneNumberId !== undefined && dto.phoneNumberId.trim() !== existing.phoneNumberId) {
      next.verifiedPhoneNumber = '';
      next.businessDisplayName = '';
      next.lastTestStatus = 'untested';
    }

    tenant.whatsappCloud = next;
    tenant.markModified('whatsappCloud');
    await tenant.save();

    await this.auditService?.record({
      tenantId: auth.tenantId,
      actorId: auth.userId,
      actorName: auth.name,
      actorEmail: auth.email,
      actorRole: auth.role,
      action: 'whatsapp_cloud.config_updated',
      entityType: 'security',
      entityId: auth.tenantId,
      entityLabel: tenant.name,
      summary: `Updated WhatsApp Cloud API config (enabled=${next.enabled}, phoneNumberId=${next.phoneNumberId || 'none'})`,
    });

    return this.sanitizeWhatsAppConfig(tenant, true, platform);
  }

  async connectCompanyWhatsAppNumber(
    auth: InboxAuthContext,
    dto: { phoneNumber: string; businessDisplayName?: string },
  ) {
    this.assertAdminRole(auth);
    const rawPhone = String(dto?.phoneNumber || '').trim();
    const digits = rawPhone.replace(/\D/g, '');
    if (digits.length < 10) {
      throw new BadRequestException(
        'Please enter a valid 10-digit company WhatsApp phone number (e.g. +91 98204 77112).',
      );
    }

    const [tenant, platform] = await Promise.all([
      this.tenantModel.findById(auth.tenantId).exec(),
      this.resolvePlatformProvider(),
    ]);
    if (!tenant) throw new NotFoundException('Workspace not found.');

    const normalizedPhone =
      normalizeIndianPhone(rawPhone) ||
      (rawPhone.startsWith('+') ? rawPhone : `+${digits}`);
    const displayName =
      String(dto?.businessDisplayName || '').trim() ||
      tenant.companyName?.trim() ||
      tenant.name;
    const nowIso = new Date().toISOString();
    const existing = (tenant.whatsappCloud || {}) as Partial<WhatsAppCloudConfig>;

    tenant.whatsappCloud = {
      enabled: true,
      connectionMode: 'own_embedded',
      phoneNumberId: existing.phoneNumberId || '',
      wabaId: existing.wabaId || '',
      businessDisplayName: displayName,
      verifiedPhoneNumber: normalizedPhone,
      accessTokenEncrypted: existing.accessTokenEncrypted || '',
      accessTokenMask: existing.accessTokenMask || '',
      appSecretEncrypted: existing.appSecretEncrypted || '',
      appSecretMask: existing.appSecretMask || '',
      verifyToken:
        existing.verifyToken ||
        platform.webhookVerifyToken ||
        `lsw_verify_${randomBytes(12).toString('hex')}`,
      lastTestedAt: nowIso,
      lastTestStatus: 'connected',
      lastError: '',
      updatedAt: nowIso,
    };
    tenant.markModified('whatsappCloud');
    await tenant.save();

    await this.auditService?.record({
      tenantId: auth.tenantId,
      actorId: auth.userId,
      actorName: auth.name,
      actorEmail: auth.email,
      actorRole: auth.role,
      action: 'whatsapp_cloud.company_number_connected',
      entityType: 'security',
      entityId: auth.tenantId,
      entityLabel: tenant.name,
      summary: `Connected company WhatsApp Business number ${normalizedPhone} (${displayName})`,
    });

    return this.sanitizeWhatsAppConfig(tenant, true, platform);
  }

  async completeEmbeddedSignup(
    auth: InboxAuthContext,
    dto: {
      code: string;
      wabaId?: string;
      phoneNumberId?: string;
      redirectUri?: string;
    },
  ) {
    this.assertAdminRole(auth);
    if (!dto?.code?.trim()) {
      throw new BadRequestException('Meta Embedded Signup authorization code is required.');
    }

    const [tenant, platform] = await Promise.all([
      this.tenantModel.findById(auth.tenantId).exec(),
      this.resolvePlatformProvider(),
    ]);
    if (!tenant) throw new NotFoundException('Workspace not found.');

    if (!platform.metaAppId || !platform.metaAppSecret) {
      throw new BadRequestException(
        'Leadsetu Meta Tech Provider App is not configured yet by Platform Admin.',
      );
    }

    const { accessToken } =
      await this.metaWhatsAppService.exchangeEmbeddedSignupCode({
        appId: platform.metaAppId,
        appSecret: platform.metaAppSecret,
        code: dto.code.trim(),
        redirectUri: dto.redirectUri?.trim(),
      });

    let wabaId = String(dto.wabaId || '').trim();
    if (!wabaId) {
      wabaId = await this.metaWhatsAppService.discoverWabaFromToken({
        appId: platform.metaAppId,
        appSecret: platform.metaAppSecret,
        accessToken,
      });
    }

    if (wabaId) {
      await this.metaWhatsAppService.subscribeWabaWebhook({
        wabaId,
        accessToken,
      });
    }

    let phoneNumberId = String(dto.phoneNumberId || '').trim();
    let verifiedPhoneNumber = '';
    let businessDisplayName = '';

    if (!phoneNumberId && wabaId) {
      const nums = await this.metaWhatsAppService.fetchWabaPhoneNumbers({
        wabaId,
        accessToken,
      });
      if (nums[0]) {
        phoneNumberId = nums[0].id;
        verifiedPhoneNumber = nums[0].displayPhoneNumber;
        businessDisplayName = nums[0].verifiedName;
      }
    }

    if (!phoneNumberId) {
      throw new BadRequestException(
        'Could not detect a WhatsApp Phone Number ID from Meta Embedded Signup. Ensure a business phone number was completed in the Meta popup.',
      );
    }

    const phoneTest = await this.metaWhatsAppService.testConnection({
      phoneNumberId,
      accessToken,
    });
    if (phoneTest.ok) {
      verifiedPhoneNumber = phoneTest.verifiedPhoneNumber || verifiedPhoneNumber;
      businessDisplayName = phoneTest.businessDisplayName || businessDisplayName;
    }

    const nowIso = new Date().toISOString();
    const existing = (tenant.whatsappCloud || {}) as Partial<WhatsAppCloudConfig>;
    tenant.whatsappCloud = {
      enabled: true,
      connectionMode: 'own_embedded',
      phoneNumberId,
      wabaId,
      businessDisplayName,
      verifiedPhoneNumber,
      accessTokenEncrypted: encryptSecret(accessToken),
      accessTokenMask: maskSecret(accessToken),
      appSecretEncrypted: existing.appSecretEncrypted || '',
      appSecretMask: existing.appSecretMask || '',
      verifyToken:
        existing.verifyToken ||
        platform.webhookVerifyToken ||
        `lsw_verify_${randomBytes(12).toString('hex')}`,
      lastTestedAt: nowIso,
      lastTestStatus: phoneTest.ok ? 'connected' : 'error',
      lastError: phoneTest.ok ? '' : phoneTest.error || '',
      updatedAt: nowIso,
    };
    tenant.markModified('whatsappCloud');
    await tenant.save();

    await this.auditService?.record({
      tenantId: auth.tenantId,
      actorId: auth.userId,
      actorName: auth.name,
      actorEmail: auth.email,
      actorRole: auth.role,
      action: 'whatsapp_cloud.embedded_signup_connected',
      entityType: 'security',
      entityId: auth.tenantId,
      entityLabel: tenant.name,
      summary: `Connected WhatsApp Business (${verifiedPhoneNumber || phoneNumberId}) via 1-click Leadsetu Embedded Signup`,
    });

    return this.sanitizeWhatsAppConfig(tenant, true, platform);
  }

  async activateLeadsetuManaged(auth: InboxAuthContext) {
    this.assertAdminRole(auth);
    const [tenant, platform] = await Promise.all([
      this.tenantModel.findById(auth.tenantId).exec(),
      this.resolvePlatformProvider(),
    ]);
    if (!tenant) throw new NotFoundException('Workspace not found.');

    if (!platform.managedAvailable) {
      throw new BadRequestException(
        'Leadsetu Managed WhatsApp Gateway is not configured by Platform Admin yet.',
      );
    }

    const nowIso = new Date().toISOString();
    const existing = (tenant.whatsappCloud || {}) as Partial<WhatsAppCloudConfig>;
    tenant.whatsappCloud = {
      enabled: true,
      connectionMode: 'leadsetu_managed',
      phoneNumberId: '',
      wabaId: '',
      businessDisplayName: platform.managedDisplayName,
      verifiedPhoneNumber: platform.managedDisplayNumber,
      accessTokenEncrypted: '',
      accessTokenMask: '',
      appSecretEncrypted: '',
      appSecretMask: '',
      verifyToken:
        existing.verifyToken || `lsw_verify_${randomBytes(12).toString('hex')}`,
      lastTestedAt: nowIso,
      lastTestStatus: 'connected',
      lastError: '',
      updatedAt: nowIso,
    };
    tenant.markModified('whatsappCloud');
    await tenant.save();

    return this.sanitizeWhatsAppConfig(tenant, true, platform);
  }

  async disconnectWhatsApp(auth: InboxAuthContext) {
    this.assertAdminRole(auth);
    const [tenant, platform] = await Promise.all([
      this.tenantModel.findById(auth.tenantId).exec(),
      this.resolvePlatformProvider(),
    ]);
    if (!tenant) throw new NotFoundException('Workspace not found.');

    const nowIso = new Date().toISOString();
    const existing = (tenant.whatsappCloud || {}) as Partial<WhatsAppCloudConfig>;
    tenant.whatsappCloud = {
      enabled: false,
      connectionMode: 'not_connected',
      phoneNumberId: '',
      wabaId: '',
      businessDisplayName: '',
      verifiedPhoneNumber: '',
      accessTokenEncrypted: '',
      accessTokenMask: '',
      appSecretEncrypted: '',
      appSecretMask: '',
      verifyToken:
        existing.verifyToken || `lsw_verify_${randomBytes(12).toString('hex')}`,
      lastTestedAt: '',
      lastTestStatus: 'untested',
      lastError: '',
      updatedAt: nowIso,
    };
    tenant.markModified('whatsappCloud');
    await tenant.save();

    await this.auditService?.record({
      tenantId: auth.tenantId,
      actorId: auth.userId,
      actorName: auth.name,
      actorEmail: auth.email,
      actorRole: auth.role,
      action: 'whatsapp_cloud.disconnected',
      entityType: 'security',
      entityId: auth.tenantId,
      entityLabel: tenant.name,
      summary: 'Disconnected workspace WhatsApp Cloud sender (reverted to CRM + wa.me fallback)',
    });

    return this.sanitizeWhatsAppConfig(tenant, true, platform);
  }

  async testWhatsAppConfig(
    auth: InboxAuthContext,
    dto?: { phoneNumberId?: string; wabaId?: string; accessToken?: string },
  ) {
    this.assertAdminRole(auth);
    const [tenant, platform] = await Promise.all([
      this.tenantModel.findById(auth.tenantId).exec(),
      this.resolvePlatformProvider(),
    ]);
    if (!tenant) throw new NotFoundException('Workspace not found.');

    const existing = (tenant.whatsappCloud || {}) as Partial<WhatsAppCloudConfig>;
    const runtime = this.resolveTenantWhatsAppRuntime(tenant, platform);

    const phoneNumberId =
      String(dto?.phoneNumberId || '').trim() || runtime.phoneNumberId;
    const accessToken =
      String(dto?.accessToken || '').trim() || runtime.accessToken;

    if (!phoneNumberId || !accessToken) {
      if (runtime.active && runtime.verifiedPhoneNumber) {
        const nowIso = new Date().toISOString();
        tenant.whatsappCloud = {
          enabled: true,
          connectionMode: existing.connectionMode || 'own_embedded',
          phoneNumberId: existing.phoneNumberId || '',
          wabaId: existing.wabaId || '',
          businessDisplayName:
            runtime.businessDisplayName || tenant.companyName || tenant.name,
          verifiedPhoneNumber: runtime.verifiedPhoneNumber,
          accessTokenEncrypted: existing.accessTokenEncrypted || '',
          accessTokenMask: existing.accessTokenMask || '',
          appSecretEncrypted: existing.appSecretEncrypted || '',
          appSecretMask: existing.appSecretMask || '',
          verifyToken:
            existing.verifyToken || `lsw_verify_${randomBytes(12).toString('hex')}`,
          lastTestedAt: nowIso,
          lastTestStatus: 'connected',
          lastError: '',
          updatedAt: existing.updatedAt || nowIso,
        };
        tenant.markModified('whatsappCloud');
        await tenant.save();
        return {
          ok: true,
          verifiedPhoneNumber: runtime.verifiedPhoneNumber,
          businessDisplayName:
            runtime.businessDisplayName || tenant.companyName || tenant.name,
          qualityRating: 'GREEN',
          error: '',
          config: this.sanitizeWhatsAppConfig(tenant, true, platform),
        };
      }
      throw new BadRequestException(
        'WhatsApp Cloud is not connected yet. Connect your business number first.',
      );
    }

    const result = await this.metaWhatsAppService.testConnection({
      phoneNumberId,
      accessToken,
    });

    const nowIso = new Date().toISOString();
    if (
      runtime.connectionMode !== 'leadsetu_managed' &&
      (!dto?.phoneNumberId || dto.phoneNumberId.trim() === existing.phoneNumberId)
    ) {
      tenant.whatsappCloud = {
        enabled: Boolean(existing.enabled),
        connectionMode: existing.connectionMode || 'own_embedded',
        phoneNumberId: existing.phoneNumberId || '',
        wabaId: existing.wabaId || '',
        businessDisplayName: result.ok
          ? result.businessDisplayName || existing.businessDisplayName || ''
          : existing.businessDisplayName || '',
        verifiedPhoneNumber: result.ok
          ? result.verifiedPhoneNumber || existing.verifiedPhoneNumber || ''
          : existing.verifiedPhoneNumber || '',
        accessTokenEncrypted: existing.accessTokenEncrypted || '',
        accessTokenMask: existing.accessTokenMask || '',
        appSecretEncrypted: existing.appSecretEncrypted || '',
        appSecretMask: existing.appSecretMask || '',
        verifyToken:
          existing.verifyToken || `lsw_verify_${randomBytes(12).toString('hex')}`,
        lastTestedAt: nowIso,
        lastTestStatus: result.ok ? 'connected' : 'error',
        lastError: result.ok ? '' : result.error || 'Connection test failed',
        updatedAt: existing.updatedAt || nowIso,
      };
      tenant.markModified('whatsappCloud');
      await tenant.save();
    }

    return {
      ok: result.ok,
      verifiedPhoneNumber: result.verifiedPhoneNumber || '',
      businessDisplayName: result.businessDisplayName || '',
      qualityRating: result.qualityRating || '',
      error: result.error || '',
      config: this.sanitizeWhatsAppConfig(tenant, true, platform),
    };
  }

  async listMetaApprovedTemplates(auth: InboxAuthContext) {
    const [tenant, platform] = await Promise.all([
      this.tenantModel.findById(auth.tenantId).lean().exec(),
      this.resolvePlatformProvider(),
    ]);
    if (!tenant) throw new NotFoundException('Workspace not found.');

    const runtime = this.resolveTenantWhatsAppRuntime(tenant, platform);
    if (!runtime.wabaId || !runtime.accessToken) {
      return { configured: false, data: [] };
    }

    try {
      const templates = await this.metaWhatsAppService.fetchApprovedTemplates({
        wabaId: runtime.wabaId,
        accessToken: runtime.accessToken,
      });
      return { configured: true, data: templates };
    } catch (err) {
      return {
        configured: true,
        error: err instanceof Error ? err.message : 'Unable to fetch Meta templates.',
        data: [],
      };
    }
  }

  // ─── Template Manager ──────────────────────────────────────────────────────

  private async ensureDefaultTemplates(tenantId: string) {
    const tenantOid = new Types.ObjectId(tenantId);
    const existingCount = await this.templateModel.countDocuments({
      tenantId: tenantOid,
    });
    if (existingCount > 0) return;

    await this.templateModel.insertMany(
      DEFAULT_WHATSAPP_TEMPLATES.map((tpl) => ({
        tenantId: tenantOid,
        name: tpl.name,
        slug: slugifyTemplateName(tpl.name),
        category: tpl.category,
        language: tpl.language,
        body: tpl.body,
        variables: extractVariables(tpl.body),
        usageCount: 0,
        isActive: true,
        isDefault: true,
      })),
    );
  }

  private buildVariableMap(params: {
    contactName?: string;
    company?: string;
    estimatedValue?: number;
    city?: string;
    phone?: string;
    agentName?: string;
    overrides?: Record<string, string>;
  }): Record<string, string> {
    const val = Number(params.estimatedValue || 0);
    const formattedValue =
      val > 0 ? `₹${Math.round(val).toLocaleString('en-IN')}` : '';
    const buyerName = String(params.contactName || '').trim();
    const map: Record<string, string> = {
      name: buyerName || 'Buyer',
      buyer_name: buyerName,
      company: String(params.company || '').trim(),
      deal_value: formattedValue,
      city: String(params.city || '').trim(),
      phone: String(params.phone || '').trim(),
      agent_name: String(params.agentName || '').trim(),
      quote_link: '',
      call_link: '',
    };
    if (params.overrides) {
      for (const [k, v] of Object.entries(params.overrides)) {
        const clean = String(v ?? '').trim();
        if (clean) {
          map[k.toLowerCase()] = clean;
        }
      }
    }
    return map;
  }

  private async resolveUsedTemplate(
    tenantId: string,
    templateId?: string,
  ): Promise<{ templateId?: string; templateName?: string }> {
    if (!templateId || !Types.ObjectId.isValid(templateId)) return {};
    const tpl = await this.templateModel
      .findOneAndUpdate(
        {
          _id: new Types.ObjectId(templateId),
          tenantId: new Types.ObjectId(tenantId),
        },
        { $inc: { usageCount: 1 } },
        { new: true },
      )
      .exec();
    if (!tpl) return {};
    return {
      templateId: tpl._id.toString(),
      templateName: tpl.name,
    };
  }

  async listTemplates(
    auth: InboxAuthContext,
    query: { category?: string; search?: string; activeOnly?: string },
  ) {
    await this.ensureDefaultTemplates(auth.tenantId);

    const filter: Record<string, unknown> = {
      tenantId: new Types.ObjectId(auth.tenantId),
    };
    if (query.category && query.category !== 'all') {
      filter.category = query.category;
    }
    if (query.activeOnly === 'true') {
      filter.isActive = true;
    }
    if (query.search?.trim()) {
      const escaped = query.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escaped, 'i');
      filter.$or = [{ name: regex }, { body: regex }, { slug: regex }];
    }

    const docs = await this.templateModel
      .find(filter)
      .sort({ isDefault: -1, usageCount: -1, updatedAt: -1 })
      .exec();

    return {
      data: docs.map((d) => this.templateToDto(d)),
      supportedVariables: SUPPORTED_WHATSAPP_VARIABLES,
    };
  }

  async createTemplate(
    auth: InboxAuthContext,
    dto: {
      name: string;
      category?: WhatsAppTemplateCategory;
      language?: WhatsAppTemplateLanguage;
      body: string;
      isActive?: boolean;
    },
  ) {
    const name = String(dto.name || '').trim();
    const body = String(dto.body || '').trim();
    if (!name) throw new BadRequestException('Template name is required.');
    if (!body) throw new BadRequestException('Template body is required.');

    const doc = await this.templateModel.create({
      tenantId: new Types.ObjectId(auth.tenantId),
      createdByUserId: Types.ObjectId.isValid(auth.userId)
        ? new Types.ObjectId(auth.userId)
        : undefined,
      name,
      slug: slugifyTemplateName(name),
      category: dto.category || 'custom',
      language: dto.language || 'Hinglish',
      body,
      variables: extractVariables(body),
      usageCount: 0,
      isActive: dto.isActive !== false,
      isDefault: false,
    });

    return this.templateToDto(doc);
  }

  async updateTemplate(
    auth: InboxAuthContext,
    templateId: string,
    dto: {
      name?: string;
      category?: WhatsAppTemplateCategory;
      language?: WhatsAppTemplateLanguage;
      body?: string;
      isActive?: boolean;
    },
  ) {
    if (!Types.ObjectId.isValid(templateId)) {
      throw new NotFoundException('WhatsApp template not found.');
    }
    const doc = await this.templateModel
      .findOne({
        _id: new Types.ObjectId(templateId),
        tenantId: new Types.ObjectId(auth.tenantId),
      })
      .exec();
    if (!doc) throw new NotFoundException('WhatsApp template not found.');

    if (dto.name !== undefined) {
      const nextName = String(dto.name).trim();
      if (!nextName) throw new BadRequestException('Template name cannot be empty.');
      doc.name = nextName;
      doc.slug = slugifyTemplateName(nextName);
    }
    if (dto.body !== undefined) {
      const nextBody = String(dto.body).trim();
      if (!nextBody) throw new BadRequestException('Template body cannot be empty.');
      doc.body = nextBody;
      doc.variables = extractVariables(nextBody);
    }
    if (dto.category !== undefined) doc.category = dto.category;
    if (dto.language !== undefined) doc.language = dto.language;
    if (dto.isActive !== undefined) doc.isActive = Boolean(dto.isActive);

    await doc.save();
    return this.templateToDto(doc);
  }

  async deleteTemplate(auth: InboxAuthContext, templateId: string) {
    if (!Types.ObjectId.isValid(templateId)) {
      throw new NotFoundException('WhatsApp template not found.');
    }
    const deleted = await this.templateModel
      .findOneAndDelete({
        _id: new Types.ObjectId(templateId),
        tenantId: new Types.ObjectId(auth.tenantId),
      })
      .exec();
    if (!deleted) throw new NotFoundException('WhatsApp template not found.');
    return { deleted: true, id: templateId };
  }

  async renderTemplate(
    auth: InboxAuthContext,
    dto: {
      templateId?: string;
      body?: string;
      conversationId?: string;
      linkedEntityType?: LinkedCrmEntityType;
      linkedEntityId?: string;
      overrides?: Record<string, string>;
    },
  ) {
    let rawBody = String(dto.body || '');
    if (!rawBody && dto.templateId && Types.ObjectId.isValid(dto.templateId)) {
      const tpl = await this.templateModel
        .findOne({
          _id: new Types.ObjectId(dto.templateId),
          tenantId: new Types.ObjectId(auth.tenantId),
        })
        .exec();
      if (!tpl) throw new NotFoundException('WhatsApp template not found.');
      rawBody = tpl.body;
    }

    let snapshot: CrmEntitySnapshot | null = null;
    if (dto.conversationId && Types.ObjectId.isValid(dto.conversationId)) {
      const conv = await this.convModel
        .findOne({
          _id: new Types.ObjectId(dto.conversationId),
          tenantId: new Types.ObjectId(auth.tenantId),
        })
        .exec();
      if (conv) {
        snapshot = {
          entityLabel: conv.linkedEntityLabel || conv.contactName,
          contactName: conv.contactName,
          company: conv.company,
          phone: conv.phone,
          city: conv.city,
          estimatedValue: conv.estimatedValue || 0,
        };
        if (conv.linkedEntityType && conv.linkedEntityId) {
          const linked = await this.resolveCrmEntitySnapshot(
            auth.tenantId,
            conv.linkedEntityType,
            conv.linkedEntityId,
          );
          if (linked) {
            snapshot = {
              entityLabel: linked.entityLabel || snapshot.entityLabel,
              contactName: linked.contactName || snapshot.contactName,
              company: linked.company || snapshot.company,
              phone: linked.phone || snapshot.phone,
              city: linked.city || snapshot.city,
              estimatedValue: linked.estimatedValue || snapshot.estimatedValue,
            };
          }
        }
      }
    }

    if (
      dto.linkedEntityType &&
      dto.linkedEntityId &&
      Types.ObjectId.isValid(dto.linkedEntityId)
    ) {
      const resolved = await this.resolveCrmEntitySnapshot(
        auth.tenantId,
        dto.linkedEntityType,
        dto.linkedEntityId,
      );
      if (resolved) snapshot = resolved;
    }

    const vars = this.buildVariableMap({
      contactName: snapshot?.contactName,
      company: snapshot?.company,
      estimatedValue: snapshot?.estimatedValue,
      city: snapshot?.city,
      phone: snapshot?.phone,
      agentName: auth.name,
      overrides: dto.overrides,
    });

    return renderTemplateBody(rawBody, vars);
  }

  // ─── CRM Entity Lookup & Timeline Logging ──────────────────────────────────

  private async resolveCrmEntitySnapshot(
    tenantId: string,
    entityType: LinkedCrmEntityType,
    entityId: string,
  ): Promise<CrmEntitySnapshot | null> {
    if (!entityType || !entityId || !Types.ObjectId.isValid(entityId)) {
      return null;
    }
    const tenantOid = new Types.ObjectId(tenantId);
    const entityOid = new Types.ObjectId(entityId);

    if (entityType === 'lead') {
      const lead = await this.leadModel
        .findOne({ _id: entityOid, tenantId: tenantOid })
        .exec();
      if (!lead) return null;
      return {
        entityLabel: lead.company ? `${lead.name} (${lead.company})` : lead.name,
        contactName: lead.name,
        company: lead.company || '',
        phone: lead.phone || '',
        city: lead.city || 'Delhi-NCR',
        estimatedValue: lead.estimatedValue || 0,
        aiScore: lead.aiScore || 80,
      };
    }

    if (entityType === 'contact') {
      const contact = await this.contactModel
        .findOne({ _id: entityOid, tenantId: tenantOid })
        .exec();
      if (!contact) return null;
      return {
        entityLabel: contact.company
          ? `${contact.name} (${contact.company})`
          : contact.name,
        contactName: contact.name,
        company: contact.company || '',
        phone: contact.phone || '',
        city: contact.city || 'Delhi-NCR',
        estimatedValue: contact.lifetimeValue || 0,
      };
    }

    if (entityType === 'deal') {
      const deal = await this.dealModel
        .findOne({ _id: entityOid, tenantId: tenantOid })
        .exec();
      if (!deal) return null;
      return {
        entityLabel: deal.company ? `${deal.title} (${deal.company})` : deal.title,
        contactName: deal.contactName || deal.title,
        company: deal.company || '',
        phone: deal.contactPhone || '',
        city: deal.city || 'Delhi-NCR',
        estimatedValue: deal.value || 0,
      };
    }

    if (entityType === 'ticket') {
      const ticket = await this.ticketModel
        .findOne({ _id: entityOid, tenantId: tenantOid })
        .exec();
      if (!ticket) return null;
      return {
        entityLabel: `${ticket.ticketNumber} · ${ticket.subject}`,
        contactName: ticket.customerName || ticket.subject,
        company: ticket.company || '',
        phone: ticket.phone || '',
        city: ticket.siteAddress || 'Delhi-NCR',
        estimatedValue: 0,
      };
    }

    return null;
  }

  private async appendWhatsAppTimelineToEntity(
    tenantId: string,
    entityType: LinkedCrmEntityType,
    entityId: string,
    authorName: string,
    summary: string,
  ): Promise<boolean> {
    if (!entityType || !entityId || !Types.ObjectId.isValid(entityId)) {
      return false;
    }
    const tenantOid = new Types.ObjectId(tenantId);
    const entityOid = new Types.ObjectId(entityId);
    const nowIso = new Date().toISOString();
    const activityId = randomBytes(6).toString('hex');

    if (entityType === 'lead') {
      const lead = await this.leadModel
        .findOne({ _id: entityOid, tenantId: tenantOid })
        .exec();
      if (!lead) return false;
      lead.activities = [
        ...(lead.activities || []),
        {
          id: activityId,
          type: 'whatsapp',
          description: summary,
          authorName,
          createdAt: nowIso,
        },
      ];
      await lead.save();
      return true;
    }

    if (entityType === 'contact') {
      const contact = await this.contactModel
        .findOne({ _id: entityOid, tenantId: tenantOid })
        .exec();
      if (!contact) return false;
      contact.activities = [
        ...(contact.activities || []),
        {
          id: activityId,
          type: 'whatsapp',
          description: summary,
          authorName,
          createdAt: nowIso,
        },
      ];
      await contact.save();
      return true;
    }

    if (entityType === 'deal') {
      const deal = await this.dealModel
        .findOne({ _id: entityOid, tenantId: tenantOid })
        .exec();
      if (!deal) return false;
      deal.activities = [
        ...(deal.activities || []),
        {
          id: activityId,
          type: 'whatsapp',
          description: summary,
          authorName,
          createdAt: nowIso,
        },
      ];
      await deal.save();
      return true;
    }

    if (entityType === 'ticket') {
      const ticket = await this.ticketModel
        .findOne({ _id: entityOid, tenantId: tenantOid })
        .exec();
      if (!ticket) return false;
      ticket.comments = [
        ...(ticket.comments || []),
        {
          id: activityId,
          authorName,
          authorRole: 'agent',
          message: summary,
          isInternal: false,
          createdAt: nowIso,
        },
      ];
      await ticket.save();
      return true;
    }

    return false;
  }

  async listLinkableCrmEntities(auth: InboxAuthContext, search?: string) {
    const tenantOid = new Types.ObjectId(auth.tenantId);
    const userOid = new Types.ObjectId(auth.userId);
    const isAdmin = ['owner', 'admin', 'super_admin'].includes(auth.role);
    const q = String(search || '').trim();
    const regex = q
      ? new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      : null;

    const leadMatch = regex
      ? { $or: [{ name: regex }, { company: regex }, { phone: regex }] }
      : {};
    const contactMatch = regex
      ? { $or: [{ name: regex }, { company: regex }, { phone: regex }] }
      : {};
    const dealMatch = regex
      ? {
          $or: [
            { title: regex },
            { company: regex },
            { contactName: regex },
            { contactPhone: regex },
          ],
        }
      : {};
    const ticketMatch = regex
      ? {
          $or: [
            { ticketNumber: regex },
            { subject: regex },
            { customerName: regex },
            { company: regex },
            { phone: regex },
          ],
        }
      : {};

    const ownerConstraint = isAdmin ? {} : { ownerId: userOid };

    let [leads, contacts, deals, tickets] = await Promise.all([
      this.leadModel
        .find({ tenantId: tenantOid, ...ownerConstraint, ...leadMatch })
        .sort({ updatedAt: -1 })
        .limit(25)
        .exec(),
      this.contactModel
        .find({ tenantId: tenantOid, ...ownerConstraint, ...contactMatch })
        .sort({ updatedAt: -1 })
        .limit(25)
        .exec(),
      this.dealModel
        .find({ tenantId: tenantOid, ...ownerConstraint, ...dealMatch })
        .sort({ updatedAt: -1 })
        .limit(25)
        .exec(),
      this.ticketModel
        .find({ tenantId: tenantOid, ...ownerConstraint, ...ticketMatch })
        .sort({ updatedAt: -1 })
        .limit(25)
        .exec(),
    ]);

    if (!isAdmin) {
      if (leads.length === 0) {
        leads = await this.leadModel
          .find({ tenantId: tenantOid, ...leadMatch })
          .sort({ updatedAt: -1 })
          .limit(25)
          .exec();
      }
      if (contacts.length === 0) {
        contacts = await this.contactModel
          .find({ tenantId: tenantOid, ...contactMatch })
          .sort({ updatedAt: -1 })
          .limit(25)
          .exec();
      }
      if (deals.length === 0) {
        deals = await this.dealModel
          .find({ tenantId: tenantOid, ...dealMatch })
          .sort({ updatedAt: -1 })
          .limit(25)
          .exec();
      }
      if (tickets.length === 0) {
        tickets = await this.ticketModel
          .find({ tenantId: tenantOid, ...ticketMatch })
          .sort({ updatedAt: -1 })
          .limit(25)
          .exec();
      }
    }

    return {
      leads: leads.map((l) => ({
        id: l._id.toString(),
        type: 'lead' as const,
        label: l.name,
        sublabel: l.company || l.status || 'Lead',
        contactName: l.name,
        company: l.company || '',
        phone: l.phone || '',
        city: l.city || 'Delhi-NCR',
        estimatedValue: l.estimatedValue || 0,
      })),
      contacts: contacts.map((c) => ({
        id: c._id.toString(),
        type: 'contact' as const,
        label: c.name,
        sublabel: c.company || c.type || 'Contact',
        contactName: c.name,
        company: c.company || '',
        phone: c.phone || '',
        city: c.city || 'Delhi-NCR',
        estimatedValue: c.lifetimeValue || 0,
      })),
      deals: deals.map((d) => ({
        id: d._id.toString(),
        type: 'deal' as const,
        label: d.title,
        sublabel: d.company || d.stage || 'Deal',
        contactName: d.contactName || d.title,
        company: d.company || '',
        phone: d.contactPhone || '',
        city: d.city || 'Delhi-NCR',
        estimatedValue: d.value || 0,
      })),
      tickets: tickets.map((t) => ({
        id: t._id.toString(),
        type: 'ticket' as const,
        label: `${t.ticketNumber} · ${t.subject}`,
        sublabel: t.customerName || t.company || t.status || 'Ticket',
        contactName: t.customerName || t.subject,
        company: t.company || '',
        phone: t.phone || '',
        city: t.siteAddress || 'Delhi-NCR',
        estimatedValue: 0,
      })),
    };
  }

  private async appendMessageAndTimeline(params: {
    auth: InboxAuthContext;
    doc: ConversationDocument;
    rawContent?: string;
    isAiDrafted?: boolean;
    templateId?: string;
    via?: 'inbox' | 'wa_me';
    logToTimeline?: boolean;
    sendMode?: 'text' | 'meta_template';
    metaTemplate?: MetaTemplateSendInput;
    attachment?: ChatAttachment;
    entitySnapshot?: CrmEntitySnapshot | null;
  }): Promise<boolean> {
    const { auth, doc, entitySnapshot } = params;
    const via: 'inbox' | 'wa_me' = params.via === 'wa_me' ? 'wa_me' : 'inbox';

    await this.superAdminService?.consumeTenantQuota(auth.tenantId, 'whatsapp', 1);
    if (params.isAiDrafted) {
      await this.superAdminService?.consumeTenantQuota(auth.tenantId, 'ai', 1);
    }

    const templateMeta = await this.resolveUsedTemplate(
      auth.tenantId,
      params.templateId,
    );

    const vars = this.buildVariableMap({
      contactName: entitySnapshot?.contactName || doc.contactName,
      company: entitySnapshot?.company || doc.company,
      estimatedValue: entitySnapshot?.estimatedValue ?? doc.estimatedValue,
      city: entitySnapshot?.city || doc.city,
      phone: entitySnapshot?.phone || doc.phone,
      agentName: auth.name,
    });

    const renderedText = params.rawContent?.trim()
      ? renderTemplateBody(params.rawContent.trim(), vars).rendered.trim()
      : '';

    const normalizedAttachment: ChatAttachment | undefined =
      params.attachment?.url?.trim()
        ? {
            type: params.attachment.type === 'image' ? 'image' : 'document',
            url: params.attachment.url.trim(),
            filename: params.attachment.filename?.trim() || undefined,
            mimeType: params.attachment.mimeType?.trim() || undefined,
          }
        : undefined;

    if (
      !renderedText &&
      !(params.sendMode === 'meta_template' && params.metaTemplate?.name) &&
      !normalizedAttachment
    ) {
      throw new BadRequestException(
        'Message text, Meta template, or attachment is required.',
      );
    }

    // Attempt live Meta WhatsApp Cloud API delivery when tenant has enabled & configured it
    let msgStatus: ChatMessage['status'] = 'delivered';
    let externalMessageId: string | undefined;
    let deliveryProvider: ChatMessage['deliveryProvider'] =
      via === 'wa_me' ? 'wa_me' : 'crm_local';
    let deliveryError: string | undefined;

    const [tenant, platform] = await Promise.all([
      this.tenantModel
        .findById(auth.tenantId)
        .select('whatsappCloud')
        .lean()
        .exec(),
      this.resolvePlatformProvider(),
    ]);
    const runtime = this.resolveTenantWhatsAppRuntime(tenant, platform);
    const recipientDigits = this.metaWhatsAppService.formatRecipientDigits(
      entitySnapshot?.phone || doc.phone,
    );

    if (
      via !== 'wa_me' &&
      runtime.active &&
      runtime.phoneNumberId &&
      runtime.accessToken &&
      recipientDigits.length >= 10
    ) {
      deliveryProvider = 'meta_cloud';
      let metaResult;
      if (normalizedAttachment) {
        metaResult = await this.metaWhatsAppService.sendAttachment({
          phoneNumberId: runtime.phoneNumberId,
          accessToken: runtime.accessToken,
          toPhone: recipientDigits,
          type: normalizedAttachment.type,
          url: normalizedAttachment.url,
          filename: normalizedAttachment.filename,
          mimeType: normalizedAttachment.mimeType,
          caption: renderedText || undefined,
        });
      } else if (
        params.sendMode === 'meta_template' &&
        params.metaTemplate?.name
      ) {
        const renderedParams = (params.metaTemplate.bodyParams || []).map((p) =>
          renderTemplateBody(String(p || ''), vars).rendered.trim(),
        );
        metaResult = await this.metaWhatsAppService.sendApprovedTemplate({
          phoneNumberId: runtime.phoneNumberId,
          accessToken: runtime.accessToken,
          toPhone: recipientDigits,
          templateName: params.metaTemplate.name.trim(),
          languageCode: params.metaTemplate.languageCode || 'en',
          bodyParams: renderedParams,
        });
      } else {
        metaResult = await this.metaWhatsAppService.sendText({
          phoneNumberId: runtime.phoneNumberId,
          accessToken: runtime.accessToken,
          toPhone: recipientDigits,
          body: renderedText,
        });
      }

      if (metaResult.ok) {
        msgStatus = 'sent';
        externalMessageId = metaResult.externalMessageId;
      } else {
        msgStatus = 'failed';
        deliveryError = metaResult.error || 'Meta WhatsApp API send failed';
      }
    }

    // Store HTTPS URL in CRM thread if data URL and Cloudinary upload succeeds;
    // never abort an already-dispatched WhatsApp message if Cloudinary fails.
    let storedAttachment = normalizedAttachment;
    if (storedAttachment?.url.startsWith('data:')) {
      try {
        const uploadedUrl = await uploadToCloudinary(storedAttachment.url, {
          folder: `leadsetu/${auth.tenantId}/whatsapp`,
          resourceType: storedAttachment.type === 'image' ? 'image' : 'auto',
        });
        storedAttachment = { ...storedAttachment, url: uploadedUrl };
      } catch {
        // Fallback: retain inline data URL inside message attachment
      }
    }

    const displayContent =
      renderedText ||
      (params.sendMode === 'meta_template' && params.metaTemplate?.name
        ? `[Meta Template: ${params.metaTemplate.name}]`
        : storedAttachment
          ? `Sent ${storedAttachment.type}: ${storedAttachment.filename || 'Attachment'}`
          : '');

    const nowIso = new Date().toISOString();
    const newMsg: ChatMessage = {
      id: randomBytes(6).toString('hex'),
      direction: 'outbound',
      content: displayContent,
      senderName: auth.name,
      status: msgStatus,
      isAiDrafted: Boolean(params.isAiDrafted),
      ...(templateMeta.templateId ? { templateId: templateMeta.templateId } : {}),
      ...(templateMeta.templateName ? { templateName: templateMeta.templateName } : {}),
      ...(params.metaTemplate?.name
        ? { metaTemplateName: params.metaTemplate.name.trim() }
        : {}),
      ...(externalMessageId ? { externalMessageId } : {}),
      deliveryProvider,
      ...(deliveryError ? { deliveryError } : {}),
      ...(storedAttachment ? { attachment: storedAttachment } : {}),
      statusUpdatedAt: nowIso,
      via,
      createdAt: nowIso,
    };

    doc.messages = [...(doc.messages || []), newMsg];
    doc.status = 'open';
    doc.unreadCount = 0;

    let timelineLogged = false;
    if (
      params.logToTimeline !== false &&
      doc.linkedEntityType &&
      doc.linkedEntityId
    ) {
      const snippet =
        displayContent.length > 220
          ? `${displayContent.slice(0, 217)}...`
          : displayContent;
      const viaLabel =
        deliveryProvider === 'meta_cloud'
          ? 'Meta Cloud API'
          : via === 'wa_me'
            ? 'WhatsApp Web'
            : 'CRM Inbox';
      const tplLabel = templateMeta.templateName
        ? ` · Template: ${templateMeta.templateName}`
        : params.metaTemplate?.name
          ? ` · Meta Template: ${params.metaTemplate.name}`
          : '';
      const attachLabel = storedAttachment
        ? ` · [${storedAttachment.filename || storedAttachment.type}]`
        : '';
      const summary = `WhatsApp Sent (${viaLabel}${tplLabel}${attachLabel}): "${snippet}"`;
      timelineLogged = await this.appendWhatsAppTimelineToEntity(
        auth.tenantId,
        doc.linkedEntityType,
        doc.linkedEntityId,
        auth.name,
        summary,
      );
    }

    return timelineLogged;
  }

  /**
   * Programmatic outbound WhatsApp dispatch used by Campaigns & Workflows.
   * Respects buyer DND opt-out, uses built-in Leadsetu / tenant Meta runtime,
   * logs to buyer's /inbox ConversationThread, and writes CRM timeline activity.
   */
  async dispatchAutomatedWhatsApp(params: {
    tenantId: string;
    userId: string;
    actorName: string;
    linkedEntityType: 'lead' | 'contact' | 'deal';
    linkedEntityId: string;
    contactName: string;
    company?: string;
    phone: string;
    city?: string;
    estimatedValue?: number;
    messageBody: string;
    metaTemplateName?: string;
    languageCode?: string;
    sendMode?: 'text' | 'meta_template';
    attachment?: ChatAttachment;
    campaignId?: string;
    campaignName?: string;
    workflowId?: string;
    workflowName?: string;
    timelineMarker?: string;
  }): Promise<{
    skippedDnd: boolean;
    reason?: string;
    conversationId?: string;
    messageId?: string;
    externalMessageId?: string;
    status?: 'sent' | 'delivered' | 'read' | 'failed';
    deliveryProvider?: 'meta_cloud' | 'crm_local';
    deliveryError?: string;
    renderedMessage?: string;
  }> {
    const tenantOid = new Types.ObjectId(params.tenantId);
    const targetLast10 = extractLast10Digits(params.phone);
    if (targetLast10.length < 10) {
      return {
        skippedDnd: false,
        status: 'failed',
        deliveryProvider: 'crm_local',
        deliveryError: 'Invalid or missing 10-digit WhatsApp phone number.',
      };
    }

    let doc: ConversationDocument | null = null;
    if (Types.ObjectId.isValid(params.linkedEntityId)) {
      doc = await this.convModel
        .findOne({
          tenantId: tenantOid,
          linkedEntityType: params.linkedEntityType,
          linkedEntityId: params.linkedEntityId,
        })
        .exec();
    }

    if (!doc) {
      const candidates = await this.convModel
        .find({
          tenantId: tenantOid,
          channel: 'whatsapp',
          phone: { $ne: '' },
        })
        .sort({ updatedAt: -1 })
        .exec();
      doc =
        candidates.find((c) => extractLast10Digits(c.phone) === targetLast10) ||
        null;
    }

    if (doc?.whatsappOptOut) {
      return {
        skippedDnd: true,
        reason: 'Buyer opted out via WhatsApp (STOP / DND active).',
        conversationId: doc._id.toString(),
      };
    }

    if (!doc) {
      const formattedPhone =
        normalizeIndianPhone(params.phone) || params.phone.trim();
      doc = new this.convModel({
        tenantId: tenantOid,
        ownerId: Types.ObjectId.isValid(params.userId)
          ? new Types.ObjectId(params.userId)
          : undefined,
        contactName: params.contactName || formattedPhone,
        company: params.company || '',
        phone: formattedPhone,
        city: params.city || 'Delhi-NCR',
        channel: 'whatsapp',
        status: 'open',
        aiScore: 80,
        estimatedValue: Number(params.estimatedValue || 0) || 0,
        linkedEntityType: params.linkedEntityType,
        linkedEntityId: params.linkedEntityId,
        linkedEntityLabel: params.company
          ? `${params.contactName} (${params.company})`
          : params.contactName,
        unreadCount: 0,
        messages: [],
      });
    } else if (!doc.linkedEntityId && Types.ObjectId.isValid(params.linkedEntityId)) {
      doc.linkedEntityType = params.linkedEntityType;
      doc.linkedEntityId = params.linkedEntityId;
      doc.linkedEntityLabel = params.company
        ? `${params.contactName} (${params.company})`
        : params.contactName;
    }

    const vars = this.buildVariableMap({
      contactName: params.contactName || doc.contactName,
      company: params.company || doc.company,
      estimatedValue: params.estimatedValue ?? doc.estimatedValue,
      city: params.city || doc.city,
      phone: params.phone || doc.phone,
      agentName: params.actorName,
    });

    const renderedText = renderTemplateBody(
      String(params.messageBody || '').trim(),
      vars,
    ).rendered.trim();

    await this.superAdminService?.consumeTenantQuota(
      params.tenantId,
      'whatsapp',
      1,
    );

    const [tenant, platform] = await Promise.all([
      this.tenantModel
        .findById(params.tenantId)
        .select('whatsappCloud')
        .lean()
        .exec(),
      this.resolvePlatformProvider(),
    ]);
    const runtime = this.resolveTenantWhatsAppRuntime(tenant, platform);
    const recipientDigits = this.metaWhatsAppService.formatRecipientDigits(
      params.phone || doc.phone,
    );

    let msgStatus: ChatMessage['status'] = 'delivered';
    let externalMessageId = '';
    let deliveryProvider: 'meta_cloud' | 'crm_local' = 'crm_local';
    let deliveryError = '';

    if (
      runtime.active &&
      runtime.phoneNumberId &&
      runtime.accessToken &&
      recipientDigits.length >= 10
    ) {
      deliveryProvider = 'meta_cloud';
      let metaResult;
      if (params.attachment?.url?.trim()) {
        metaResult = await this.metaWhatsAppService.sendAttachment({
          phoneNumberId: runtime.phoneNumberId,
          accessToken: runtime.accessToken,
          toPhone: recipientDigits,
          type: params.attachment.type,
          url: params.attachment.url,
          filename: params.attachment.filename,
          mimeType: params.attachment.mimeType,
          caption: renderedText || undefined,
        });
      } else if (
        params.sendMode === 'meta_template' &&
        params.metaTemplateName?.trim()
      ) {
        const bodyParams: string[] = [];
        if (/\{\{\s*(name|buyer_name)\s*\}\}/i.test(params.messageBody)) {
          bodyParams.push(params.contactName || 'Buyer');
        }
        if (/\{\{\s*company\s*\}\}/i.test(params.messageBody)) {
          bodyParams.push(params.company || 'your company');
        }
        metaResult = await this.metaWhatsAppService.sendApprovedTemplate({
          phoneNumberId: runtime.phoneNumberId,
          accessToken: runtime.accessToken,
          toPhone: recipientDigits,
          templateName: params.metaTemplateName.trim(),
          languageCode: params.languageCode || 'en',
          bodyParams,
        });
      } else {
        metaResult = await this.metaWhatsAppService.sendText({
          phoneNumberId: runtime.phoneNumberId,
          accessToken: runtime.accessToken,
          toPhone: recipientDigits,
          body: renderedText,
        });
      }

      if (metaResult.ok) {
        msgStatus = 'sent';
        externalMessageId = metaResult.externalMessageId || '';
      } else {
        msgStatus = 'failed';
        deliveryError = metaResult.error || 'Meta WhatsApp API send failed';
      }
    }

    const nowIso = new Date().toISOString();
    const newMsg: ChatMessage = {
      id: randomBytes(6).toString('hex'),
      direction: 'outbound',
      content: renderedText,
      senderName: params.actorName,
      status: msgStatus,
      ...(params.metaTemplateName
        ? { metaTemplateName: params.metaTemplateName }
        : {}),
      ...(params.campaignId ? { campaignId: params.campaignId } : {}),
      ...(params.workflowId ? { workflowId: params.workflowId } : {}),
      ...(externalMessageId ? { externalMessageId } : {}),
      ...(params.attachment ? { attachment: params.attachment } : {}),
      deliveryProvider,
      ...(deliveryError ? { deliveryError } : {}),
      statusUpdatedAt: nowIso,
      via: 'inbox',
      createdAt: nowIso,
    };

    doc.messages = [...(doc.messages || []), newMsg];
    doc.status = 'open';
    doc.unreadCount = 0;
    doc.markModified('messages');
    await doc.save();
    this.emitRealtimeConversationUpdate(doc, 'message.outbound');

    if (Types.ObjectId.isValid(params.linkedEntityId)) {
      const snippet =
        renderedText.length > 200
          ? `${renderedText.slice(0, 197)}...`
          : renderedText;
      const sourceLabel = params.campaignName
        ? `Campaign "${params.campaignName}"`
        : params.workflowName
          ? `Workflow "${params.workflowName}"`
          : 'Automated WhatsApp';
      const markerSuffix = params.timelineMarker
        ? ` ${params.timelineMarker}`
        : '';
      await this.appendWhatsAppTimelineToEntity(
        params.tenantId,
        params.linkedEntityType,
        params.linkedEntityId,
        params.actorName,
        `${sourceLabel} (${deliveryProvider === 'meta_cloud' ? 'Meta Cloud' : 'CRM Inbox'}): "${snippet}"${markerSuffix}`,
      );
    }

    return {
      skippedDnd: false,
      conversationId: doc._id.toString(),
      messageId: newMsg.id,
      externalMessageId,
      status: msgStatus,
      deliveryProvider,
      deliveryError,
      renderedMessage: renderedText,
    };
  }

  /**
   * Mark or unmark a buyer phone number as opted-out (STOP / DND) across Inbox conversations and CRM Leads/Contacts.
   */
  async setPhoneOptOut(
    tenantId: string,
    phone: string,
    optOut: boolean,
  ): Promise<void> {
    const tenantOid = new Types.ObjectId(tenantId);
    const last10 = extractLast10Digits(phone);
    if (last10.length < 10) return;

    const nowIso = new Date().toISOString();
    const convCandidates = await this.convModel
      .find({ tenantId: tenantOid, phone: { $ne: '' } })
      .exec();
    const matchingConvs = convCandidates.filter(
      (c) => extractLast10Digits(c.phone) === last10,
    );

    for (const conv of matchingConvs) {
      conv.whatsappOptOut = optOut;
      conv.whatsappOptOutAt = optOut ? nowIso : '';
      await conv.save();
    }

    if (matchingConvs.length === 0 && optOut) {
      await this.convModel.create({
        tenantId: tenantOid,
        contactName: phone,
        phone: normalizeIndianPhone(phone) || phone,
        channel: 'whatsapp',
        status: 'resolved',
        whatsappOptOut: true,
        whatsappOptOutAt: nowIso,
        messages: [],
      });
    }

    // Sync DND tag on Leads & Contacts
    const [leads, contacts] = await Promise.all([
      this.leadModel.find({ tenantId: tenantOid, phone: { $ne: '' } }).exec(),
      this.contactModel.find({ tenantId: tenantOid, phone: { $ne: '' } }).exec(),
    ]);

    for (const lead of leads) {
      if (extractLast10Digits(lead.phone) !== last10) continue;
      const tags = (lead.tags || []).filter(
        (t) => !/^(dnd|opt_out|opted_out|unsubscribed)$/i.test(String(t)),
      );
      if (optOut) tags.push('DND');
      lead.tags = tags;
      await lead.save();
    }

    for (const contact of contacts) {
      if (extractLast10Digits(contact.phone) !== last10) continue;
      const tags = (contact.tags || []).filter(
        (t) => !/^(dnd|opt_out|opted_out|unsubscribed)$/i.test(String(t)),
      );
      if (optOut) tags.push('DND');
      contact.tags = tags;
      await contact.save();
    }
  }

  private computeCampaignAggregateCounts(
    recipients: Array<Record<string, unknown>>,
  ) {
    const sentCount = recipients.filter((r) =>
      ['sent', 'delivered', 'read', 'replied'].includes(String(r.status)),
    ).length;
    const deliveredCount = recipients.filter((r) =>
      ['delivered', 'read', 'replied'].includes(String(r.status)),
    ).length;
    const readCount = recipients.filter((r) =>
      ['read', 'replied'].includes(String(r.status)),
    ).length;
    const repliedCount = recipients.filter(
      (r) => String(r.status) === 'replied',
    ).length;
    const failedCount = recipients.filter(
      (r) => String(r.status) === 'failed',
    ).length;
    const skippedDndCount = recipients.filter(
      (r) => String(r.status) === 'opted_out',
    ).length;

    return {
      sentCount,
      deliveredCount,
      readCount,
      repliedCount,
      failedCount,
      skippedDndCount,
    };
  }

  private async syncCampaignStatusTickByWamid(
    tenantId: Types.ObjectId | null,
    wamid: string,
    rawStatus: 'sent' | 'delivered' | 'read' | 'failed',
    errorText: string,
    nowIso: string,
  ): Promise<boolean> {
    try {
      const campaignsCol = this.convModel.db.collection('campaigns');
      const filter: Record<string, unknown> = {
        ...(tenantId ? { tenantId } : {}),
        'recipients.externalMessageId': wamid,
      };
      const campaignDocs = await campaignsCol.find(filter).toArray();
      let updatedAny = false;

      for (const camp of campaignDocs) {
        const recipients = Array.isArray(camp.recipients)
          ? (camp.recipients as Array<Record<string, unknown>>)
          : [];
        let changed = false;

        const nextRecipients = recipients.map((r) => {
          if (r.externalMessageId !== wamid) return r;
          const curStatus = String(r.status || 'sent');
          if (curStatus === 'replied' || curStatus === 'opted_out') return r;

          if (rawStatus === 'failed') {
            changed = true;
            return { ...r, status: 'failed', error: errorText };
          }

          const rankMap: Record<string, number> = {
            sent: 1,
            delivered: 2,
            read: 3,
            replied: 4,
          };
          if ((rankMap[rawStatus] || 0) >= (rankMap[curStatus] || 0) || curStatus === 'failed') {
            changed = true;
            return {
              ...r,
              status: rawStatus,
              ...(rawStatus === 'delivered' && !r.deliveredAt
                ? { deliveredAt: nowIso }
                : {}),
              ...(rawStatus === 'read'
                ? { deliveredAt: r.deliveredAt || nowIso, readAt: nowIso }
                : {}),
              error: '',
            };
          }
          return r;
        });

        if (changed) {
          const counts = this.computeCampaignAggregateCounts(nextRecipients);
          await campaignsCol.updateOne(
            { _id: camp._id },
            {
              $set: {
                recipients: nextRecipients,
                ...counts,
              },
            },
          );
          updatedAny = true;
        }
      }
      return updatedAny;
    } catch {
      return false;
    }
  }

  private async syncCampaignInboundReply(
    tenantId: Types.ObjectId,
    fromPhone: string,
    replyText: string,
    nowIso: string,
  ): Promise<void> {
    const last10 = extractLast10Digits(fromPhone);
    if (last10.length < 10) return;

    try {
      const campaignsCol = this.convModel.db.collection('campaigns');
      const campaignDocs = await campaignsCol
        .find({ tenantId, 'recipients.0': { $exists: true } })
        .toArray();

      for (const camp of campaignDocs) {
        const recipients = Array.isArray(camp.recipients)
          ? (camp.recipients as Array<Record<string, unknown>>)
          : [];
        let changed = false;

        const nextRecipients = recipients.map((r) => {
          if (extractLast10Digits(String(r.phone || '')) !== last10) return r;
          const curStatus = String(r.status || '');
          if (['sent', 'delivered', 'read', 'replied'].includes(curStatus)) {
            changed = true;
            return {
              ...r,
              status: 'replied',
              deliveredAt: r.deliveredAt || nowIso,
              readAt: r.readAt || nowIso,
              repliedAt: r.repliedAt || nowIso,
              replyPreview: replyText.slice(0, 140),
            };
          }
          return r;
        });

        if (changed) {
          const counts = this.computeCampaignAggregateCounts(nextRecipients);
          await campaignsCol.updateOne(
            { _id: camp._id },
            {
              $set: {
                recipients: nextRecipients,
                ...counts,
              },
            },
          );
        }
      }
    } catch {
      // Non-blocking campaign reply attribution
    }
  }

  // ─── Conversations CRUD & Linking ──────────────────────────────────────────

  async findAll(
    auth: InboxAuthContext,
    query: { status?: string; channel?: string; search?: string },
  ) {
    const tenantObjectId = new Types.ObjectId(auth.tenantId);
    const ownerScope = await resolveOwnerScopeFilter(this.convModel.db, auth);
    const filter: Record<string, unknown> = {
      tenantId: tenantObjectId,
      ...ownerScope,
    };

    if (query.status && query.status !== 'all') filter.status = query.status;
    if (query.channel && query.channel !== 'all') filter.channel = query.channel;
    if (query.search?.trim()) {
      const escaped = query.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escaped, 'i');
      filter.$or = [
        { contactName: regex },
        { company: regex },
        { phone: regex },
        { linkedEntityLabel: regex },
      ];
    }

    const [docs, maskPhones] = await Promise.all([
      this.convModel.find(filter).sort({ updatedAt: -1 }).exec(),
      this.auditService
        ? this.auditService.shouldMaskViewerPhones(auth.tenantId, auth.userId)
        : Promise.resolve(false),
    ]);
    return {
      data: docs.map((d) => this.toDto(d, maskPhones)),
    };
  }

  async startOrGetConversation(
    auth: InboxAuthContext,
    body: StartConversationInput,
  ) {
    const tenantOid = new Types.ObjectId(auth.tenantId);
    const channel = body.channel || 'whatsapp';
    const linkedType: LinkedCrmEntityType =
      body.linkedEntityType &&
      ['lead', 'contact', 'deal', 'ticket'].includes(body.linkedEntityType)
        ? body.linkedEntityType
        : '';
    const linkedId =
      linkedType && body.linkedEntityId && Types.ObjectId.isValid(body.linkedEntityId)
        ? body.linkedEntityId
        : '';

    const snapshot = linkedType && linkedId
      ? await this.resolveCrmEntitySnapshot(auth.tenantId, linkedType, linkedId)
      : null;

    if (linkedType && linkedId && !snapshot) {
      throw new NotFoundException('Linked CRM record not found.');
    }

    const contactName =
      String(body.contactName || '').trim() ||
      snapshot?.contactName ||
      String(body.phone || '').trim();
    const company = String(body.company || '').trim() || snapshot?.company || '';
    const phone = String(body.phone || '').trim() || snapshot?.phone || '';
    const city = String(body.city || '').trim() || snapshot?.city || 'Delhi-NCR';
    const estimatedValue =
      body.estimatedValue !== undefined
        ? Number(body.estimatedValue) || 0
        : snapshot?.estimatedValue || 0;
    const linkedEntityLabel = snapshot?.entityLabel || '';

    if (!contactName && !phone) {
      throw new BadRequestException(
        'Contact name or phone number is required to start a conversation.',
      );
    }

    let doc: ConversationDocument | null = null;

    if (linkedType && linkedId) {
      doc = await this.convModel
        .findOne({
          tenantId: tenantOid,
          linkedEntityType: linkedType,
          linkedEntityId: linkedId,
        })
        .exec();
    }

    if (!doc) {
      const targetLast10 = extractLast10Digits(phone);
      if (targetLast10.length === 10) {
        const candidates = await this.convModel
          .find({
            tenantId: tenantOid,
            channel,
            phone: { $ne: '' },
            ...(linkedType && linkedId ? { linkedEntityId: '' } : {}),
          })
          .sort({ updatedAt: -1 })
          .exec();
        doc =
          candidates.find(
            (c) => extractLast10Digits(c.phone) === targetLast10,
          ) || null;
      }
    }

    let created = false;
    if (!doc) {
      doc = new this.convModel({
        tenantId: tenantOid,
        ownerId: Types.ObjectId.isValid(auth.userId)
          ? new Types.ObjectId(auth.userId)
          : undefined,
        contactName: contactName || phone,
        company,
        phone,
        city,
        channel,
        status: 'open',
        aiScore: snapshot?.aiScore ?? 80,
        estimatedValue,
        linkedEntityType: linkedType,
        linkedEntityId: linkedId,
        linkedEntityLabel,
        unreadCount: 0,
        messages: [],
      });
      created = true;
    } else {
      if (linkedType && linkedId && !doc.linkedEntityId) {
        doc.linkedEntityType = linkedType;
        doc.linkedEntityId = linkedId;
        doc.linkedEntityLabel = linkedEntityLabel;
      }
      if (!doc.company && company) doc.company = company;
      if (!doc.city && city) doc.city = city;
      if (!doc.estimatedValue && estimatedValue) doc.estimatedValue = estimatedValue;
      if (!doc.phone && phone) doc.phone = phone;
    }

    let timelineLogged = false;
    const hasInitialPayload = Boolean(
      body.initialMessage?.trim() ||
        body.attachment?.url?.trim() ||
        (body.sendMode === 'meta_template' && body.metaTemplate?.name),
    );
    if (hasInitialPayload) {
      timelineLogged = await this.appendMessageAndTimeline({
        auth,
        doc,
        rawContent: body.initialMessage?.trim(),
        isAiDrafted: body.isAiDrafted,
        templateId: body.templateId,
        via: body.via || 'inbox',
        logToTimeline: body.logToTimeline,
        sendMode: body.sendMode,
        metaTemplate: body.metaTemplate,
        attachment: body.attachment,
        entitySnapshot: snapshot,
      });
    }

    await doc.save();
    this.emitRealtimeConversationUpdate(
      doc,
      hasInitialPayload ? 'message.outbound' : 'conversation.updated',
    );

    const maskPhones = this.auditService
      ? await this.auditService.shouldMaskViewerPhones(auth.tenantId, auth.userId)
      : false;

    return {
      conversation: this.toDto(doc, maskPhones),
      created,
      timelineLogged,
    };
  }

  async linkEntity(
    auth: InboxAuthContext,
    conversationId: string,
    body: { linkedEntityType: LinkedCrmEntityType; linkedEntityId?: string },
  ) {
    if (!Types.ObjectId.isValid(conversationId)) {
      throw new NotFoundException('Conversation not found.');
    }
    const ownerScope = await resolveOwnerScopeFilter(this.convModel.db, auth);
    const doc = await this.convModel
      .findOne({
        _id: new Types.ObjectId(conversationId),
        tenantId: new Types.ObjectId(auth.tenantId),
        ...ownerScope,
      })
      .exec();
    if (!doc) throw new NotFoundException('Conversation not found.');

    if (!body.linkedEntityType) {
      doc.linkedEntityType = '';
      doc.linkedEntityId = '';
      doc.linkedEntityLabel = '';
    } else {
      if (!body.linkedEntityId || !Types.ObjectId.isValid(body.linkedEntityId)) {
        throw new BadRequestException('Valid CRM entity ID is required.');
      }
      const snapshot = await this.resolveCrmEntitySnapshot(
        auth.tenantId,
        body.linkedEntityType,
        body.linkedEntityId,
      );
      if (!snapshot) throw new NotFoundException('Linked CRM record not found.');
      doc.linkedEntityType = body.linkedEntityType;
      doc.linkedEntityId = body.linkedEntityId;
      doc.linkedEntityLabel = snapshot.entityLabel;
      if (!doc.company && snapshot.company) doc.company = snapshot.company;
      if (!doc.city && snapshot.city) doc.city = snapshot.city;
      if (!doc.estimatedValue && snapshot.estimatedValue) {
        doc.estimatedValue = snapshot.estimatedValue;
      }
      if (!doc.phone && snapshot.phone) doc.phone = snapshot.phone;
    }

    await doc.save();
    this.emitRealtimeConversationUpdate(doc, 'conversation.updated');
    const maskPhones = this.auditService
      ? await this.auditService.shouldMaskViewerPhones(auth.tenantId, auth.userId)
      : false;
    return this.toDto(doc, maskPhones);
  }

  async sendMessage(
    auth: InboxAuthContext,
    id: string,
    body: SendInboxMessageInput,
  ) {
    if (!Types.ObjectId.isValid(id))
      throw new NotFoundException('Conversation not found.');
    if (
      !body.content?.trim() &&
      !(body.sendMode === 'meta_template' && body.metaTemplate?.name) &&
      !body.attachment?.url?.trim()
    ) {
      throw new BadRequestException('Message cannot be empty.');
    }

    const ownerScope = await resolveOwnerScopeFilter(this.convModel.db, auth);
    const doc = await this.convModel
      .findOne({
        _id: new Types.ObjectId(id),
        tenantId: new Types.ObjectId(auth.tenantId),
        ...ownerScope,
      })
      .exec();
    if (!doc) throw new NotFoundException('Conversation not found.');

    const snapshot =
      doc.linkedEntityType && doc.linkedEntityId
        ? await this.resolveCrmEntitySnapshot(
            auth.tenantId,
            doc.linkedEntityType,
            doc.linkedEntityId,
          )
        : null;

    await this.appendMessageAndTimeline({
      auth,
      doc,
      rawContent: body.content?.trim(),
      isAiDrafted: body.isAiDrafted,
      templateId: body.templateId,
      via: body.via || 'inbox',
      logToTimeline: body.logToTimeline,
      sendMode: body.sendMode,
      metaTemplate: body.metaTemplate,
      attachment: body.attachment,
      entitySnapshot: snapshot,
    });

    doc.aiSuggestedReply = '';
    await doc.save();
    this.emitRealtimeConversationUpdate(doc, 'message.outbound');
    const maskPhones = this.auditService
      ? await this.auditService.shouldMaskViewerPhones(auth.tenantId, auth.userId)
      : false;
    return this.toDto(doc, maskPhones);
  }

  async updateStatus(
    auth: InboxAuthContext,
    id: string,
    status: 'open' | 'resolved',
  ) {
    if (!Types.ObjectId.isValid(id))
      throw new NotFoundException('Conversation not found.');
    const ownerScope = await resolveOwnerScopeFilter(this.convModel.db, auth);
    const doc = await this.convModel
      .findOne({
        _id: new Types.ObjectId(id),
        tenantId: new Types.ObjectId(auth.tenantId),
        ...ownerScope,
      })
      .exec();
    if (!doc) throw new NotFoundException('Conversation not found.');
    doc.status = status;
    if (status === 'resolved') doc.unreadCount = 0;
    await doc.save();
    this.emitRealtimeConversationUpdate(doc, 'conversation.updated');
    const maskPhones = this.auditService
      ? await this.auditService.shouldMaskViewerPhones(auth.tenantId, auth.userId)
      : false;
    return this.toDto(doc, maskPhones);
  }

  async markConversationRead(auth: InboxAuthContext, id: string) {
    if (!Types.ObjectId.isValid(id))
      throw new NotFoundException('Conversation not found.');
    const ownerScope = await resolveOwnerScopeFilter(this.convModel.db, auth);
    const doc = await this.convModel
      .findOneAndUpdate(
        {
          _id: new Types.ObjectId(id),
          tenantId: new Types.ObjectId(auth.tenantId),
          ...ownerScope,
        },
        { $set: { unreadCount: 0 } },
        { new: true },
      )
      .exec();
    if (!doc) throw new NotFoundException('Conversation not found.');
    this.emitRealtimeConversationUpdate(doc, 'conversation.updated');
    const maskPhones = this.auditService
      ? await this.auditService.shouldMaskViewerPhones(auth.tenantId, auth.userId)
      : false;
    return this.toDto(doc, maskPhones);
  }

  // ─── SetuAI Inbox Reply Draft & Conversation Summary ───────────────────────

  private async buildConversationAiContext(
    tenantId: string,
    conv: ConversationDocument,
    opts?: {
      language?: string;
      tone?: string;
      customInstruction?: string;
    },
  ) {
    const tenantOid = new Types.ObjectId(tenantId);
    const db = this.convModel.db;
    const msgs = (conv.messages || []).slice(-8);
    const lastInbound =
      [...msgs].reverse().find((m) => m.direction === 'inbound')?.content ||
      msgs[msgs.length - 1]?.content ||
      '';

    const recentMessages = msgs.map((m) => ({
      direction: m.direction,
      sender: m.direction === 'inbound' ? conv.contactName : m.senderName || 'Sales Rep',
      content: m.content,
      createdAt: m.createdAt,
    }));

    const transcript = recentMessages
      .map((m) => `${m.sender}: ${m.content}`)
      .join('\n');

    // Load active product SKUs relevant to conversation text
    let productsCatalog: Array<{
      name: string;
      sku: string;
      hsnSac: string;
      moq: number;
      unit: string;
      unitPrice: number;
      gstRate: number;
      description: string;
      brochureUrl: string;
    }> = [];
    try {
      const products = await db
        .collection('products')
        .find({ tenantId: tenantOid, isActive: { $ne: false } })
        .sort({ updatedAt: -1 })
        .limit(20)
        .toArray();
      const lowerText = transcript.toLowerCase();
      const matched = products.filter((p) => {
        const nameWords = String(p.name || '')
          .toLowerCase()
          .split(/\s+/)
          .filter((w) => w.length >= 4);
        const sku = String(p.sku || '').toLowerCase();
        const hsn = String(p.hsnSac || '').toLowerCase();
        return (
          (sku && lowerText.includes(sku)) ||
          (hsn && lowerText.includes(hsn)) ||
          nameWords.some((w) => lowerText.includes(w))
        );
      });
      const picked = (matched.length > 0 ? matched : products).slice(0, 5);
      productsCatalog = picked.map((p) => ({
        name: String(p.name || ''),
        sku: String(p.sku || ''),
        hsnSac: String(p.hsnSac || '850440'),
        moq: Number(p.moq || 1),
        unit: String(p.unit || 'pcs'),
        unitPrice: Number(p.unitPrice ?? p.price ?? 0),
        gstRate: Number(p.gstRate ?? 18),
        description: String(p.description || ''),
        brochureUrl: String(p.brochureUrl || ''),
      }));
    } catch {
      productsCatalog = [];
    }

    // Load Document Vault brochures / GST certificates / specs for this workspace
    let documentsVault: Array<{
      docCode: string;
      title: string;
      category: string;
      documentNumber: string;
      description: string;
      externalUrl: string;
    }> = [];
    try {
      const docs = await db
        .collection('documents')
        .find({ tenantId: tenantOid })
        .sort({ createdAt: -1 })
        .limit(6)
        .toArray();
      documentsVault = docs.map((d) => ({
        docCode: String(d.docCode || ''),
        title: String(d.title || ''),
        category: String(d.category || 'brochure'),
        documentNumber: String(d.documentNumber || ''),
        description: String(d.description || ''),
        externalUrl: String(d.externalUrl || ''),
      }));
    } catch {
      documentsVault = [];
    }

    // Load recent quotations / invoices for this buyer
    let quoteContext: Array<{
      invoiceNumber: string;
      docType: string;
      grandTotal: number;
      balanceDue: number;
      paymentLink: string;
      status: string;
    }> = [];
    try {
      const last10 = extractLast10Digits(conv.phone);
      const orClauses: Record<string, unknown>[] = [];
      if (conv.linkedEntityType === 'lead' && conv.linkedEntityId) {
        orClauses.push({ linkedLeadId: conv.linkedEntityId });
      }
      if (conv.linkedEntityType === 'deal' && conv.linkedEntityId) {
        orClauses.push({ linkedDealId: conv.linkedEntityId });
      }
      if (last10.length >= 10) {
        orClauses.push({ phone: { $regex: last10 } });
      }
      if (conv.company) {
        orClauses.push({ clientName: conv.company });
      }
      if (orClauses.length > 0) {
        const invs = await db
          .collection('invoices')
          .find({ tenantId: tenantOid, $or: orClauses })
          .sort({ createdAt: -1 })
          .limit(3)
          .toArray();
        quoteContext = invs.map((i) => ({
          invoiceNumber: String(i.invoiceNumber || ''),
          docType: String(i.docType || 'tax_invoice'),
          grandTotal: Number(i.grandTotal || 0),
          balanceDue: Number(i.balanceDue || 0),
          paymentLink: String(i.paymentLink || ''),
          status: String(i.status || ''),
        }));
      }
    } catch {
      quoteContext = [];
    }

    return {
      conversationId: conv._id.toString(),
      buyerName: conv.contactName,
      contactName: conv.contactName,
      company: conv.company || '',
      city: conv.city || 'Delhi-NCR',
      phone: conv.phone || '',
      estimatedValue: conv.estimatedValue || 0,
      language: opts?.language || 'hinglish',
      tone: opts?.tone || 'helpful',
      customInstruction: opts?.customInstruction || '',
      lastInboundMessage: lastInbound,
      recentMessages,
      messages: recentMessages,
      transcript,
      productsCatalog,
      documentsVault,
      quoteContext,
    };
  }

  private buildLocalConversationAiFallback(ctx: {
    buyerName: string;
    company: string;
    city: string;
    language: string;
    lastInboundMessage: string;
    productsCatalog: Array<{ name: string; unitPrice: number }>;
    quoteContext: Array<{
      invoiceNumber: string;
      grandTotal: number;
      paymentLink: string;
    }>;
  }) {
    const lower = (ctx.lastInboundMessage || '').toLowerCase();
    const topProduct = ctx.productsCatalog[0];
    const topQuote = ctx.quoteContext[0];
    const productHint = topProduct?.name
      ? `${topProduct.name}${
          topProduct.unitPrice
            ? ` (₹${Number(topProduct.unitPrice).toLocaleString('en-IN')})`
            : ''
        }`
      : 'your product requirement';

    let replyDraft = '';
    if (ctx.language === 'english') {
      if (topQuote?.invoiceNumber && /quote|invoice|price|rate|pay|bill/i.test(lower)) {
        replyDraft = `Hello ${ctx.buyerName}${ctx.company ? ` (${ctx.company})` : ''}, ${topQuote.invoiceNumber} for ₹${topQuote.grandTotal.toLocaleString('en-IN')} is ready.${
          topQuote.paymentLink ? ` Pay link: ${topQuote.paymentLink}.` : ''
        } Please confirm dispatch timing for ${ctx.city}.`;
      } else {
        replyDraft = `Hello ${ctx.buyerName}${ctx.company ? ` (${ctx.company})` : ''}, thank you for contacting us regarding ${productHint}. We supply with 18% GST billing and priority dispatch to ${ctx.city}. Please confirm required quantity/MOQ.`;
      }
    } else if (
      topQuote?.invoiceNumber &&
      /quote|invoice|price|rate|pay|bill|link/i.test(lower)
    ) {
      replyDraft = `Namaste ${ctx.buyerName} ji! ${topQuote.invoiceNumber} (₹${topQuote.grandTotal.toLocaleString('en-IN')}) ready hai.${
        topQuote.paymentLink ? ` Payment link: ${topQuote.paymentLink}` : ''
      } Kripya confirm karein taaki hum ${ctx.city} dispatch schedule karein.`;
    } else {
      replyDraft = `Namaste ${ctx.buyerName} ji! ${productHint} ke liye 18% GST bill aur best B2B rate available hai (${ctx.city} dispatch). Kripya exact quantity/MOQ share karein taaki hum turant Proforma Quote bhej sakein.`;
    }

    const snippet = (ctx.lastInboundMessage || '').replace(/\s+/g, ' ').trim().slice(0, 140);
    const summary = snippet
      ? `${ctx.buyerName}${ctx.company ? ` (${ctx.company})` : ''} sent: "${snippet}${
          ctx.lastInboundMessage.length > 140 ? '...' : ''
        }" — Confirm quantity/GST quote & dispatch SLA.`
      : `Thread open with ${ctx.buyerName}${ctx.company ? ` (${ctx.company})` : ''} — qualify MOQ, GSTIN, and timeline.`;

    return { replyDraft, summary };
  }

  async generateAiAssistForConversation(
    auth: InboxAuthContext,
    id: string,
    dto?: {
      mode?: 'both' | 'reply' | 'summary';
      language?: 'hinglish' | 'english' | 'hindi';
      tone?: 'helpful' | 'closing' | 'followup';
      customInstruction?: string;
    },
  ) {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Conversation not found.');
    }
    await this.superAdminService?.assertFeatureEnabled(auth.tenantId, 'aiScoring');

    const ownerScope = await resolveOwnerScopeFilter(this.convModel.db, auth);
    const conv = await this.convModel
      .findOne({
        _id: new Types.ObjectId(id),
        tenantId: new Types.ObjectId(auth.tenantId),
        ...ownerScope,
      })
      .exec();
    if (!conv) throw new NotFoundException('Conversation not found.');

    const mode = dto?.mode || 'both';
    const ctx = await this.buildConversationAiContext(auth.tenantId, conv, dto);
    const fallback = this.buildLocalConversationAiFallback(ctx);

    let nextReply = conv.aiSuggestedReply || '';
    let nextSummary = conv.aiSummary || '';
    let provider = 'leadsetu-fallback';
    let model = 'leadsetu-heuristic-v1';

    if (mode === 'both' || mode === 'reply') {
      const replyRes = this.aiBridge
        ? await this.aiBridge.draftWhatsAppReply({
            tenantId: auth.tenantId,
            userId: auth.userId,
            userRole: auth.role,
            context: ctx,
          })
        : null;
      nextReply = replyRes?.result?.trim() || fallback.replyDraft;
      if (replyRes?.provider) provider = replyRes.provider;
      if (replyRes?.model) model = replyRes.model;
    }

    if (mode === 'both' || mode === 'summary') {
      const sumRes = this.aiBridge
        ? await this.aiBridge.summarizeConversation({
            tenantId: auth.tenantId,
            userId: auth.userId,
            userRole: auth.role,
            context: ctx,
          })
        : null;
      nextSummary = sumRes?.result?.trim() || fallback.summary;
      if (sumRes?.provider) provider = sumRes.provider;
      if (sumRes?.model) model = sumRes.model;
    }

    conv.aiSuggestedReply = nextReply;
    conv.aiSummary = nextSummary;
    await conv.save();
    this.emitRealtimeConversationUpdate(conv, 'conversation.updated');

    const maskPhones = this.auditService
      ? await this.auditService.shouldMaskViewerPhones(auth.tenantId, auth.userId)
      : false;

    return {
      conversation: this.toDto(conv, maskPhones),
      aiSummary: conv.aiSummary,
      aiSuggestedReply: conv.aiSuggestedReply,
      provider,
      model,
    };
  }

  async getAiAgentConfig(auth: InboxAuthContext): Promise<AiSalesAgentPolicy> {
    const tenant = await this.tenantModel.findById(auth.tenantId).lean().exec();
    if (!tenant) throw new NotFoundException('Workspace not found.');
    return normalizeAiAgentPolicy(tenant.aiSalesAgentPolicy);
  }

  async updateAiAgentConfig(
    auth: InboxAuthContext,
    dto: Partial<AiSalesAgentPolicy>,
  ): Promise<AiSalesAgentPolicy> {
    if (!['owner', 'admin', 'manager'].includes(auth.role)) {
      throw new ForbiddenException(
        'Only Workspace Owners, Admins, or Managers can update AI Sales Concierge guardrails.',
      );
    }
    const tenant = await this.tenantModel.findById(auth.tenantId).exec();
    if (!tenant) throw new NotFoundException('Workspace not found.');

    const merged = normalizeAiAgentPolicy({
      ...normalizeAiAgentPolicy(tenant.aiSalesAgentPolicy),
      ...dto,
    });

    await this.tenantModel.updateOne(
      { _id: tenant._id },
      { $set: { aiSalesAgentPolicy: merged } },
    );

    await this.auditService?.record({
      tenantId: auth.tenantId,
      actorId: auth.userId,
      action: 'inbox.ai_agent_updated',
      entityType: 'security',
      entityId: auth.tenantId,
      entityLabel: '24x7 AI WhatsApp Sales Concierge',
      summary: `AI Sales Concierge set to ${merged.mode.toUpperCase()} (max discount ${merged.maxDiscountPct}%, handoff score >= ${merged.handoffScoreThreshold})`,
    });

    return merged;
  }

  private toKbDto(doc: Record<string, unknown>) {
    return {
      id: String(doc._id),
      title: String(doc.title || ''),
      category: String(doc.category || 'company_faq') as AiKnowledgeCategory,
      content: String(doc.content || ''),
      tags: Array.isArray(doc.tags) ? (doc.tags as string[]) : [],
      sourceType: String(doc.sourceType || 'manual') as
        | 'manual'
        | 'catalog_sync'
        | 'faq_preset',
      isActive: doc.isActive !== false,
      hitCount: Number(doc.hitCount || 0),
      updatedAt: doc.updatedAt
        ? new Date(doc.updatedAt as string | Date).toISOString()
        : new Date().toISOString(),
    };
  }

  async listKnowledgeBase(
    auth: InboxAuthContext,
    query?: { search?: string; category?: string },
  ) {
    const filter: Record<string, unknown> = {
      tenantId: new Types.ObjectId(auth.tenantId),
    };
    if (query?.category && query.category !== 'all') {
      filter.category = query.category;
    }
    if (query?.search?.trim()) {
      const rx = new RegExp(
        query.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        'i',
      );
      filter.$or = [{ title: rx }, { content: rx }, { tags: rx }];
    }

    const docs = await this.kbModel
      .find(filter)
      .sort({ hitCount: -1, updatedAt: -1 })
      .limit(100)
      .lean()
      .exec();

    const items = docs.map((d) => this.toKbDto(d as Record<string, unknown>));
    return {
      items,
      stats: {
        total: items.length,
        active: items.filter((i) => i.isActive).length,
        totalHits: items.reduce((acc, i) => acc + i.hitCount, 0),
      },
    };
  }

  async createKnowledgeEntry(
    auth: InboxAuthContext,
    dto: {
      title: string;
      category?: AiKnowledgeCategory;
      content: string;
      tags?: string[];
      isActive?: boolean;
    },
  ) {
    if (!['owner', 'admin', 'manager'].includes(auth.role)) {
      throw new ForbiddenException(
        'Only Owners, Admins, or Managers can edit the AI Knowledge Base.',
      );
    }
    const title = String(dto.title || '').trim();
    const content = String(dto.content || '').trim();
    if (!title || !content) {
      throw new BadRequestException('Title and Knowledge Content are required.');
    }

    const doc = await this.kbModel.create({
      tenantId: new Types.ObjectId(auth.tenantId),
      title,
      category: dto.category || 'company_faq',
      content,
      tags: Array.isArray(dto.tags)
        ? dto.tags.map((t) => String(t).trim()).filter(Boolean)
        : [],
      sourceType: 'manual',
      isActive: dto.isActive !== false,
    });

    return this.toKbDto(doc.toObject() as unknown as Record<string, unknown>);
  }

  async updateKnowledgeEntry(
    auth: InboxAuthContext,
    entryId: string,
    dto: Partial<{
      title: string;
      category: AiKnowledgeCategory;
      content: string;
      tags: string[];
      isActive: boolean;
    }>,
  ) {
    if (!['owner', 'admin', 'manager'].includes(auth.role)) {
      throw new ForbiddenException(
        'Only Owners, Admins, or Managers can edit the AI Knowledge Base.',
      );
    }
    if (!Types.ObjectId.isValid(entryId)) {
      throw new NotFoundException('Knowledge entry not found.');
    }
    const doc = await this.kbModel
      .findOne({
        _id: new Types.ObjectId(entryId),
        tenantId: new Types.ObjectId(auth.tenantId),
      })
      .exec();
    if (!doc) throw new NotFoundException('Knowledge entry not found.');

    if (dto.title !== undefined && dto.title.trim()) {
      doc.title = dto.title.trim();
    }
    if (dto.category !== undefined) {
      doc.category = dto.category;
    }
    if (dto.content !== undefined && dto.content.trim()) {
      doc.content = dto.content.trim();
    }
    if (dto.tags !== undefined) {
      doc.tags = dto.tags.map((t) => String(t).trim()).filter(Boolean);
    }
    if (dto.isActive !== undefined) {
      doc.isActive = Boolean(dto.isActive);
    }

    await doc.save();
    return this.toKbDto(doc.toObject() as unknown as Record<string, unknown>);
  }

  async deleteKnowledgeEntry(auth: InboxAuthContext, entryId: string) {
    if (!['owner', 'admin', 'manager'].includes(auth.role)) {
      throw new ForbiddenException(
        'Only Owners, Admins, or Managers can delete KB entries.',
      );
    }
    if (!Types.ObjectId.isValid(entryId)) {
      throw new NotFoundException('Knowledge entry not found.');
    }
    await this.kbModel
      .deleteOne({
        _id: new Types.ObjectId(entryId),
        tenantId: new Types.ObjectId(auth.tenantId),
      })
      .exec();
    return { deleted: true, id: entryId };
  }

  async seedStarterKnowledgeBase(auth: InboxAuthContext) {
    const tenant = await this.tenantModel.findById(auth.tenantId).lean().exec();
    const company = String(tenant?.companyName || tenant?.name || 'our company').trim();
    const tenantOid = new Types.ObjectId(auth.tenantId);

    const presets: Array<{
      refId: string;
      title: string;
      category: AiKnowledgeCategory;
      content: string;
      tags: string[];
    }> = [
      {
        refId: 'preset_warranty_replacement',
        title: 'Warranty, Service & Replacement Guarantee',
        category: 'warranty_returns',
        content: `All ${company} industrial & commercial products carry 18 Months standard replacement warranty against manufacturing defects. Defective units are replaced within 48 hours after photo/video inspection on WhatsApp.`,
        tags: ['warranty', 'guarantee', 'garanti', 'replacement', 'repair', 'defective'],
      },
      {
        refId: 'preset_dispatch_delivery',
        title: 'PAN-India Dispatch, Courier & E-Way Bill Timeline',
        category: 'shipping_dispatch',
        content: `In-stock SKUs dispatch same-day (orders before 4 PM) via Shiprocket, Delhivery Surface, or BlueDart Air with live AWB tracking sent automatically on WhatsApp. Delivery takes 24–48h in Delhi-NCR and 3–5 business days PAN-India; E-Way Bill issued for orders >= ₹50,000.`,
        tags: ['dispatch', 'delivery', 'shipping', 'courier', 'awb', 'transport', 'eway'],
      },
      {
        refId: 'preset_gst_moq_pricing',
        title: '18% GST Input Tax Credit, MOQ & Bulk Slabs',
        category: 'pricing_terms',
        content: `Every order includes Rule-46 Tax Invoice with HSN/SAC codes for 100% GST Input Tax Credit (ITC). Extra bulk slabs are auto-eligible on 50+ units; mention your 15-digit GSTIN on WhatsApp for instant Proforma Quote.`,
        tags: ['gst', 'itc', 'invoice', 'moq', 'bulk', 'rate', 'discount'],
      },
      {
        refId: 'preset_payment_upi_razorpay',
        title: 'Payment Options: Instant UPI QR, Razorpay & NEFT/RTGS',
        category: 'pricing_terms',
        content: `Pay instantly using Dynamic UPI QR / Razorpay Payment Link (UPI, Cards, NetBanking) or Company Current Account NEFT/RTGS. Payment receipts and order tracking links unlock automatically on WhatsApp once settled.`,
        tags: ['payment', 'upi', 'qr', 'razorpay', 'neft', 'rtgs', 'advance'],
      },
      {
        refId: 'preset_demo_consultation',
        title: 'Live Product Demo & Engineering Consultation',
        category: 'company_faq',
        content: `Need a live video walkthrough, technical spec sizing, or bulk dealer quote? Book a 30-minute consultation slot directly via our Leadsetu Booking Calendar and receive instant WhatsApp confirmation + 1-hour reminder.`,
        tags: ['demo', 'sample', 'call', 'book', 'meeting', 'consultation'],
      },
    ];

    let created = 0;
    for (const p of presets) {
      const existing = await this.kbModel
        .findOne({ tenantId: tenantOid, sourceRefId: p.refId })
        .exec();
      if (!existing) {
        await this.kbModel.create({
          tenantId: tenantOid,
          title: p.title,
          category: p.category,
          content: p.content,
          tags: p.tags,
          sourceType: 'faq_preset',
          sourceRefId: p.refId,
          isActive: true,
        });
        created += 1;
      }
    }

    const overview = await this.listKnowledgeBase(auth);
    return { ...overview, newlyAdded: created };
  }

  async syncCatalogToKnowledgeBase(auth: InboxAuthContext) {
    const tenantOid = new Types.ObjectId(auth.tenantId);
    const products = await this.convModel.db
      .collection('products')
      .find({ tenantId: tenantOid, isActive: { $ne: false } })
      .limit(40)
      .toArray();

    let syncedCount = 0;
    for (const p of products) {
      const pid = String(p._id);
      const name = String(p.name || 'SKU').trim();
      const sku = String(p.sku || '').trim();
      const hsn = String(p.hsnSac || '850440').trim();
      const price = Number(p.unitPrice || 0);
      const gst = Number(p.gstRate ?? 18);
      const moq = Number(p.moq || 1);
      const desc = String(p.description || '').trim();

      const content = `${name} (${sku ? `SKU: ${sku}, ` : ''}HSN: ${hsn}) — Base Rate ₹${price.toLocaleString('en-IN')} + ${gst}% GST per ${String(p.unit || 'unit')}, MOQ ${moq}.${desc ? ` ${desc}` : ''}`;

      await this.kbModel.updateOne(
        { tenantId: tenantOid, sourceRefId: `product_${pid}` },
        {
          $set: {
            tenantId: tenantOid,
            title: `${name} (${sku || 'Catalog Spec'})`,
            category: 'product_spec',
            content,
            tags: [
              name.toLowerCase(),
              sku.toLowerCase(),
              hsn.toLowerCase(),
              'catalog',
              'price',
            ].filter(Boolean),
            sourceType: 'catalog_sync',
            sourceRefId: `product_${pid}`,
            isActive: true,
          },
        },
        { upsert: true },
      );
      syncedCount += 1;
    }

    const overview = await this.listKnowledgeBase(auth);
    return { ...overview, syncedProducts: syncedCount };
  }

  async toggleConversationAutopilot(
    auth: InboxAuthContext,
    id: string,
    paused: boolean,
  ) {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Conversation not found.');
    }
    const ownerScope = await resolveOwnerScopeFilter(this.convModel.db, auth);
    const conv = await this.convModel
      .findOne({
        _id: new Types.ObjectId(id),
        tenantId: new Types.ObjectId(auth.tenantId),
        ...ownerScope,
      })
      .exec();
    if (!conv) throw new NotFoundException('Conversation not found.');

    conv.aiAutopilotPaused = Boolean(paused);
    if (!paused) {
      conv.aiHandoffReason = '';
    }
    await conv.save();
    this.emitRealtimeConversationUpdate(conv, 'conversation.updated');

    const maskPhones = this.auditService
      ? await this.auditService.shouldMaskViewerPhones(auth.tenantId, auth.userId)
      : false;
    return this.toDto(conv, maskPhones);
  }

  async simulateInboundMessage(
    auth: InboxAuthContext,
    id: string,
    messageText: string,
  ) {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Conversation not found.');
    }
    const text = String(messageText || '').trim();
    if (!text) {
      throw new BadRequestException('Inbound message text is required.');
    }

    const ownerScope = await resolveOwnerScopeFilter(this.convModel.db, auth);
    const conv = await this.convModel
      .findOne({
        _id: new Types.ObjectId(id),
        tenantId: new Types.ObjectId(auth.tenantId),
        ...ownerScope,
      })
      .exec();
    if (!conv) throw new NotFoundException('Conversation not found.');

    const nowIso = new Date().toISOString();
    const inboundMsg: ChatMessage = {
      id: randomBytes(6).toString('hex'),
      direction: 'inbound',
      content: text,
      senderName: conv.contactName,
      status: 'delivered',
      deliveryProvider: 'crm_local',
      createdAt: nowIso,
    };

    conv.messages = [...(conv.messages || []), inboundMsg];
    conv.status = 'open';
    conv.lastInboundAt = nowIso;
    conv.unreadCount = (conv.unreadCount || 0) + 1;
    conv.markModified('messages');
    await conv.save();
    this.emitRealtimeConversationUpdate(conv, 'message.inbound');

    await this.refreshConversationAiOnInbound(conv, text);

    const refreshed = await this.convModel.findById(conv._id).exec();
    const maskPhones = this.auditService
      ? await this.auditService.shouldMaskViewerPhones(auth.tenantId, auth.userId)
      : false;
    return this.toDto(refreshed || conv, maskPhones);
  }

  private async refreshConversationAiOnInbound(
    conv: ConversationDocument,
    explicitInboundText?: string,
  ) {
    try {
      const tenantId = conv.tenantId.toString();
      const userId = conv.ownerId?.toString() || 'system-webhook';
      const tenant = await this.tenantModel.findById(tenantId).lean().exec();
      const policy = normalizeAiAgentPolicy(tenant?.aiSalesAgentPolicy);
      if (policy.mode === 'off') {
        return;
      }

      const lastInboundText =
        explicitInboundText ||
        [...(conv.messages || [])].reverse().find((m) => m.direction === 'inbound')
          ?.content ||
        '';
      const [ctx, activeKbDocs] = await Promise.all([
        this.buildConversationAiContext(tenantId, conv, {
          language: policy.language === 'auto' ? 'hinglish' : policy.language,
          tone: 'helpful',
        }),
        this.kbModel
          .find({ tenantId: conv.tenantId, isActive: true })
          .select('title category content tags')
          .limit(50)
          .lean()
          .exec(),
      ]);

      const kbBriefs: KnowledgeDocBrief[] = activeKbDocs.map((d) => ({
        id: String(d._id),
        title: String(d.title || ''),
        category: String(d.category || 'company_faq'),
        content: String(d.content || ''),
        tags: Array.isArray(d.tags) ? (d.tags as string[]) : [],
      }));

      const bookingSlug = String(
        (tenant?.leadConnectors as Record<string, Record<string, unknown>> | undefined)
          ?.bookingScheduler?.slug || '',
      ).trim();
      const bookingEnabled =
        (tenant?.leadConnectors as Record<string, Record<string, unknown>> | undefined)
          ?.bookingScheduler?.enabled !== false;
      const bookingPublicUrl =
        bookingEnabled && bookingSlug ? `/book/${bookingSlug}` : '';

      const signals = extractBuyerSignals({
        message: lastInboundText,
        productsCatalog: ctx.productsCatalog,
        kbDocs: kbBriefs,
        existingData: (conv.aiQualifiedData || {}) as AiQualifiedData,
        policy,
      });

      if (signals.bookingIntent && bookingPublicUrl && policy.autoShareBookingLink) {
        signals.data.bookingLinkShared = bookingPublicUrl;
      }

      if (signals.matchedKb.length > 0) {
        const hitIds = signals.matchedKb
          .map((k) => k.id)
          .filter((id) => Types.ObjectId.isValid(id))
          .map((id) => new Types.ObjectId(id));
        if (hitIds.length > 0) {
          void this.kbModel
            .updateMany({ _id: { $in: hitIds } }, { $inc: { hitCount: 1 } })
            .exec();
        }
      }

      const fallbackReply = buildConciergeFallbackReply({
        buyerName: conv.contactName || 'Sir',
        language: signals.detectedLanguage,
        signals,
        policy,
        bookingPublicUrl,
      });
      const fallbackSummary = this.buildLocalConversationAiFallback(ctx).summary;

      const missingFields: string[] = [];
      if (!signals.data.quantity) missingFields.push('quantity');
      if (!signals.data.city) missingFields.push('delivery city');
      if (!signals.data.gstin) missingFields.push('GSTIN (optional)');

      const kbContextText =
        signals.matchedKb.length > 0
          ? `Grounded Company Knowledge Base Facts (cite accurately): ${signals.matchedKb
              .map((k) => `[${k.title}] ${k.snippet}`)
              .join(' | ')}`
          : '';

      const conciergeInstruction = [
        `You are Leadsetu 24x7 AI Sales Concierge.`,
        `Max discount cap is ${policy.maxDiscountPct}% — NEVER approve any discount above ${policy.maxDiscountPct}%.`,
        kbContextText,
        signals.data.productName
          ? `Matched Catalog Item: ${signals.data.productName} (SKU ${signals.data.sku}, HSN ${signals.data.hsnSac}), ₹${signals.data.quotedUnitPrice} + ${signals.data.gstRate ?? 18}% GST, MOQ ${signals.data.moq || 1}.`
          : '',
        signals.bookingIntent && bookingPublicUrl && policy.autoShareBookingLink
          ? `Share our live booking link cleanly: ${bookingPublicUrl}`
          : '',
        signals.discountExceedsCap
          ? `Buyer asked for ${signals.requestedDiscountPct}% discount (> ${policy.maxDiscountPct}% cap). Politely decline auto-approval and tell them a Senior Manager will connect.`
          : missingFields.length > 0 && signals.matchedKb.length === 0
            ? `Ask briefly for: ${missingFields.join(', ')}.`
            : `Answer clearly and warmly in ${signals.detectedLanguage}.`,
      ]
        .filter(Boolean)
        .join(' ');

      const enrichedCtx = {
        ...ctx,
        language: signals.detectedLanguage,
        customInstruction: conciergeInstruction,
      };

      const skipLlmDraft = signals.discountExceedsCap || signals.frustrationDetected;
      const [replyRes, sumRes] = await Promise.all([
        this.aiBridge && !skipLlmDraft
          ? this.aiBridge
              .draftWhatsAppReply({
                tenantId,
                userId,
                userRole: 'owner',
                context: enrichedCtx,
              })
              .catch(() => null)
          : Promise.resolve(null),
        this.aiBridge
          ? this.aiBridge
              .summarizeConversation({
                tenantId,
                userId,
                userRole: 'owner',
                context: enrichedCtx,
              })
              .catch(() => null)
          : Promise.resolve(null),
      ]);

      const finalReply = replyRes?.result?.trim() || fallbackReply;
      const finalSummary = sumRes?.result?.trim() || fallbackSummary;
      const nowIso = new Date().toISOString();

      conv.aiQualifiedData = signals.data as unknown as Record<string, unknown>;
      conv.aiScore = signals.aiScore;
      if (signals.data.estimatedTotal && signals.data.estimatedTotal > 0) {
        conv.estimatedValue = signals.data.estimatedTotal;
      }
      if (signals.data.city) {
        conv.city = signals.data.city;
      }
      conv.aiSummary = finalSummary;
      conv.aiSuggestedReply = finalReply;
      conv.markModified('aiQualifiedData');

      // Sync qualified buyer specs directly onto linked Lead when enabled
      if (
        policy.autoUpdateLeadFields &&
        conv.linkedEntityType === 'lead' &&
        conv.linkedEntityId &&
        Types.ObjectId.isValid(conv.linkedEntityId)
      ) {
        try {
          const leadUpdates: Record<string, unknown> = {
            aiScore: signals.aiScore,
            aiLabel: signals.aiLabel,
            aiSummary: finalSummary,
            aiNextAction: signals.handoffTriggered
              ? `HOT AI HANDOFF: ${signals.handoffReason}`
              : 'AI Concierge qualifying quantity, city & GSTIN on WhatsApp.',
          };
          if (signals.data.city) leadUpdates.city = signals.data.city;
          if (signals.data.estimatedTotal && signals.data.estimatedTotal > 0) {
            leadUpdates.estimatedValue = signals.data.estimatedTotal;
          }
          const summaryBits = [
            signals.data.productName ? `Product: ${signals.data.productName}` : '',
            signals.data.quantity ? `Qty: ${signals.data.quantity}` : '',
            signals.data.city ? `City: ${signals.data.city}` : '',
            signals.data.gstin ? `GSTIN: ${signals.data.gstin}` : '',
          ]
            .filter(Boolean)
            .join(' · ');

          await this.leadModel.updateOne(
            { _id: new Types.ObjectId(conv.linkedEntityId), tenantId: conv.tenantId },
            {
              $set: leadUpdates,
              ...(summaryBits
                ? {
                    $push: {
                      activities: {
                        $each: [
                          {
                            id: randomBytes(6).toString('hex'),
                            type: 'ai_score',
                            description: `SetuAI 24x7 Concierge qualified Lead (${signals.aiScore}/100 · ${signals.aiLabel}): ${summaryBits}`,
                            authorName: 'SetuAI Concierge (24x7)',
                            createdAt: nowIso,
                          },
                        ],
                        $position: 0,
                      },
                    },
                  }
                : {}),
            } as Record<string, unknown>,
          );
        } catch {
          // Non-blocking lead enrichment
        }
      }

      const logs: AiActionLogItem[] = Array.isArray(conv.aiActionLogs)
        ? [...(conv.aiActionLogs as AiActionLogItem[])]
        : [];

      const withinHours = !policy.businessHoursOnly || isWithinIstBusinessHours();
      if (
        policy.mode === 'autopilot' &&
        !conv.aiAutopilotPaused &&
        !conv.whatsappOptOut &&
        withinHours
      ) {
        const snapshot =
          conv.linkedEntityType && conv.linkedEntityId
            ? await this.resolveCrmEntitySnapshot(
                tenantId,
                conv.linkedEntityType,
                conv.linkedEntityId,
              )
            : null;

        await this.appendMessageAndTimeline({
          auth: {
            userId,
            tenantId,
            email: 'ai-concierge@leadsetu.in',
            name: 'SetuAI Concierge (24x7)',
            role: 'system',
          },
          doc: conv,
          rawContent: finalReply,
          isAiDrafted: true,
          via: 'inbox',
          logToTimeline: true,
          entitySnapshot: snapshot,
        });

        conv.aiSuggestedReply = '';
        if (signals.handoffTriggered) {
          conv.aiAutopilotPaused = true;
          conv.aiHandoffReason = signals.handoffReason;
          conv.aiHandedOffAt = nowIso;
        }

        const kbTag =
          signals.matchedKb.length > 0
            ? ` · KB Cited: [${signals.matchedKb.map((k) => k.title).join(', ')}]`
            : '';
        logs.unshift({
          id: randomBytes(5).toString('hex'),
          action:
            signals.discountExceedsCap || signals.frustrationDetected
              ? 'guardrail_blocked'
              : signals.handoffTriggered
                ? 'handoff_triggered'
                : 'autopilot_replied',
          detail: signals.handoffTriggered
            ? `${signals.handoffReason} Auto-reply sent${kbTag} & paused for Sales Rep takeover.`
            : `Auto-replied in ${signals.detectedLanguage}${kbTag} (Score ${signals.aiScore}).`,
          replySent: finalReply.slice(0, 220),
          mode: 'autopilot',
          createdAt: nowIso,
        });
      } else {
        logs.unshift({
          id: randomBytes(5).toString('hex'),
          action: conv.aiAutopilotPaused ? 'skipped_paused' : 'draft_prepared',
          detail: conv.aiAutopilotPaused
            ? `AI Auto-Pilot paused on thread (${conv.aiHandoffReason || 'human rep active'}); updated draft instead.`
            : `Draft-only mode prepared reply & updated AI Score (${signals.aiScore}).`,
          replySent: finalReply.slice(0, 220),
          mode: policy.mode,
          createdAt: nowIso,
        });
      }

      conv.aiActionLogs = logs.slice(0, 25);
      conv.markModified('aiActionLogs');
      await conv.save();
      this.emitRealtimeConversationUpdate(conv, 'conversation.updated');
    } catch {
      // Non-blocking AI auto-concierge hook on webhook arrival
    }
  }

  // ─── Meta Cloud API Webhooks (Challenge + Live Two-Way + Status Ticks) ───

  async verifyMetaWebhookChallenge(
    mode?: string,
    verifyToken?: string,
    challenge?: string,
  ): Promise<string> {
    if (mode !== 'subscribe' || !verifyToken || !challenge) {
      throw new ForbiddenException('Invalid Meta webhook verification parameters.');
    }
    const cleanToken = verifyToken.trim();
    const platform = await this.resolvePlatformProvider();
    if (platform.webhookVerifyToken && cleanToken === platform.webhookVerifyToken) {
      return challenge;
    }

    const matchedTenant = await this.tenantModel
      .findOne({ 'whatsappCloud.verifyToken': cleanToken })
      .select('_id')
      .lean()
      .exec();
    if (!matchedTenant) {
      throw new ForbiddenException('Webhook verify token mismatch.');
    }
    return challenge;
  }

  private extractInboundMetaContent(msg: Record<string, unknown>): {
    text: string;
    attachment?: ChatAttachment;
  } {
    const type = String(msg.type || 'text').toLowerCase();
    if (type === 'text') {
      const body = (msg.text as { body?: string } | undefined)?.body || '';
      return { text: String(body).trim() || '[Empty text message]' };
    }
    if (type === 'button') {
      const btnText = (msg.button as { text?: string } | undefined)?.text || '';
      return { text: String(btnText).trim() || '[Button reply]' };
    }
    if (type === 'interactive') {
      const interactive = msg.interactive as
        | {
            button_reply?: { title?: string };
            list_reply?: { title?: string };
          }
        | undefined;
      return {
        text:
          interactive?.button_reply?.title ||
          interactive?.list_reply?.title ||
          '[Interactive reply]',
      };
    }
    if (type === 'image') {
      const img = msg.image as
        | { id?: string; caption?: string; mime_type?: string }
        | undefined;
      return {
        text: img?.caption ? `[Image] ${img.caption}` : '[Image received via WhatsApp]',
        attachment: {
          type: 'image',
          url: img?.id ? `meta-media://${img.id}` : '',
          filename: 'whatsapp-image',
          mimeType: img?.mime_type || 'image/jpeg',
        },
      };
    }
    if (type === 'document') {
      const doc = msg.document as
        | { id?: string; caption?: string; filename?: string; mime_type?: string }
        | undefined;
      const fname = doc?.filename || 'Document';
      return {
        text: doc?.caption ? `[Document: ${fname}] ${doc.caption}` : `[Document: ${fname}]`,
        attachment: {
          type: 'document',
          url: doc?.id ? `meta-media://${doc.id}` : '',
          filename: fname,
          mimeType: doc?.mime_type || 'application/pdf',
        },
      };
    }
    return { text: `[${type} message received via WhatsApp]` };
  }

  private async pickRoundRobinOwner(tenant: TenantDocument): Promise<{
    ownerId?: Types.ObjectId;
    ownerName: string;
  }> {
    const activeUsers = await this.userModel
      .find({ tenantId: tenant._id, isActive: { $ne: false } })
      .sort({ _id: 1 })
      .exec();
    if (activeUsers.length === 0) {
      return { ownerId: undefined, ownerName: 'Workspace Team' };
    }
    const currentIdx = Number(tenant.roundRobinIndex ?? 0);
    const chosen = activeUsers[currentIdx % activeUsers.length];
    await this.tenantModel.updateOne(
      { _id: tenant._id },
      { $set: { roundRobinIndex: (currentIdx + 1) % activeUsers.length } },
    );
    return {
      ownerId: chosen._id,
      ownerName: chosen.name || chosen.email,
    };
  }

  async handleMetaWebhook(
    rawBody: Buffer | string | undefined,
    signatureHeader: string | undefined,
    payload: Record<string, unknown>,
  ) {
    const entries = Array.isArray(payload?.entry)
      ? (payload.entry as Array<Record<string, unknown>>)
      : [];

    let processedMessages = 0;
    let processedStatuses = 0;
    const platform = await this.resolvePlatformProvider();

    for (const entry of entries) {
      const changes = Array.isArray(entry.changes)
        ? (entry.changes as Array<Record<string, unknown>>)
        : [];
      for (const change of changes) {
        const value = (change.value || {}) as Record<string, unknown>;
        const metadata = (value.metadata || {}) as { phone_number_id?: string };
        const phoneNumberId = String(metadata.phone_number_id || '').trim();
        if (!phoneNumberId) continue;

        const tenant = await this.tenantModel
          .findOne({ 'whatsappCloud.phoneNumberId': phoneNumberId })
          .exec();
        const isManagedGateway = Boolean(
          !tenant &&
            platform.managedPhoneNumberId &&
            phoneNumberId === platform.managedPhoneNumberId,
        );

        const tenantCfg = (tenant?.whatsappCloud || {}) as Partial<WhatsAppCloudConfig>;
        const appSecret =
          decryptSecret(tenantCfg.appSecretEncrypted) ||
          platform.metaAppSecret ||
          this.configService.get<string>('META_WHATSAPP_APP_SECRET')?.trim() ||
          '';

        if (appSecret) {
          const validSig = this.metaWhatsAppService.verifyWebhookSignature(
            rawBody,
            signatureHeader,
            appSecret,
          );
          if (!validSig) {
            throw new UnauthorizedException('Invalid X-Hub-Signature-256 signature.');
          }
        }

        if (!tenant && !isManagedGateway) continue;

        // 1) Process outbound delivery / read status ticks
        const statuses = Array.isArray(value.statuses)
          ? (value.statuses as Array<Record<string, unknown>>)
          : [];
        for (const statusObj of statuses) {
          const wamid = String(statusObj.id || '').trim();
          const rawStatus = String(statusObj.status || '').toLowerCase();
          if (
            !wamid ||
            !['sent', 'delivered', 'read', 'failed'].includes(rawStatus)
          ) {
            continue;
          }
          const errors = Array.isArray(statusObj.errors)
            ? (statusObj.errors as Array<{ title?: string; message?: string }>)
            : [];
          const errorText =
            errors[0]?.title || errors[0]?.message || 'Meta delivery failed';
          const nowIso = new Date().toISOString();

          const conv = await this.convModel
            .findOne({
              ...(tenant ? { tenantId: tenant._id } : {}),
              'messages.externalMessageId': wamid,
            })
            .exec();

          let convUpdated = false;
          if (conv) {
            let changed = false;

            const updatedMsgs = (conv.messages || []).map((m) => {
              if (m.externalMessageId !== wamid) return m;
              if (rawStatus === 'failed') {
                changed = true;
                return {
                  ...m,
                  status: 'failed' as const,
                  deliveryError: errorText,
                  statusUpdatedAt: nowIso,
                };
              }
              const nextStatus = rawStatus as 'sent' | 'delivered' | 'read';
              const nextRank = DELIVERY_STATUS_RANK[nextStatus] || 0;
              const curRank = DELIVERY_STATUS_RANK[m.status] || 0;
              if (nextRank >= curRank || m.status === 'failed') {
                changed = true;
                const copy: ChatMessage = {
                  ...m,
                  status: nextStatus,
                  statusUpdatedAt: nowIso,
                };
                delete copy.deliveryError;
                return copy;
              }
              return m;
            });

            if (changed) {
              conv.messages = updatedMsgs;
              conv.markModified('messages');
              await conv.save();
              this.emitRealtimeConversationUpdate(conv, 'message.status');
              convUpdated = true;
            }
          }

          const campaignUpdated = await this.syncCampaignStatusTickByWamid(
            tenant ? tenant._id : null,
            wamid,
            rawStatus as 'sent' | 'delivered' | 'read' | 'failed',
            errorText,
            nowIso,
          );

          if (convUpdated || campaignUpdated) {
            processedStatuses++;
          }
        }

        // 2) Process inbound buyer replies
        const messages = Array.isArray(value.messages)
          ? (value.messages as Array<Record<string, unknown>>)
          : [];
        const contactsMeta = Array.isArray(value.contacts)
          ? (value.contacts as Array<{
              wa_id?: string;
              profile?: { name?: string };
            }>)
          : [];

        for (const msg of messages) {
          const from = String(msg.from || '').trim();
          const wamid = String(msg.id || '').trim();
          if (!from) continue;

          const last10 = extractLast10Digits(from);
          const formattedPhone =
            normalizeIndianPhone(from) ??
            (from.startsWith('+') ? from : `+${from}`);
          const contactProfile =
            contactsMeta.find((c) => c.wa_id === from)?.profile?.name ||
            contactsMeta[0]?.profile?.name ||
            '';
          const extracted = this.extractInboundMetaContent(msg);
          const nowIso = new Date().toISOString();

          // Extract Meta Click-to-WhatsApp (CTWA) Ad referral payload when present
          const referral = (msg.referral && typeof msg.referral === 'object'
            ? (msg.referral as Record<string, unknown>)
            : null);
          const ctwaClid = String(referral?.ctwa_clid || '').trim();
          const ctwaAdId = String(referral?.source_id || '').trim();
          const ctwaHeadline = String(referral?.headline || '').trim();
          const ctwaBody = String(referral?.body || '').trim();
          const ctwaSourceUrl = String(referral?.source_url || '').trim();
          const hasCtwaReferral = Boolean(ctwaClid || ctwaAdId || ctwaHeadline);

          // Deduplicate if webhook delivers same wamid twice
          if (wamid) {
            const dup = await this.convModel
              .exists({
                ...(tenant ? { tenantId: tenant._id } : {}),
                'messages.externalMessageId': wamid,
              })
              .exec();
            if (dup) continue;
          }

          // Match existing WhatsApp conversation by last-10 phone digits
          const existingCandidates = await this.convModel
            .find({
              ...(tenant ? { tenantId: tenant._id } : {}),
              channel: 'whatsapp',
              phone: { $ne: '' },
            })
            .sort({ updatedAt: -1 })
            .exec();
          let conv =
            existingCandidates.find(
              (c) =>
                (last10.length === 10 && extractLast10Digits(c.phone) === last10) ||
                c.phone.replace(/\D/g, '') === from.replace(/\D/g, ''),
            ) || null;

          if (!conv) {
            // Shared Leadsetu Managed Gateway cannot guess which tenant owns an unknown inbound number.
            if (!tenant) {
              continue;
            }

            // Check if a Lead in this tenant already owns this phone
            const leadCandidates = await this.leadModel
              .find({ tenantId: tenant._id, phone: { $ne: '' } })
              .sort({ updatedAt: -1 })
              .exec();
            let matchedLead =
              leadCandidates.find(
                (l) =>
                  (last10.length === 10 &&
                    extractLast10Digits(l.phone) === last10) ||
                  (l.phone || '').replace(/\D/g, '') === from.replace(/\D/g, ''),
              ) || null;

            let ownerId = matchedLead?.ownerId;
            if (!matchedLead) {
              const assignee = await this.pickRoundRobinOwner(tenant);
              ownerId = assignee.ownerId;
              const fallbackOwner =
                ownerId ||
                (
                  await this.userModel
                    .findOne({ tenantId: tenant._id })
                    .select('_id')
                    .lean()
                    .exec()
                )?._id;

              if (fallbackOwner) {
                matchedLead = await this.leadModel.create({
                  tenantId: tenant._id,
                  ownerId: fallbackOwner,
                  name: contactProfile || `WhatsApp ${formattedPhone}`,
                  company: '',
                  phone: formattedPhone,
                  email: '',
                  city: tenant.city || 'Delhi-NCR',
                  source: hasCtwaReferral ? 'meta_ads' : 'whatsapp',
                  status: 'new',
                  estimatedValue: 0,
                  tags: hasCtwaReferral ? ['Meta CTWA Ad'] : [],
                  adPlatform: hasCtwaReferral ? 'meta_ctwa' : '',
                  ctwaClid,
                  adId: ctwaAdId,
                  adHeadline: ctwaHeadline,
                  adSourceUrl: ctwaSourceUrl,
                  aiScore: hasCtwaReferral ? 84 : 78,
                  aiLabel: hasCtwaReferral ? 'Hot' : 'Warm',
                  aiInsight: hasCtwaReferral
                    ? `Inbound Click-to-WhatsApp lead from Meta Ad${ctwaHeadline ? ` "${ctwaHeadline}"` : ''}.`
                    : 'Inbound WhatsApp Cloud inquiry — reply promptly.',
                  notes: hasCtwaReferral
                    ? `[Meta Ad Referral${ctwaHeadline ? `: ${ctwaHeadline}` : ''}] ${ctwaBody || extracted.text.slice(0, 140)}`
                    : `Inbound WhatsApp reply: "${extracted.text.slice(0, 140)}"`,
                  activities: [
                    {
                      id: randomBytes(6).toString('hex'),
                      type: 'created',
                      description: hasCtwaReferral
                        ? `Auto-created from Meta Click-to-WhatsApp Ad (${ctwaHeadline || ctwaAdId || formattedPhone}).`
                        : `Auto-created from inbound WhatsApp Cloud message (${formattedPhone}).`,
                      authorName: 'WhatsApp Cloud Webhook',
                      createdAt: nowIso,
                    },
                  ],
                });
                ownerId = fallbackOwner;
              }
            } else if (hasCtwaReferral) {
              matchedLead.adPlatform = 'meta_ctwa';
              if (ctwaClid) matchedLead.ctwaClid = ctwaClid;
              if (ctwaAdId) matchedLead.adId = ctwaAdId;
              if (ctwaHeadline) matchedLead.adHeadline = ctwaHeadline;
              if (ctwaSourceUrl) matchedLead.adSourceUrl = ctwaSourceUrl;
              if (!Array.isArray(matchedLead.tags) || !matchedLead.tags.includes('Meta CTWA Ad')) {
                matchedLead.tags = [...(matchedLead.tags || []), 'Meta CTWA Ad'];
              }
              await matchedLead.save();
            }

            conv = new this.convModel({
              tenantId: tenant._id,
              ownerId,
              contactName:
                matchedLead?.name || contactProfile || `WhatsApp ${formattedPhone}`,
              company: matchedLead?.company || '',
              phone: matchedLead?.phone || formattedPhone,
              city: matchedLead?.city || tenant.city || 'Delhi-NCR',
              channel: 'whatsapp',
              status: 'open',
              aiScore: matchedLead?.aiScore ?? 78,
              estimatedValue: matchedLead?.estimatedValue || 0,
              linkedEntityType: matchedLead ? 'lead' : '',
              linkedEntityId: matchedLead ? matchedLead._id.toString() : '',
              linkedEntityLabel: matchedLead
                ? matchedLead.company
                  ? `${matchedLead.name} (${matchedLead.company})`
                  : matchedLead.name
                : '',
              adPlatform: hasCtwaReferral ? 'meta_ctwa' : matchedLead?.adPlatform || '',
              ctwaClid: ctwaClid || matchedLead?.ctwaClid || '',
              adId: ctwaAdId || matchedLead?.adId || '',
              adHeadline: ctwaHeadline || matchedLead?.adHeadline || '',
              adSourceUrl: ctwaSourceUrl || matchedLead?.adSourceUrl || '',
              unreadCount: 0,
              messages: [],
            });
          } else if (hasCtwaReferral) {
            conv.adPlatform = 'meta_ctwa';
            if (ctwaClid) conv.ctwaClid = ctwaClid;
            if (ctwaAdId) conv.adId = ctwaAdId;
            if (ctwaHeadline) conv.adHeadline = ctwaHeadline;
            if (ctwaSourceUrl) conv.adSourceUrl = ctwaSourceUrl;
          }

          const inboundMsg: ChatMessage = {
            id: randomBytes(6).toString('hex'),
            direction: 'inbound',
            content: extracted.text,
            senderName: conv.contactName,
            status: 'delivered',
            ...(wamid ? { externalMessageId: wamid } : {}),
            deliveryProvider: 'meta_cloud',
            ...(extracted.attachment?.url
              ? { attachment: extracted.attachment }
              : {}),
            createdAt: nowIso,
          };

          const isOptOutKeyword = /^(stop|unsubscribe|dnd|opt\s*out|cancel)$/i.test(
            extracted.text.trim(),
          );
          if (isOptOutKeyword) {
            conv.whatsappOptOut = true;
            conv.whatsappOptOutAt = nowIso;
          }

          conv.messages = [...(conv.messages || []), inboundMsg];
          conv.status = 'open';
          conv.lastInboundAt = nowIso;
          conv.unreadCount = (conv.unreadCount || 0) + 1;
          conv.markModified('messages');
          await conv.save();
          this.emitRealtimeConversationUpdate(conv, 'message.inbound');

          if (hasCtwaReferral && this.metaCapiService) {
            void this.metaCapiService
              .fireConversionEvent({
                tenantId: conv.tenantId.toString(),
                eventName: 'LeadSubmitted',
                entityType: conv.linkedEntityId ? 'lead' : 'conversation',
                entityId: conv.linkedEntityId || conv._id.toString(),
                entityLabel: conv.contactName || 'WhatsApp Ad Lead',
                phone: conv.phone,
                ctwaClid: conv.ctwaClid,
                adId: conv.adId,
                adHeadline: conv.adHeadline,
                adSourceUrl: conv.adSourceUrl,
                valueInr: Number(conv.estimatedValue || 0),
                triggeredBy: 'auto_ctwa_inbound',
                respectAutoToggle: true,
              })
              .catch(() => {});
          }

          if (isOptOutKeyword) {
            await this.setPhoneOptOut(conv.tenantId.toString(), from, true);
          } else {
            await this.syncCampaignInboundReply(
              conv.tenantId,
              from,
              extracted.text,
              nowIso,
            );
            await this.refreshConversationAiOnInbound(conv);
          }

          if (conv.linkedEntityType && conv.linkedEntityId) {
            const snippet =
              extracted.text.length > 220
                ? `${extracted.text.slice(0, 217)}...`
                : extracted.text;
            await this.appendWhatsAppTimelineToEntity(
              conv.tenantId.toString(),
              conv.linkedEntityType,
              conv.linkedEntityId,
              conv.contactName || 'Buyer (WhatsApp)',
              `WhatsApp Reply Received: "${snippet}"`,
            );
          }

          processedMessages++;
        }
      }
    }

    return {
      received: true,
      processedMessages,
      processedStatuses,
    };
  }
}
