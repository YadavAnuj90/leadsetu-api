import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import axios from 'axios';
import { Model, Types } from 'mongoose';
import { Tenant, TenantDocument } from '../auth/schemas/tenant.schema';
import { User, UserDocument } from '../auth/schemas/user.schema';
import { MetaLeadsProcessor } from './meta-leads.processor';
import {
  autoBuildFormFieldMappings,
  decryptMetaPageToken,
  encryptMetaPageToken,
  signMetaOAuthState,
  verifyMetaOAuthState,
  verifyMetaWebhookSignature,
  type MetaGraphFieldDataEntry,
} from './meta-leads.util';
import {
  MetaFieldMappingItem,
  MetaFormQuestionItem,
  MetaLeadFormConfig,
  MetaPageConnection,
  MetaPageConnectionDocument,
} from './schemas/meta-page-connection.schema';

export interface MetaAuthContext {
  userId: string;
  tenantId: string;
  email: string;
  role: string;
}

@Injectable()
export class MetaLeadsService {
  constructor(
    @InjectModel(MetaPageConnection.name)
    private readonly pageModel: Model<MetaPageConnectionDocument>,
    @InjectModel(Tenant.name)
    private readonly tenantModel: Model<TenantDocument>,
    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly processor: MetaLeadsProcessor,
  ) {}

  async verifyAuth(authHeader?: string): Promise<MetaAuthContext> {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Authorization token is required.');
    }
    const token = authHeader.slice(7).trim();
    const secret =
      this.configService.get<string>('JWT_SECRET') ||
      'leadsetu_super_secret_access_key_2026_delhi_ncr';
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

  private getMetaConfig() {
    const appId = (
      this.configService.get<string>('META_APP_ID') ||
      process.env.META_APP_ID ||
      ''
    ).trim();
    const appSecret = (
      this.configService.get<string>('META_APP_SECRET') ||
      process.env.META_APP_SECRET ||
      ''
    ).trim();
    const verifyToken = (
      this.configService.get<string>('META_VERIFY_TOKEN') ||
      process.env.META_VERIFY_TOKEN ||
      'leadsetu_meta_leads_verify_2026'
    ).trim();
    const redirectUri = (
      this.configService.get<string>('META_OAUTH_REDIRECT_URI') ||
      process.env.META_OAUTH_REDIRECT_URI ||
      'http://localhost:3000/settings/integrations'
    ).trim();
    const encryptionKey = (
      this.configService.get<string>('META_TOKEN_ENCRYPTION_KEY') ||
      process.env.META_TOKEN_ENCRYPTION_KEY ||
      this.configService.get<string>('JWT_SECRET') ||
      ''
    ).trim();
    const graphVersion = (
      this.configService.get<string>('META_GRAPH_API_VERSION') ||
      process.env.META_GRAPH_API_VERSION ||
      'v25.0'
    ).trim();
    const graphBase = (
      this.configService.get<string>('META_GRAPH_API_BASE') ||
      process.env.META_GRAPH_API_BASE ||
      `https://graph.facebook.com/${graphVersion}`
    )
      .trim()
      .replace(/\/+$/, '');

    return {
      appId,
      appSecret,
      verifyToken,
      redirectUri,
      encryptionKey,
      graphVersion,
      graphBase,
    };
  }

  private sanitizeConnection(doc: MetaPageConnectionDocument | MetaPageConnection) {
    return {
      id: String((doc as MetaPageConnectionDocument)._id || doc.pageId),
      tenantId: String(doc.tenantId),
      pageId: doc.pageId,
      pageName: doc.pageName,
      isSubscribed: Boolean(doc.isSubscribed),
      status: doc.status || 'active',
      lastError: doc.lastError || '',
      lastLeadReceivedAt: doc.lastLeadReceivedAt
        ? new Date(doc.lastLeadReceivedAt).toISOString()
        : null,
      forms: (doc.forms || []).map((f) => ({
        formId: f.formId,
        formName: f.formName,
        status: f.status || 'ACTIVE',
        autoReplyEnabled: f.autoReplyEnabled !== false,
        whatsappTemplateId: f.whatsappTemplateId || '',
        defaultAssigneeId: f.defaultAssigneeId || '',
        questions: Array.isArray(f.questions) ? f.questions : [],
        fieldMappings: Array.isArray(f.fieldMappings) ? f.fieldMappings : [],
      })),
    };
  }

