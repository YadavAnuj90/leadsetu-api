import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosError } from 'axios';
import { createHmac, timingSafeEqual } from 'crypto';

export interface MetaTemplateSummary {
  id: string;
  name: string;
  status: string;
  category: string;
  language: string;
  bodyText: string;
  parameterCount: number;
}

export interface MetaSendResult {
  ok: boolean;
  externalMessageId?: string;
  error?: string;
}

@Injectable()
export class MetaWhatsAppService {
  private readonly logger = new Logger(MetaWhatsAppService.name);

  constructor(private readonly configService: ConfigService) {}

  private getGraphBaseUrl(): string {
    const base =
      this.configService.get<string>('META_GRAPH_API_BASE') ||
      'https://graph.facebook.com/v21.0';
    return base.replace(/\/+$/, '');
  }

  formatRecipientDigits(raw?: string): string {
    const digits = String(raw || '').replace(/\D/g, '');
    if (!digits) return '';
    if (digits.length === 10 && /^[6-9]/.test(digits)) {
      return `91${digits}`;
    }
    if (digits.length === 11 && digits.startsWith('0')) {
      return `91${digits.slice(1)}`;
    }
    return digits;
  }

  verifyWebhookSignature(
    rawBody: Buffer | string | undefined,
    signatureHeader: string | undefined,
    appSecret: string,
  ): boolean {
    if (!rawBody || !signatureHeader || !appSecret) return false;
    const expected = `sha256=${createHmac('sha256', appSecret)
      .update(rawBody)
      .digest('hex')}`;
    const actualBuf = Buffer.from(String(signatureHeader).trim(), 'utf8');
    const expectedBuf = Buffer.from(expected, 'utf8');
    if (actualBuf.length !== expectedBuf.length) return false;
    return timingSafeEqual(actualBuf, expectedBuf);
  }

  private extractGraphError(err: unknown): string {
    if (axios.isAxiosError(err)) {
      const axErr = err as AxiosError<{
        error?: { message?: string; error_user_msg?: string; code?: number };
      }>;
      const metaErr = axErr.response?.data?.error;
      if (metaErr?.error_user_msg) return metaErr.error_user_msg;
      if (metaErr?.message) return metaErr.message;
      if (axErr.message) return axErr.message;
    }
    return err instanceof Error ? err.message : 'Meta Graph API request failed.';
  }

  async exchangeEmbeddedSignupCode(params: {
    appId: string;
    appSecret: string;
    code: string;
    redirectUri?: string;
  }): Promise<{ accessToken: string }> {
    const url = `${this.getGraphBaseUrl()}/oauth/access_token`;
    try {
      const { data } = await axios.get<{ access_token?: string }>(url, {
        params: {
          client_id: params.appId,
          client_secret: params.appSecret,
          code: params.code,
          ...(params.redirectUri ? { redirect_uri: params.redirectUri } : {}),
        },
        timeout: 15000,
      });
      if (!data?.access_token) {
        throw new Error('Meta OAuth did not return an access_token.');
      }
      return { accessToken: data.access_token };
    } catch (err) {
      throw new Error(this.extractGraphError(err));
    }
  }

  async subscribeWabaWebhook(params: {
    wabaId: string;
    accessToken: string;
  }): Promise<boolean> {
    const url = `${this.getGraphBaseUrl()}/${encodeURIComponent(params.wabaId)}/subscribed_apps`;
    try {
      await axios.post(
        url,
        {},
        {
          headers: { Authorization: `Bearer ${params.accessToken}` },
          timeout: 12000,
        },
      );
      return true;
    } catch (err) {
      this.logger.warn(
        `WABA webhook subscription failed (${params.wabaId}): ${this.extractGraphError(err)}`,
      );
      return false;
    }
  }

  async fetchWabaPhoneNumbers(params: {
    wabaId: string;
    accessToken: string;
  }): Promise<
    Array<{
      id: string;
      displayPhoneNumber: string;
      verifiedName: string;
      qualityRating: string;
    }>
  > {
    const url = `${this.getGraphBaseUrl()}/${encodeURIComponent(params.wabaId)}/phone_numbers`;
    try {
      const { data } = await axios.get<{
        data?: Array<{
          id?: string;
          display_phone_number?: string;
          verified_name?: string;
          quality_rating?: string;
        }>;
      }>(url, {
        params: { fields: 'id,display_phone_number,verified_name,quality_rating' },
        headers: { Authorization: `Bearer ${params.accessToken}` },
        timeout: 12000,
      });
      return (data?.data || [])
        .filter((p) => Boolean(p?.id))
        .map((p) => ({
          id: p.id || '',
          displayPhoneNumber: p.display_phone_number || '',
          verifiedName: p.verified_name || '',
          qualityRating: p.quality_rating || '',
        }));
    } catch (err) {
      this.logger.warn(
        `Failed to list WABA phone numbers (${params.wabaId}): ${this.extractGraphError(err)}`,
      );
      return [];
    }
  }

