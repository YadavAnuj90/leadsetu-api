import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Model, Types } from 'mongoose';
import { randomBytes } from 'crypto';
import * as nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import {
  EmailAccount,
  EmailAccountDocument,
} from './schemas/email-account.schema';
import {
  EmailTemplate,
  EmailTemplateDocument,
} from './schemas/email-template.schema';
import {
  EmailMessage,
  EmailMessageDocument,
} from './schemas/email-message.schema';
import {
  decryptSecret,
  encryptSecret,
  maskSecret,
} from '../auth/identity.util';
import { AuditService } from '../audit/audit.module';
import {
  CreateEmailTemplateDto,
  SaveEmailAccountDto,
  SendEmailDto,
  UpdateEmailTemplateDto,
} from './dto/email-crm.dto';

export interface EmailCrmAuthContext {
  userId: string;
  tenantId: string;
  email: string;
  role: string;
}

const DEFAULT_EMAIL_TEMPLATES = [
  {
    name: '18% GST Proforma Quotation',
    category: 'proforma' as const,
    subject: 'Proforma Quotation for {{companyName}} — Commercial Offer',
    bodyHtml:
      '<p>Namaste {{contactName}},</p><p>Thank you for your inquiry. Please find our commercial proposal for <strong>{{companyName}}</strong> (Estimated Value: <strong>{{dealValue}}</strong>, + 18% GST as applicable).</p><p>Let us know if you would like any quantity or payment-term revisions.</p><p>Warm regards,<br/>{{senderName}}</p>',
  },
  {
    name: 'Follow-Up After Call / Demo',
    category: 'followup' as const,
    subject: 'Quick Follow-Up: Next steps for {{companyName}}',
    bodyHtml:
      '<p>Hi {{contactName}},</p><p>Great speaking with you today! Sharing a quick recap of our discussion and proposed timeline for {{companyName}}.</p><p>Please reply to this email or ping us on WhatsApp once you review internally.</p><p>Best regards,<br/>{{senderName}}</p>',
  },
  {
    name: 'Overdue Invoice / Udhaar Reminder',
    category: 'udhaar' as const,
    subject: 'Payment Reminder: Pending GST Invoice Balance for {{companyName}}',
    bodyHtml:
      '<p>Dear {{contactName}},</p><p>This is a polite reminder regarding your pending GST invoice balance with us. Kindly share the NEFT/RTGS UTR or settle via our Razorpay/UPI link at your earliest convenience.</p><p>Thank you for your continued business,<br/>{{senderName}}</p>',
  },
  {
    name: 'Dealer Onboarding & Product Catalog',
    category: 'welcome' as const,
    subject: 'Welcome Partner: Wholesale Price List & HSN Catalog',
    bodyHtml:
      '<p>Namaste {{contactName}},</p><p>Welcome aboard as a B2B partner! Please share your 15-digit GSTIN certificate so we can activate credit terms and share your latest HSN rate card.</p><p>Regards,<br/>{{senderName}}</p>',
  },
];

function stripHtmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2000);
}

function extractReadableSnippetFromRawEmail(rawSource: string): string {
  const parts = rawSource.split(/\r?\n\r?\n/);
  const body = parts.slice(1).join('\n\n') || rawSource;
  return body
    .replace(/=\r?\n/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 800);
}

@Injectable()
export class EmailCrmService {
  private readonly logger = new Logger(EmailCrmService.name);

  constructor(
    @InjectModel(EmailAccount.name)
    private readonly accountModel: Model<EmailAccountDocument>,
    @InjectModel(EmailTemplate.name)
    private readonly templateModel: Model<EmailTemplateDocument>,
    @InjectModel(EmailMessage.name)
    private readonly messageModel: Model<EmailMessageDocument>,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    @Optional() private readonly auditService?: AuditService,
  ) {}