  /**
   * `GET /integrations/meta/oauth-url`
   */
  async getOAuthUrl(auth: MetaAuthContext, customRedirectUri?: string) {
    const cfg = this.getMetaConfig();
    const stateSecret = cfg.appSecret || cfg.encryptionKey || 'leadsetu_meta_state';
    const state = signMetaOAuthState(
      { tenantId: auth.tenantId, userId: auth.userId },
      stateSecret,
    );
    const redirectUri = (customRedirectUri || cfg.redirectUri).trim();
    const scopes = [
      'leads_retrieval',
      'pages_manage_metadata',
      'pages_show_list',
      'pages_read_engagement',
      'ads_management',
    ].join(',');

    const effectiveAppId = cfg.appId || 'leadsetu_sandbox_app_id';
    const oauthUrl = `https://www.facebook.com/${cfg.graphVersion}/dialog/oauth?client_id=${encodeURIComponent(
      effectiveAppId,
    )}&redirect_uri=${encodeURIComponent(
      redirectUri,
    )}&state=${encodeURIComponent(
      state,
    )}&scope=${encodeURIComponent(scopes)}&response_type=code`;

    return {
      oauthUrl,
      state,
      scopes: scopes.split(','),
      redirectUri,
      isLiveMetaAppConfigured: Boolean(cfg.appId && cfg.appSecret),
      graphVersion: cfg.graphVersion,
    };
  }