  async discoverWabaFromToken(params: {
    appId: string;
    appSecret: string;
    accessToken: string;
  }): Promise<string> {
    const url = `${this.getGraphBaseUrl()}/debug_token`;
    try {
      const { data } = await axios.get<{
        data?: {
          granular_scopes?: Array<{
            scope?: string;
            target_ids?: string[];
          }>;
        };
      }>(url, {
        params: {
          input_token: params.accessToken,
          access_token: `${params.appId}|${params.appSecret}`,
        },
        timeout: 12000,
      });
      const scopes = data?.data?.granular_scopes || [];
      const waScope = scopes.find(
        (s) =>
          (s.scope === 'whatsapp_business_management' ||
            s.scope === 'whatsapp_business_messaging') &&
          Array.isArray(s.target_ids) &&
          s.target_ids.length > 0,
      );
      return waScope?.target_ids?.[0] || '';
    } catch {
      return '';
    }
  }

  async testConnection(params: {
    phoneNumberId: string;
    accessToken: string;
  }): Promise<{
    ok: boolean;
    verifiedPhoneNumber?: string;
    businessDisplayName?: string;
    qualityRating?: string;
    messagingLimitTier?: string;
    error?: string;
  }> {
    const url = `${this.getGraphBaseUrl()}/${encodeURIComponent(params.phoneNumberId)}`;
    try {
      const { data } = await axios.get<{
        id?: string;
        display_phone_number?: string;
        verified_name?: string;
        quality_rating?: string;
        messaging_limit_tier?: string;
      }>(url, {
        params: {
          fields:
            'id,display_phone_number,verified_name,quality_rating,messaging_limit_tier',
        },
        headers: {
          Authorization: `Bearer ${params.accessToken}`,
        },
        timeout: 12000,
      });

      return {
        ok: true,
        verifiedPhoneNumber: data?.display_phone_number || '',
        businessDisplayName: data?.verified_name || '',
        qualityRating: data?.quality_rating || '',
        messagingLimitTier: data?.messaging_limit_tier || '',
      };
    } catch (err) {
      return {
        ok: false,
        error: this.extractGraphError(err),
      };
    }
  }

  async fetchApprovedTemplates(params: {
    wabaId: string;
    accessToken: string;
  }): Promise<MetaTemplateSummary[]> {
    const url = `${this.getGraphBaseUrl()}/${encodeURIComponent(params.wabaId)}/message_templates`;
    try {
      const { data } = await axios.get<{
        data?: Array<{
          id?: string;
          name?: string;
          status?: string;
          category?: string;
          language?: string;
          components?: Array<{
            type?: string;
            text?: string;
          }>;
        }>;
      }>(url, {
        params: {
          fields: 'id,name,status,category,language,components',
          limit: 100,
        },
        headers: {
          Authorization: `Bearer ${params.accessToken}`,
        },
        timeout: 12000,
      });

      const items = data?.data || [];
      return items
        .filter((item) => Boolean(item?.name))
        .map((item) => {
          const bodyComp = (item.components || []).find(
            (c) => String(c.type || '').toUpperCase() === 'BODY',
          );
          const bodyText = bodyComp?.text || '';
          const paramMatches = bodyText.match(/\{\{\s*\d+\s*\}\}/g) || [];
          const uniqueParams = new Set(
            paramMatches.map((m) => m.replace(/[^0-9]/g, '')),
          );
          return {
            id: item.id || item.name || '',
            name: item.name || '',
            status: String(item.status || 'APPROVED').toUpperCase(),
            category: String(item.category || 'UTILITY').toUpperCase(),
            language: item.language || 'en',
            bodyText,
            parameterCount: uniqueParams.size,
          };
        });
    } catch (err) {
      this.logger.warn(`Failed to fetch Meta templates: ${this.extractGraphError(err)}`);
      throw new Error(this.extractGraphError(err));
    }
  }