  async verifyAuth(authHeader?: string): Promise<EmailCrmAuthContext> {
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

  private async findActiveAccountForUserOrTenant(
    auth: EmailCrmAuthContext,
  ): Promise<EmailAccountDocument | null> {
    const tenantObjectId = new Types.ObjectId(auth.tenantId);
    const userObjectId = new Types.ObjectId(auth.userId);
    const own = await this.accountModel
      .findOne({ tenantId: tenantObjectId, userId: userObjectId })
      .exec();
    if (own) return own;
    return this.accountModel
      .findOne({ tenantId: tenantObjectId, isActive: true })
      .sort({ updatedAt: -1 })
      .exec();
  }

  private serializeAccount(doc: EmailAccountDocument | null) {
    if (!doc) return null;
    const plainPwd = decryptSecret(doc.appPasswordEncrypted);
    return {
      id: doc._id.toString(),
      providerPreset: doc.providerPreset,
      emailAddress: doc.emailAddress,
      displayName: doc.displayName || '',
      smtpHost: doc.smtpHost,
      smtpPort: doc.smtpPort,
      smtpSecure: Boolean(doc.smtpSecure),
      imapHost: doc.imapHost || '',
      imapPort: doc.imapPort || 993,
      imapSecure: Boolean(doc.imapSecure),
      username: doc.username || doc.emailAddress,
      hasPassword: Boolean(plainPwd),
      appPasswordMasked: plainPwd ? maskSecret(plainPwd) : '',
      signatureHtml: doc.signatureHtml || '',
      isActive: Boolean(doc.isActive),
      lastSyncedAt: doc.lastSyncedAt
        ? new Date(doc.lastSyncedAt).toISOString()
        : null,
      lastSyncError: doc.lastSyncError || '',
    };
  }

  async ensureDefaultTemplates(tenantId: string): Promise<EmailTemplateDocument[]> {
    const tenantObjectId = new Types.ObjectId(tenantId);
    const existing = await this.templateModel
      .find({ tenantId: tenantObjectId })
      .sort({ createdAt: 1 })
      .exec();
    if (existing.length > 0) return existing;

    const inserted = await this.templateModel.insertMany(
      DEFAULT_EMAIL_TEMPLATES.map((t) => ({
        tenantId: tenantObjectId,
        ...t,
      })),
    );
    return inserted as unknown as EmailTemplateDocument[];
  }

  private serializeTemplate(doc: EmailTemplateDocument) {
    return {
      id: doc._id.toString(),
      name: doc.name,
      category: doc.category,
      subject: doc.subject,
      bodyHtml: doc.bodyHtml,
    };
  }

  private serializeMessage(doc: EmailMessageDocument) {
    return {
      id: doc._id.toString(),
      direction: doc.direction,
      fromEmail: doc.fromEmail,
      toEmail: doc.toEmail,
      subject: doc.subject,
      bodyText: doc.bodyText || '',
      bodyHtml: doc.bodyHtml || '',
      entityType: doc.entityType || '',
      entityId: doc.entityId || '',
      entityLabel: doc.entityLabel || '',
      openCount: Number(doc.openCount || 0),
      firstOpenedAt: doc.firstOpenedAt
        ? new Date(doc.firstOpenedAt).toISOString()
        : null,
      lastOpenedAt: doc.lastOpenedAt
        ? new Date(doc.lastOpenedAt).toISOString()
        : null,
      status: doc.status,
      sentAt: doc.sentAt ? new Date(doc.sentAt).toISOString() : new Date().toISOString(),
    };
  }

  async getConfigAndSummary(auth: EmailCrmAuthContext) {
    const [account, templates, recentMessages] = await Promise.all([
      this.findActiveAccountForUserOrTenant(auth),
      this.ensureDefaultTemplates(auth.tenantId),
      this.messageModel
        .find({ tenantId: new Types.ObjectId(auth.tenantId) })
        .sort({ sentAt: -1 })
        .limit(20)
        .exec(),
    ]);

    return {
      account: this.serializeAccount(account),
      templates: templates.map((t) => this.serializeTemplate(t)),
      recentMessages: recentMessages.map((m) => this.serializeMessage(m)),
    };
  }

  async saveEmailAccount(
    auth: EmailCrmAuthContext,
    dto: SaveEmailAccountDto,
  ) {
    const emailAddress = dto.emailAddress?.trim().toLowerCase();
    const smtpHost = dto.smtpHost?.trim();
    if (!emailAddress || !smtpHost) {
      throw new BadRequestException('Email address and SMTP host are required.');
    }

    const tenantObjectId = new Types.ObjectId(auth.tenantId);
    const userObjectId = new Types.ObjectId(auth.userId);
    const existing = await this.accountModel
      .findOne({ tenantId: tenantObjectId, userId: userObjectId })
      .exec();

    let encryptedPwd = existing?.appPasswordEncrypted || '';
    if (dto.appPassword && dto.appPassword.trim()) {
      encryptedPwd = encryptSecret(dto.appPassword.trim());
    }
    if (!encryptedPwd) {
      throw new BadRequestException(
        'SMTP/IMAP password or Gmail/Zoho App Password is required.',
      );
    }

    const payload = {
      tenantId: tenantObjectId,
      userId: userObjectId,
      providerPreset: dto.providerPreset || 'gmail',
      emailAddress,
      displayName: dto.displayName?.trim() || '',
      smtpHost,
      smtpPort: Number(dto.smtpPort) || 465,
      smtpSecure: dto.smtpSecure ?? Number(dto.smtpPort || 465) === 465,
      imapHost: dto.imapHost?.trim() || '',
      imapPort: Number(dto.imapPort) || 993,
      imapSecure: dto.imapSecure ?? Number(dto.imapPort || 993) === 993,
      username: dto.username?.trim() || emailAddress,
      appPasswordEncrypted: encryptedPwd,
      signatureHtml: dto.signatureHtml ?? '',
      isActive: dto.isActive ?? true,
    };

    const doc = existing
      ? await this.accountModel
          .findByIdAndUpdate(existing._id, { $set: payload }, { new: true })
          .exec()
      : await this.accountModel.create(payload);

    await this.auditService?.record({
      tenantId: auth.tenantId,
      actorId: auth.userId,
      actorEmail: auth.email,
      action: 'email_crm.account_saved',
      entityType: 'security',
      entityId: doc!._id.toString(),
      entityLabel: emailAddress,
      summary: `Configured 2-Way Email (${dto.providerPreset || 'smtp'}) for ${emailAddress}`,
    });

    return this.serializeAccount(doc);
  }

  async testConnection(auth: EmailCrmAuthContext) {
    const account = await this.findActiveAccountForUserOrTenant(auth);
    if (!account) {
      throw new BadRequestException('Save your SMTP/IMAP email settings first.');
    }

    const password = decryptSecret(account.appPasswordEncrypted);
    const transporter = nodemailer.createTransport({
      host: account.smtpHost,
      port: account.smtpPort,
      secure: account.smtpSecure,
      auth: {
        user: account.username || account.emailAddress,
        pass: password,
      },
      connectionTimeout: 8000,
    });

    let smtpOk = false;
    let smtpError = '';
    try {
      await transporter.verify();
      smtpOk = true;
    } catch (err) {
      smtpError = err instanceof Error ? err.message : String(err);
    }

    let imapOk = false;
    let imapError = '';
    if (account.imapHost) {
      const client = new ImapFlow({
        host: account.imapHost,
        port: account.imapPort || 993,
        secure: account.imapSecure ?? true,
        auth: {
          user: account.username || account.emailAddress,
          pass: password,
        },
        logger: false,
      });
      try {
        await client.connect();
        imapOk = true;
      } catch (err) {
        imapError = err instanceof Error ? err.message : String(err);
      } finally {
        await client.logout().catch(() => {});
      }
    }

    return {
      smtpOk,
      smtpError,
      imapOk,
      imapError,
      emailAddress: account.emailAddress,
    };
  }

  async listTemplates(auth: EmailCrmAuthContext) {
    const list = await this.ensureDefaultTemplates(auth.tenantId);
    return {
      data: list.map((t) => this.serializeTemplate(t)),
    };
  }

  async createTemplate(auth: EmailCrmAuthContext, dto: CreateEmailTemplateDto) {
    const name = dto.name?.trim();
    const subject = dto.subject?.trim();
    const bodyHtml = dto.bodyHtml?.trim();
    if (!name || !subject || !bodyHtml) {
      throw new BadRequestException('Template name, subject, and body are required.');
    }
    const doc = await this.templateModel.create({
      tenantId: new Types.ObjectId(auth.tenantId),
      name,
      category: dto.category || 'custom',
      subject,
      bodyHtml,
    });
    return this.serializeTemplate(doc);
  }

  async updateTemplate(
    auth: EmailCrmAuthContext,
    id: string,
    dto: UpdateEmailTemplateDto,
  ) {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Email template not found.');
    }
    const doc = await this.templateModel
      .findOne({
        _id: new Types.ObjectId(id),
        tenantId: new Types.ObjectId(auth.tenantId),
      })
      .exec();
    if (!doc) throw new NotFoundException('Email template not found.');

    if (dto.name !== undefined) doc.name = dto.name.trim();
    if (dto.category !== undefined) doc.category = dto.category;
    if (dto.subject !== undefined) doc.subject = dto.subject.trim();
    if (dto.bodyHtml !== undefined) doc.bodyHtml = dto.bodyHtml;
    await doc.save();
    return this.serializeTemplate(doc);
  }