  /**
   * `POST /integrations/meta/oauth/exchange`
   */
  async exchangeOAuthCode(
    auth: MetaAuthContext,
    dto: { code: string; state: string; redirectUri?: string },
  ) {
    if (!['owner', 'admin', 'super_admin', 'manager'].includes(auth.role)) {
      throw new ForbiddenException(
        'Only Workspace Owners or Admins can connect Facebook Pages.',
      );
    }

    const cfg = this.getMetaConfig();
    const stateSecret = cfg.appSecret || cfg.encryptionKey || 'leadsetu_meta_state';
    const verifiedState = verifyMetaOAuthState(dto.state, stateSecret);
    if (!verifiedState || verifiedState.tenantId !== auth.tenantId) {
      throw new BadRequestException(
        'Invalid or expired OAuth state parameter.',
      );
    }

    const code = String(dto.code || '').trim();
    if (!code) {
      throw new BadRequestException('OAuth authorization code is required.');
    }

    const tenantOid = new Types.ObjectId(auth.tenantId);
    const tenant = await this.tenantModel.findById(tenantOid).lean().exec();
    const companyLabel = String(
      tenant?.companyName || tenant?.name || 'Leadsetu Business',
    ).trim();

    let pages: Array<{ id: string; name: string; access_token: string }> = [];

    if (code.startsWith('sandbox_demo_') || !cfg.appId || !cfg.appSecret) {
      // Sandbox / local development fallback so users can test full Page + Form mapping without live Meta App review
      const demoPageId = `10492837${String(auth.tenantId).slice(-6)}`;
      pages = [
        {
          id: demoPageId,
          name: `${companyLabel} — Facebook & Instagram Ads`,
          access_token: `sandbox_page_token_${demoPageId}`,
        },
      ];
    } else {
      const redirectUri = (dto.redirectUri || cfg.redirectUri).trim();
      // 1) Exchange code for short-lived User token
      const shortRes = await axios.get<{ access_token: string }>(
        `${cfg.graphBase}/oauth/access_token`,
        {
          params: {
            client_id: cfg.appId,
            client_secret: cfg.appSecret,
            redirect_uri: redirectUri,
            code,
          },
          timeout: 12_000,
        },
      );
      const shortToken = shortRes.data?.access_token;
      if (!shortToken) {
        throw new BadRequestException('Meta OAuth failed to return short-lived token.');
      }

      // 2) Exchange for long-lived User token
      const longRes = await axios.get<{ access_token: string }>(
        `${cfg.graphBase}/oauth/access_token`,
        {
          params: {
            grant_type: 'fb_exchange_token',
            client_id: cfg.appId,
            client_secret: cfg.appSecret,
            fb_exchange_token: shortToken,
          },
          timeout: 12_000,
        },
      );
      const longUserToken = longRes.data?.access_token || shortToken;

      // 3) Fetch managed Facebook Pages
      const accountsRes = await axios.get<{
        data?: Array<{ id: string; name: string; access_token: string }>;
      }>(`${cfg.graphBase}/me/accounts`, {
        params: {
          fields: 'id,name,access_token',
          access_token: longUserToken,
        },
        timeout: 12_000,
      });
      pages = Array.isArray(accountsRes.data?.data) ? accountsRes.data.data : [];
    }

    const upserted: ReturnType<MetaLeadsService['sanitizeConnection']>[] = [];
    for (const p of pages) {
      if (!p.id || !p.access_token) continue;
      const encrypted = encryptMetaPageToken(p.access_token, cfg.encryptionKey);
      const existing = await this.pageModel
        .findOne({ tenantId: tenantOid, pageId: p.id })
        .exec();

      if (existing) {
        existing.pageName = p.name || existing.pageName;
        existing.encryptedPageAccessToken = encrypted.encryptedPageAccessToken;
        existing.tokenIv = encrypted.tokenIv;
        existing.tokenAuthTag = encrypted.tokenAuthTag;
        existing.status = 'active';
        existing.lastError = '';
        await existing.save();
        upserted.push(this.sanitizeConnection(existing));
      } else {
        const created = await this.pageModel.create({
          tenantId: tenantOid,
          pageId: p.id,
          pageName: p.name || `Facebook Page ${p.id}`,
          encryptedPageAccessToken: encrypted.encryptedPageAccessToken,
          tokenIv: encrypted.tokenIv,
          tokenAuthTag: encrypted.tokenAuthTag,
          isSubscribed: false,
          status: 'active',
          lastError: '',
          forms: [],
        });
        upserted.push(this.sanitizeConnection(created));
      }
    }

    return {
      connectedCount: upserted.length,
      connections: upserted,
    };
  }