  private async uploadDataUrlMedia(params: {
    phoneNumberId: string;
    accessToken: string;
    dataUrl: string;
    filename?: string;
    mimeType?: string;
  }): Promise<string> {
    const match = params.dataUrl.match(/^data:([^;]+);base64,(.+)$/i);
    if (!match) {
      throw new Error('Invalid base64 data URL attachment.');
    }
    const detectedMime = params.mimeType || match[1] || 'application/octet-stream';
    const buffer = Buffer.from(match[2], 'base64');
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', detectedMime);
    form.append(
      'file',
      new Blob([buffer], { type: detectedMime }),
      params.filename || (detectedMime.includes('pdf') ? 'document.pdf' : 'attachment'),
    );

    const uploadUrl = `${this.getGraphBaseUrl()}/${encodeURIComponent(params.phoneNumberId)}/media`;
    const res = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
      },
      body: form,
    });
    const json = (await res.json()) as { id?: string; error?: { message?: string } };
    if (!res.ok || !json?.id) {
      throw new Error(json?.error?.message || `Meta media upload failed (${res.status})`);
    }
    return json.id;
  }

  private async postGraphMessage(
    phoneNumberId: string,
    accessToken: string,
    payload: Record<string, unknown>,
  ): Promise<MetaSendResult> {
    const url = `${this.getGraphBaseUrl()}/${encodeURIComponent(phoneNumberId)}/messages`;
    try {
      const { data } = await axios.post<{
        messages?: Array<{ id?: string }>;
      }>(url, payload, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      });
      const externalMessageId = data?.messages?.[0]?.id;
      return {
        ok: true,
        externalMessageId: externalMessageId || undefined,
      };
    } catch (err) {
      const msg = this.extractGraphError(err);
      this.logger.warn(`Meta send failed (${phoneNumberId}): ${msg}`);
      return {
        ok: false,
        error: msg,
      };
    }
  }

  async sendText(params: {
    phoneNumberId: string;
    accessToken: string;
    toPhone: string;
    body: string;
  }): Promise<MetaSendResult> {
    const to = this.formatRecipientDigits(params.toPhone);
    if (!to || to.length < 10) {
      return { ok: false, error: 'Recipient phone number is invalid for WhatsApp.' };
    }
    return this.postGraphMessage(params.phoneNumberId, params.accessToken, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: {
        preview_url: true,
        body: params.body,
      },
    });
  }

  /**
   * Send Official Meta Interactive Quick-Reply Buttons (up to 3 reply buttons).
   * Falls back cleanly when button list is empty.
   */
  async sendInteractiveButtons(params: {
    phoneNumberId: string;
    accessToken: string;
    toPhone: string;
    body: string;
    footerText?: string;
    buttons: string[];
  }): Promise<MetaSendResult> {
    const cleanButtons = (params.buttons || [])
      .map((b) => String(b || '').trim())
      .filter(Boolean)
      .slice(0, 3);
    if (cleanButtons.length === 0) {
      return this.sendText({
        phoneNumberId: params.phoneNumberId,
        accessToken: params.accessToken,
        toPhone: params.toPhone,
        body: params.body,
      });
    }

    const to = this.formatRecipientDigits(params.toPhone);
    if (!to || to.length < 10) {
      return { ok: false, error: 'Recipient phone number is invalid for WhatsApp.' };
    }

    return this.postGraphMessage(params.phoneNumberId, params.accessToken, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: String(params.body || '').slice(0, 1024) },
        ...(params.footerText?.trim()
          ? { footer: { text: params.footerText.trim().slice(0, 60) } }
          : {}),
        action: {
          buttons: cleanButtons.map((title, idx) => ({
            type: 'reply',
            reply: {
              id: `ls_btn_${idx + 1}`,
              title: title.slice(0, 20),
            },
          })),
        },
      },
    });
  }

  async sendApprovedTemplate(params: {
    phoneNumberId: string;
    accessToken: string;
    toPhone: string;
    templateName: string;
    languageCode?: string;
    bodyParams?: string[];
  }): Promise<MetaSendResult> {
    const to = this.formatRecipientDigits(params.toPhone);
    if (!to || to.length < 10) {
      return { ok: false, error: 'Recipient phone number is invalid for WhatsApp.' };
    }
    const cleanParams = (params.bodyParams || [])
      .map((p) => String(p ?? '').trim())
      .filter((p) => p.length > 0);

    return this.postGraphMessage(params.phoneNumberId, params.accessToken, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'template',
      template: {
        name: params.templateName,
        language: {
          code: params.languageCode || 'en',
        },
        ...(cleanParams.length > 0
          ? {
              components: [
                {
                  type: 'body',
                  parameters: cleanParams.map((text) => ({
                    type: 'text',
                    text,
                  })),
                },
              ],
            }
          : {}),
      },
    });
  }

  async downloadMediaAsDataUrl(params: {
    mediaId: string;
    accessToken: string;
    fallbackMimeType?: string;
  }): Promise<{ dataUrl: string; mimeType: string } | null> {
    if (!params.mediaId || !params.accessToken) return null;
    try {
      const metaInfoUrl = `${this.getGraphBaseUrl()}/${encodeURIComponent(params.mediaId)}`;
      const metaRes = await axios.get<{ url?: string; mime_type?: string }>(
        metaInfoUrl,
        {
          headers: { Authorization: `Bearer ${params.accessToken}` },
          timeout: 10000,
        },
      );
      const downloadUrl = metaRes.data?.url;
      if (!downloadUrl) return null;
      const fileRes = await axios.get<ArrayBuffer>(downloadUrl, {
        headers: { Authorization: `Bearer ${params.accessToken}` },
        responseType: 'arraybuffer',
        timeout: 20000,
      });
      const mimeType = (
        metaRes.data?.mime_type ||
        String(fileRes.headers['content-type'] || '') ||
        params.fallbackMimeType ||
        'audio/ogg'
      )
        .split(';')[0]
        .trim();
      const b64 = Buffer.from(fileRes.data).toString('base64');
      if (!b64) return null;
      return {
        dataUrl: `data:${mimeType};base64,${b64}`,
        mimeType,
      };
    } catch (err) {
      this.logger.warn(
        `Meta media download failed (${params.mediaId}): ${this.extractGraphError(err)}`,
      );
      return null;
    }
  }

  async sendAttachment(params: {
    phoneNumberId: string;
    accessToken: string;
    toPhone: string;
    type: 'document' | 'image' | 'audio';
    url: string;
    filename?: string;
    mimeType?: string;
    caption?: string;
  }): Promise<MetaSendResult> {
    const to = this.formatRecipientDigits(params.toPhone);
    if (!to || to.length < 10) {
      return { ok: false, error: 'Recipient phone number is invalid for WhatsApp.' };
    }

    let mediaRef: { id?: string; link?: string };
    try {
      if (params.url.startsWith('data:')) {
        const mediaId = await this.uploadDataUrlMedia({
          phoneNumberId: params.phoneNumberId,
          accessToken: params.accessToken,
          dataUrl: params.url,
          filename: params.filename,
          mimeType: params.mimeType,
        });
        mediaRef = { id: mediaId };
      } else {
        mediaRef = { link: params.url };
      }
    } catch (err) {
      return { ok: false, error: this.extractGraphError(err) };
    }

    if (params.type === 'image') {
      return this.postGraphMessage(params.phoneNumberId, params.accessToken, {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'image',
        image: {
          ...mediaRef,
          ...(params.caption ? { caption: params.caption } : {}),
        },
      });
    }

    if (params.type === 'audio') {
      return this.postGraphMessage(params.phoneNumberId, params.accessToken, {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'audio',
        audio: mediaRef,
      });
    }

    return this.postGraphMessage(params.phoneNumberId, params.accessToken, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'document',
      document: {
        ...mediaRef,
        ...(params.filename ? { filename: params.filename } : {}),
        ...(params.caption ? { caption: params.caption } : {}),
      },
    });
  }

  /**
   * Enable WhatsApp Business Calling API on a WABA Phone Number via Meta Graph API:
   * POST /{phoneNumberId}/settings
   */
  async enableCallingSettings(params: {
    phoneNumberId: string;
    accessToken: string;
    callIconVisibility?: 'DEFAULT' | 'DISABLE_ALL';
    callbackPermissionStatus?: 'ENABLED' | 'DISABLED';
  }): Promise<{
    ok: boolean;
    simulated?: boolean;
    error?: string;
  }> {
    if (!params.phoneNumberId || !params.accessToken) {
      return {
        ok: true,
        simulated: true,
      };
    }

    const url = `${this.getGraphBaseUrl()}/${encodeURIComponent(params.phoneNumberId)}/settings`;
    try {
      await axios.post(
        url,
        {
          calling: {
            status: 'ENABLED',
            call_icon_visibility: params.callIconVisibility || 'DEFAULT',
            callback_permission_status:
              params.callbackPermissionStatus || 'ENABLED',
          },
        },
        {
          headers: {
            Authorization: `Bearer ${params.accessToken}`,
            'Content-Type': 'application/json',
          },
          timeout: 15000,
        },
      );
      return { ok: true };
    } catch (err) {
      const msg = this.extractGraphError(err);
      this.logger.warn(
        `Meta calling settings enable failed (${params.phoneNumberId}): ${msg}`,
      );
      return { ok: false, error: msg };
    }
  }

  /**
   * Send Meta interactive `call_permission_request` message to a buyer on WhatsApp.
   */
  async sendCallPermissionRequest(params: {
    phoneNumberId: string;
    accessToken: string;
    toPhone: string;
    bodyText?: string;
  }): Promise<MetaSendResult & { simulated?: boolean }> {
    const to = this.formatRecipientDigits(params.toPhone);
    if (!to || to.length < 10) {
      return {
        ok: false,
        error: 'Recipient phone number is invalid for WhatsApp.',
      };
    }

    if (!params.phoneNumberId || !params.accessToken) {
      return {
        ok: true,
        simulated: true,
        externalMessageId: `wamid.sim_perm_${Date.now()}`,
      };
    }

    const bodyText =
      (params.bodyText || '').trim() ||
      'Namaste! Can our team call you on WhatsApp to assist with your inquiry?';

    return this.postGraphMessage(params.phoneNumberId, params.accessToken, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'interactive',
      interactive: {
        type: 'call_permission_request',
        action: {
          name: 'call_permission_request',
        },
        body: {
          text: bodyText,
        },
      },
    });
  }

  /**
   * Perform Meta WhatsApp Cloud API WebRTC call signaling:
   * POST /{phoneNumberId}/calls (`connect` | `pre_accept` | `accept` | `reject` | `terminate`)
   */
  async signalWhatsAppCall(params: {
    phoneNumberId: string;
    accessToken: string;
    action: 'connect' | 'pre_accept' | 'accept' | 'reject' | 'terminate';
    toPhone?: string;
    callId?: string;
    session?: {
      sdp_type: 'offer' | 'answer';
      sdp: string;
    };
  }): Promise<{
    ok: boolean;
    metaCallId?: string;
    sdpAnswer?: string;
    simulated?: boolean;
    error?: string;
  }> {
    if (!params.phoneNumberId || !params.accessToken) {
      return {
        ok: true,
        simulated: true,
        metaCallId: params.callId || `wacall_sim_${Date.now()}`,
        ...(params.action === 'connect' && params.session?.sdp
          ? { sdpAnswer: params.session.sdp }
          : {}),
      };
    }

    const url = `${this.getGraphBaseUrl()}/${encodeURIComponent(params.phoneNumberId)}/calls`;
    const payload: Record<string, unknown> = {
      messaging_product: 'whatsapp',
      action: params.action,
    };

    if (params.toPhone) {
      payload.to = this.formatRecipientDigits(params.toPhone);
    }
    if (params.callId) {
      payload.call_id = params.callId;
    }
    if (params.session) {
      payload.session = params.session;
    }

    try {
      const { data } = await axios.post<{
        calls?: Array<{
          id?: string;
          session?: { sdp?: string; sdp_type?: string };
        }>;
        call_id?: string;
        id?: string;
        session?: { sdp?: string; sdp_type?: string };
      }>(url, payload, {
        headers: {
          Authorization: `Bearer ${params.accessToken}`,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      });

      const firstCall = Array.isArray(data?.calls) ? data.calls[0] : undefined;
      const metaCallId =
        firstCall?.id || data?.call_id || data?.id || params.callId;
      const sdpAnswer = firstCall?.session?.sdp || data?.session?.sdp;

      return {
        ok: true,
        metaCallId,
        ...(sdpAnswer ? { sdpAnswer } : {}),
      };
    } catch (err) {
      const msg = this.extractGraphError(err);
      this.logger.warn(
        `Meta WhatsApp call signal (${params.action}) failed (${params.phoneNumberId}): ${msg}`,
      );
      return {
        ok: false,
        error: msg,
      };
    }
  }
}