  async deleteTemplate(auth: EmailCrmAuthContext, id: string) {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Email template not found.');
    }
    const res = await this.templateModel
      .deleteOne({
        _id: new Types.ObjectId(id),
        tenantId: new Types.ObjectId(auth.tenantId),
      })
      .exec();
    if (!res.deletedCount) throw new NotFoundException('Email template not found.');
    return { deleted: true, id };
  }

  async listMessages(
    auth: EmailCrmAuthContext,
    query: { entityType?: string; entityId?: string; limit?: string },
  ) {
    const filter: Record<string, unknown> = {
      tenantId: new Types.ObjectId(auth.tenantId),
    };
    if (query.entityType) filter.entityType = query.entityType;
    if (query.entityId) filter.entityId = query.entityId;

    const max = Math.min(100, Math.max(5, Number(query.limit) || 30));
    const docs = await this.messageModel
      .find(filter)
      .sort({ sentAt: -1 })
      .limit(max)
      .exec();

    return {
      data: docs.map((d) => this.serializeMessage(d)),
    };
  }

  private async appendEmailTimelineNote(
    tenantId: string,
    entityType: 'lead' | 'contact' | 'deal' | '',
    entityId: string,
    description: string,
    authorName: string,
  ) {
    if (!entityType || !entityId || !Types.ObjectId.isValid(entityId)) return;
    const collectionName =
      entityType === 'lead'
        ? 'leads'
        : entityType === 'contact'
          ? 'contacts'
          : entityType === 'deal'
            ? 'deals'
            : '';
    if (!collectionName) return;

    const col = this.messageModel.db.collection(collectionName);
    await col.updateOne(
      {
        _id: new Types.ObjectId(entityId),
        tenantId: new Types.ObjectId(tenantId),
      },
      {
        $push: {
          activities: {
            $each: [
              {
                id: randomBytes(6).toString('hex'),
                type: 'note',
                description,
                authorName,
                createdAt: new Date().toISOString(),
              },
            ],
            $position: 0,
          },
        } as never,
      },
    );
  }

  async sendEmail(auth: EmailCrmAuthContext, dto: SendEmailDto) {
    const toEmail = dto.toEmail?.trim().toLowerCase();
    const subject = dto.subject?.trim();
    const bodyHtml = dto.bodyHtml?.trim();
    if (!toEmail || !subject || !bodyHtml) {
      throw new BadRequestException('Recipient email, subject, and body are required.');
    }

    const account = await this.findActiveAccountForUserOrTenant(auth);
    if (!account || !account.isActive) {
      throw new BadRequestException(
        'Connect your Gmail, Zoho, or SMTP account in Settings -> 2-Way Email CRM before sending emails.',
      );
    }

    const password = decryptSecret(account.appPasswordEncrypted);
    const transporter = nodemailer.createTransport({
      host: account.smtpHost,
      port: account.smtpPort,
      secure: account.smtpSecure,
      auth: {
        user: account.username || account.emailAddress,
        pass: password,
      },
      connectionTimeout: 10000,
    });

    const trackingId = `trk_${randomBytes(12).toString('hex')}`;
    const apiBase = (
      this.configService.get<string>('API_PUBLIC_URL') ||
      `http://localhost:${process.env.PORT || 3001}`
    ).replace(/\/+$/, '');
    const pixelTag = `<img src="${apiBase}/v1/email-crm/track/${trackingId}.gif" alt="" width="1" height="1" style="display:none;width:1px;height:1px;" />`;
    const signature = account.signatureHtml ? `<br/>${account.signatureHtml}` : '';
    const fullHtml = `${bodyHtml}${signature}${pixelTag}`;
    const plainText = stripHtmlToText(`${bodyHtml}\n${account.signatureHtml || ''}`);

    let rfcMessageId = '';
    try {
      const info = await transporter.sendMail({
        from: account.displayName
          ? `"${account.displayName}" <${account.emailAddress}>`
          : account.emailAddress,
        to: toEmail,
        subject,
        text: plainText,
        html: fullHtml,
      });
      rfcMessageId = String(info?.messageId || '');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.messageModel.create({
        tenantId: new Types.ObjectId(auth.tenantId),
        ownerId: new Types.ObjectId(auth.userId),
        direction: 'outbound',
        fromEmail: account.emailAddress,
        toEmail,
        subject,
        bodyText: plainText,
        bodyHtml,
        entityType: dto.entityType || '',
        entityId: dto.entityId || '',
        entityLabel: dto.entityLabel || '',
        trackingId,
        status: 'failed',
        sentAt: new Date(),
      });
      throw new BadRequestException(`SMTP send failed: ${msg}`);
    }

    const doc = await this.messageModel.create({
      tenantId: new Types.ObjectId(auth.tenantId),
      ownerId: new Types.ObjectId(auth.userId),
      direction: 'outbound',
      fromEmail: account.emailAddress,
      toEmail,
      subject,
      bodyText: plainText,
      bodyHtml,
      rfcMessageId,
      entityType: dto.entityType || '',
      entityId: dto.entityId || '',
      entityLabel: dto.entityLabel || '',
      trackingId,
      openCount: 0,
      status: 'sent',
      sentAt: new Date(),
    });

    await this.appendEmailTimelineNote(
      auth.tenantId,
      dto.entityType || '',
      dto.entityId || '',
      `[Email Sent -> ${toEmail}] Subject: "${subject}"\n${plainText.slice(0, 220)}`,
      auth.email.split('@')[0],
    );

    return this.serializeMessage(doc);
  }

  async syncInboundEmails(auth: EmailCrmAuthContext) {
    const account = await this.findActiveAccountForUserOrTenant(auth);
    if (!account || !account.imapHost) {
      throw new BadRequestException(
        'Configure IMAP Host & App Password in Settings -> 2-Way Email CRM to sync buyer replies.',
      );
    }

    const tenantObjectId = new Types.ObjectId(auth.tenantId);
    const password = decryptSecret(account.appPasswordEncrypted);
    const client = new ImapFlow({
      host: account.imapHost,
      port: account.imapPort || 993,
      secure: account.imapSecure ?? true,
      auth: {
        user: account.username || account.emailAddress,
        pass: password,
      },
      logger: false,
    });

    let importedCount = 0;
    const syncedMessages: ReturnType<EmailCrmService['serializeMessage']>[] = [];

    try {
      await client.connect();
      const lock = await client.getMailboxLock('INBOX');
      try {
        const total = client.mailbox ? client.mailbox.exists : 0;
        if (total > 0) {
          const startSeq = Math.max(1, total - 14);
          for await (const msg of client.fetch(`${startSeq}:${total}`, {
            envelope: true,
            source: true,
          })) {
            const env = msg.envelope;
            const rfcId = String(env?.messageId || `imap_${msg.uid}`);
            const fromEmail = String(env?.from?.[0]?.address || '')
              .trim()
              .toLowerCase();
            if (!fromEmail || fromEmail === account.emailAddress) continue;

            const exists = await this.messageModel
              .exists({ tenantId: tenantObjectId, rfcMessageId: rfcId })
              .exec();
            if (exists) continue;

            // Match sender against Lead, Contact, or Deal inside this tenant
            let matchedType: 'lead' | 'contact' | 'deal' | '' = '';
            let matchedId = '';
            let matchedLabel = '';

            const leadHit = await this.messageModel.db
              .collection('leads')
              .findOne({ tenantId: tenantObjectId, email: fromEmail });
            if (leadHit) {
              matchedType = 'lead';
              matchedId = String(leadHit._id);
              matchedLabel = String(leadHit.name || fromEmail);
            } else {
              const contactHit = await this.messageModel.db
                .collection('contacts')
                .findOne({ tenantId: tenantObjectId, email: fromEmail });
              if (contactHit) {
                matchedType = 'contact';
                matchedId = String(contactHit._id);
                matchedLabel = String(contactHit.name || fromEmail);
              } else {
                const dealHit = await this.messageModel.db
                  .collection('deals')
                  .findOne({ tenantId: tenantObjectId, contactEmail: fromEmail });
                if (dealHit) {
                  matchedType = 'deal';
                  matchedId = String(dealHit._id);
                  matchedLabel = String(dealHit.title || fromEmail);
                }
              }
            }

            const rawText = msg.source ? msg.source.toString('utf8') : '';
            const bodySnippet = extractReadableSnippetFromRawEmail(rawText);
            const subject = String(env?.subject || '(No Subject)').trim();
            const sentAt = env?.date ? new Date(env.date) : new Date();

            const saved = await this.messageModel.create({
              tenantId: tenantObjectId,
              ownerId: new Types.ObjectId(auth.userId),
              direction: 'inbound',
              fromEmail,
              toEmail: account.emailAddress,
              subject,
              bodyText: bodySnippet,
              bodyHtml: '',
              rfcMessageId: rfcId,
              entityType: matchedType,
              entityId: matchedId,
              entityLabel: matchedLabel,
              status: 'received',
              sentAt,
            });

            if (matchedType && matchedId) {
              await this.appendEmailTimelineNote(
                auth.tenantId,
                matchedType,
                matchedId,
                `[Email Reply <- ${fromEmail}] Subject: "${subject}"\n${bodySnippet.slice(0, 240)}`,
                'IMAP Sync',
              );
            }

            importedCount += 1;
            syncedMessages.push(this.serializeMessage(saved));
          }
        }
      } finally {
        lock.release();
      }

      account.lastSyncedAt = new Date();
      account.lastSyncError = '';
      await account.save();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`IMAP sync failed for ${account.emailAddress}: ${msg}`);
      account.lastSyncError = msg;
      await account.save();
      throw new BadRequestException(`IMAP inbox sync failed: ${msg}`);
    } finally {
      await client.logout().catch(() => {});
    }

    return {
      importedCount,
      lastSyncedAt: account.lastSyncedAt?.toISOString() || new Date().toISOString(),
      data: syncedMessages,
    };
  }

  async recordEmailOpen(trackingId: string) {
    const clean = String(trackingId || '').replace(/\.gif$/i, '').trim();
    if (!clean) return;
    const doc = await this.messageModel.findOne({ trackingId: clean }).exec();
    if (!doc) return;
    const now = new Date();
    doc.openCount = Number(doc.openCount || 0) + 1;
    if (!doc.firstOpenedAt) doc.firstOpenedAt = now;
    doc.lastOpenedAt = now;
    await doc.save();
  }
}