  /**
   * `POST /integrations/meta/pages/:pageId/subscribe`
   */
  async subscribePage(auth: MetaAuthContext, pageId: string) {
    const tenantOid = new Types.ObjectId(auth.tenantId);
    const conn = await this.pageModel
      .findOne({ tenantId: tenantOid, pageId: String(pageId).trim() })
      .exec();
    if (!conn) {
      throw new NotFoundException('Connected Facebook Page not found.');
    }

    const cfg = this.getMetaConfig();
    const pageToken = decryptMetaPageToken({
      encryptedPageAccessToken: conn.encryptedPageAccessToken,
      tokenIv: conn.tokenIv,
      tokenAuthTag: conn.tokenAuthTag,
      encryptionKey: cfg.encryptionKey,
    });

    let fetchedForms: Array<{
      id: string;
      name: string;
      status?: string;
      questions?: Array<{ key?: string; label?: string }>;
    }> = [];

    if (pageToken.startsWith('sandbox_page_token_')) {
      fetchedForms = [
        {
          id: `form_${conn.pageId}_b2b`,
          name: 'B2B Industrial Quotation & Dealer Inquiry Form',
          status: 'ACTIVE',
          questions: [
            { key: 'full_name', label: 'Full Name' },
            { key: 'phone_number', label: 'WhatsApp Mobile Number' },
            { key: 'email', label: 'Work Email' },
            { key: 'company_name', label: 'Company / Firm Name' },
            { key: 'city', label: 'Delivery City' },
            { key: 'required_quantity', label: 'Required Quantity / MOQ' },
          ],
        },
        {
          id: `form_${conn.pageId}_insta`,
          name: 'Instagram Direct Catalog & Price List Request',
          status: 'ACTIVE',
          questions: [
            { key: 'full_name', label: 'Your Name' },
            { key: 'phone_number', label: 'Phone Number' },
            { key: 'city', label: 'City' },
            { key: 'product_interest', label: 'Which SKU are you looking for?' },
          ],
        },
      ];
    } else {
      // 1) Subscribe Page to leadgen webhook events
      await axios.post(
        `${cfg.graphBase}/${encodeURIComponent(conn.pageId)}/subscribed_apps`,
        null,
        {
          params: {
            subscribed_fields: 'leadgen',
            access_token: pageToken,
          },
          timeout: 12_000,
        },
      );

      // 2) Fetch active Lead Forms on the Page
      const formsRes = await axios.get<{
        data?: Array<{
          id: string;
          name: string;
          status?: string;
          questions?: Array<{ key?: string; label?: string }>;
        }>;
      }>(`${cfg.graphBase}/${encodeURIComponent(conn.pageId)}/leadgen_forms`, {
        params: {
          fields: 'id,name,status,questions',
          access_token: pageToken,
        },
        timeout: 12_000,
      });
      fetchedForms = Array.isArray(formsRes.data?.data) ? formsRes.data.data : [];
    }

    const existingFormsMap = new Map(
      (conn.forms || []).map((f) => [f.formId, f]),
    );
    const mergedForms: MetaLeadFormConfig[] = fetchedForms.map((f) => {
      const prev = existingFormsMap.get(f.id);
      const questions: MetaFormQuestionItem[] = (f.questions || [])
        .map((q) => ({
          key: String(q.key || '').trim(),
          label: String(q.label || q.key || '').trim(),
        }))
        .filter((q) => Boolean(q.key));

      return {
        formId: f.id,
        formName: f.name || `Lead Form ${f.id}`,
        status: f.status || 'ACTIVE',
        autoReplyEnabled: prev ? prev.autoReplyEnabled !== false : true,
        whatsappTemplateId: prev?.whatsappTemplateId || '',
        defaultAssigneeId: prev?.defaultAssigneeId || '',
        questions,
        fieldMappings:
          prev && Array.isArray(prev.fieldMappings) && prev.fieldMappings.length > 0
            ? prev.fieldMappings
            : autoBuildFormFieldMappings(questions),
      };
    });

    conn.forms = mergedForms;
    conn.isSubscribed = true;
    conn.status = 'active';
    conn.lastError = '';
    conn.markModified('forms');
    await conn.save();

    return this.sanitizeConnection(conn);
  }

  /**
   * `DELETE /integrations/meta/pages/:pageId/unsubscribe`
   */
  async unsubscribePage(auth: MetaAuthContext, pageId: string) {
    const tenantOid = new Types.ObjectId(auth.tenantId);
    const conn = await this.pageModel
      .findOne({ tenantId: tenantOid, pageId: String(pageId).trim() })
      .exec();
    if (!conn) {
      throw new NotFoundException('Connected Facebook Page not found.');
    }

    const cfg = this.getMetaConfig();
    const pageToken = decryptMetaPageToken({
      encryptedPageAccessToken: conn.encryptedPageAccessToken,
      tokenIv: conn.tokenIv,
      tokenAuthTag: conn.tokenAuthTag,
      encryptionKey: cfg.encryptionKey,
    });

    if (!pageToken.startsWith('sandbox_page_token_')) {
      try {
        await axios.delete(
          `${cfg.graphBase}/${encodeURIComponent(conn.pageId)}/subscribed_apps`,
          {
            params: { access_token: pageToken },
            timeout: 12_000,
          },
        );
      } catch {
        // Still allow local unsubscribe state flip
      }
    }

    conn.isSubscribed = false;
    await conn.save();
    return this.sanitizeConnection(conn);
  }

  /**
   * `PATCH /integrations/meta/pages/:pageId/forms/:formId`
   */
  async updateFormConfig(
    auth: MetaAuthContext,
    pageId: string,
    formId: string,
    dto: {
      autoReplyEnabled?: boolean;
      whatsappTemplateId?: string;
      defaultAssigneeId?: string;
      fieldMappings?: MetaFieldMappingItem[];
    },
  ) {
    const tenantOid = new Types.ObjectId(auth.tenantId);
    const conn = await this.pageModel
      .findOne({ tenantId: tenantOid, pageId: String(pageId).trim() })
      .exec();
    if (!conn) {
      throw new NotFoundException('Connected Facebook Page not found.');
    }

    const forms = [...(conn.forms || [])];
    const idx = forms.findIndex((f) => f.formId === String(formId).trim());
    if (idx === -1) {
      throw new NotFoundException('Lead Form not found on this Facebook Page.');
    }

    const current = forms[idx];
    forms[idx] = {
      ...current,
      autoReplyEnabled:
        dto.autoReplyEnabled !== undefined
          ? Boolean(dto.autoReplyEnabled)
          : current.autoReplyEnabled,
      whatsappTemplateId:
        dto.whatsappTemplateId !== undefined
          ? String(dto.whatsappTemplateId).trim()
          : current.whatsappTemplateId,
      defaultAssigneeId:
        dto.defaultAssigneeId !== undefined
          ? String(dto.defaultAssigneeId).trim()
          : current.defaultAssigneeId,
      fieldMappings: Array.isArray(dto.fieldMappings)
        ? dto.fieldMappings
            .map((m) => ({
              metaFieldKey: String(m.metaFieldKey || '').trim(),
              crmFieldKey: String(m.crmFieldKey || '').trim(),
            }))
            .filter((m) => Boolean(m.metaFieldKey && m.crmFieldKey))
        : current.fieldMappings,
    };

    conn.forms = forms;
    conn.markModified('forms');
    await conn.save();

    return this.sanitizeConnection(conn);
  }

  /**
   * `GET /integrations/meta/connections`
   */
  async getConnections(auth: MetaAuthContext) {
    const tenantOid = new Types.ObjectId(auth.tenantId);
    const [docs, users] = await Promise.all([
      this.pageModel
        .find({ tenantId: tenantOid })
        .sort({ createdAt: -1 })
        .exec(),
      this.userModel
        .find({ tenantId: tenantOid, isActive: { $ne: false } })
        .select('_id name email role')
        .lean()
        .exec(),
    ]);

    const cfg = this.getMetaConfig();
    return {
      connections: docs.map((d) => this.sanitizeConnection(d)),
      webhookCallbackPath: '/v1/webhooks/meta/leads',
      verifyToken: cfg.verifyToken,
      graphVersion: cfg.graphVersion,
      isLiveMetaAppConfigured: Boolean(cfg.appId && cfg.appSecret),
      teamMembers: users.map((u) => ({
        id: String(u._id),
        name: u.name,
        email: u.email,
        role: u.role,
      })),
    };
  }

  /**
   * Simulates a test lead arrival on a connected Page/Form (or triggers refresh)
   */
  async simulateTestLead(
    auth: MetaAuthContext,
    dto?: { pageId?: string; formId?: string },
  ) {
    const tenantOid = new Types.ObjectId(auth.tenantId);
    const conn = dto?.pageId
      ? await this.pageModel.findOne({ tenantId: tenantOid, pageId: dto.pageId }).exec()
      : await this.pageModel.findOne({ tenantId: tenantOid }).sort({ updatedAt: -1 }).exec();

    if (!conn) {
      throw new BadRequestException(
        'Connect a Facebook Page first before testing Meta Lead Ads ingestion.',
      );
    }

    const form =
      (conn.forms || []).find((f) => f.formId === dto?.formId) ||
      conn.forms?.[0];
    const leadgenId = `lg_${Date.now()}_${Math.floor(Math.random() * 900 + 100)}`;
    const suffix = String(Date.now()).slice(-4);

    const syntheticFieldData: MetaGraphFieldDataEntry[] = [
      { name: 'full_name', values: [`Siddharth Kapoor ${suffix}`] },
      { name: 'phone_number', values: [`+91-98114 ${suffix}0`] },
      { name: 'email', values: [`siddharth.${suffix}@kapoorinfra.in`] },
      { name: 'company_name', values: ['Kapoor Switchgear & Infra Pvt Ltd'] },
      { name: 'city', values: ['Gurugram'] },
      { name: 'required_quantity', values: ['250 Units (Urgent Project)'] },
    ];

    const res = await this.processor.processLeadgenJob({
      jobId: leadgenId,
      leadgenId,
      pageId: conn.pageId,
      formId: form?.formId || `form_${conn.pageId}_b2b`,
      adId: `ad_meta_${suffix}`,
      createdTime: new Date().toISOString(),
      syntheticFieldData,
    });

    return {
      leadgenId,
      pageId: conn.pageId,
      pageName: conn.pageName,
      formName: form?.formName || 'Meta Instant Form',
      ...res,
    };
  }

  /**
   * `GET /webhooks/meta/leads`
   */
  verifyWebhookChallenge(
    mode?: string,
    verifyToken?: string,
    challenge?: string,
  ): string {
    const cfg = this.getMetaConfig();
    if (
      mode === 'subscribe' &&
      verifyToken &&
      verifyToken.trim() === cfg.verifyToken
    ) {
      return String(challenge || '');
    }
    throw new UnauthorizedException('Meta webhook verify_token mismatch.');
  }

  /**
   * `POST /webhooks/meta/leads`
   */
  handleWebhookPayload(
    rawBody: Buffer | string | undefined,
    signatureHeader: string | undefined,
    payload: Record<string, unknown>,
  ) {
    const cfg = this.getMetaConfig();
    if (cfg.appSecret) {
      const valid = verifyMetaWebhookSignature(
        rawBody,
        signatureHeader,
        cfg.appSecret,
      );
      if (!valid) {
        throw new UnauthorizedException('Invalid X-Hub-Signature-256 signature.');
      }
    } else if (signatureHeader && !signatureHeader.startsWith('sha256=')) {
      throw new UnauthorizedException('Malformed X-Hub-Signature-256 signature.');
    }

    const entries = Array.isArray(payload?.entry)
      ? (payload.entry as Array<Record<string, unknown>>)
      : [];

    const queuedJobs: string[] = [];
    const deduplicatedJobs: string[] = [];

    for (const entry of entries) {
      const entryPageId = String(entry?.id || '').trim();
      const changes = Array.isArray(entry?.changes)
        ? (entry.changes as Array<Record<string, unknown>>)
        : [];

      for (const change of changes) {
        if (String(change?.field || '').trim() !== 'leadgen') continue;
        const val = (change?.value || {}) as Record<string, unknown>;
        const leadgenId = String(val.leadgen_id || '').trim();
        const pageId = String(val.page_id || entryPageId || '').trim();
        if (!leadgenId || !pageId) continue;

        const syntheticFieldData = Array.isArray(val.field_data)
          ? (val.field_data as MetaGraphFieldDataEntry[])
          : undefined;

        const enq = this.processor.enqueueLeadgenJob({
          jobId: leadgenId,
          leadgenId,
          pageId,
          formId: val.form_id ? String(val.form_id) : undefined,
          adId: val.ad_id ? String(val.ad_id) : undefined,
          createdTime:
            (val.created_time as number | string | undefined) || undefined,
          syntheticFieldData,
        });

        if (enq.queued) queuedJobs.push(enq.jobId);
        if (enq.deduplicated) deduplicatedJobs.push(enq.jobId);
      }
    }

    return {
      received: true,
      queue: 'meta-leads-ingestion',
      queuedCount: queuedJobs.length,
      queuedJobs,
      deduplicatedCount: deduplicatedJobs.length,
    };
  }
}
