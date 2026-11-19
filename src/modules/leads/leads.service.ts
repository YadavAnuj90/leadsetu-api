import {
  BadRequestException,
  Injectable,
  NotFoundException,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Model, Types } from 'mongoose';
import { randomBytes } from 'crypto';
import {
  Lead,
  LeadActivity,
  LeadDocument,
  LeadSource,
  LeadStatus,
} from './schemas/lead.schema';
import { AuditService } from '../audit/audit.module';
import {
  maskPhoneNumber,
  normalizeIndianPhone,
  resolveOwnerScopeFilter,
} from '../auth/identity.util';
import { SuperAdminService } from '../super-admin/super-admin.service';
import { WorkflowsService } from '../workflows/workflows.service';

export interface CreateLeadDto {
  name: string;
  company?: string;
  phone?: string;
  email?: string;
  city?: string;
  source?: LeadSource;
  status?: LeadStatus;
  estimatedValue?: number;
  tags?: string[];
  notes?: string;
}

export interface UpdateLeadDto extends Partial<CreateLeadDto> {
  rescoreAi?: boolean;
}

export interface LeadsQuery {
  search?: string;
  status?: string;
  source?: string;
  aiLabel?: string;
  sortBy?: 'aiScore' | 'createdAt' | 'estimatedValue';
  page?: string;
  limit?: string;
}

interface AuthContext {
  userId: string;
  tenantId: string;
  email: string;
}

@Injectable()
export class LeadsService {
  constructor(
    @InjectModel(Lead.name) private readonly leadModel: Model<LeadDocument>,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    @Optional() private readonly auditService?: AuditService,
    @Optional() private readonly superAdminService?: SuperAdminService,
    @Optional() private readonly workflowsService?: WorkflowsService,
  ) {}

  async verifyAuth(authHeader?: string): Promise<AuthContext> {
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
      }>(token, { secret });

      return {
        userId: payload.sub,
        tenantId: payload.tenantId,
        email: payload.email,
      };
    } catch {
      throw new UnauthorizedException('Invalid or expired session.');
    }
  }

  private computeAiIntelligence(input: {
    source?: LeadSource;
    status?: LeadStatus;
    estimatedValue?: number;
    company?: string;
    phone?: string;
    email?: string;
    notes?: string;
  }): { aiScore: number; aiLabel: 'Hot' | 'Warm' | 'Cold'; aiInsight: string } {
    let score = 52;

    const sourceBoost: Record<string, number> = {
      whatsapp: 16,
      indiamart: 15,
      referral: 18,
      meta_ads: 12,
      google_ads: 14,
      justdial: 11,
      website: 10,
      manual: 8,
    };
    score += sourceBoost[input.source || 'whatsapp'] || 10;

    const val = Number(input.estimatedValue || 0);
    if (val >= 500000) score += 18;
    else if (val >= 200000) score += 14;
    else if (val >= 50000) score += 9;
    else if (val > 0) score += 5;

    if (input.company?.trim()) score += 5;
    if (input.phone?.trim()) score += 5;
    if (input.email?.trim()) score += 3;

    const notesLower = (input.notes || '').toLowerCase();
    if (/urgent|immediate|bulk|gst|quote|quotation|ready|visit|payment|order/.test(notesLower)) {
      score += 8;
    }

    if (input.status === 'qualified' || input.status === 'proposal') {
      score = Math.max(score, 82);
    } else if (input.status === 'converted') {
      score = 98;
    } else if (input.status === 'lost') {
      score = Math.min(score, 35);
    }

    const finalScore = Math.max(18, Math.min(99, score));
    const aiLabel: 'Hot' | 'Warm' | 'Cold' =
      finalScore >= 80 ? 'Hot' : finalScore >= 58 ? 'Warm' : 'Cold';

    let aiInsight =
      'Send introductory WhatsApp message and confirm buyer requirement.';
    if (input.status === 'converted') {
      aiInsight = 'Deal won! Trigger onboarding & GST tax invoice workflow.';
    } else if (finalScore >= 85) {
      aiInsight = `High-intent buyer (${
        val > 0 ? `₹${val.toLocaleString('en-IN')} est.` : 'priority'
      }) — share GST proforma quote on WhatsApp within 15 mins.`;
    } else if (finalScore >= 70) {
      aiInsight =
        'Strong B2B fit — schedule a 5-minute discovery call and send product catalogue PDF.';
    } else if (finalScore < 50) {
      aiInsight =
        'Low immediate urgency — enroll in automated 7-day WhatsApp nurture sequence.';
    }

    return { aiScore: finalScore, aiLabel, aiInsight };
  }

  private toDto(doc: LeadDocument, maskPhones = false) {
    const raw = doc.toObject() as unknown as Record<string, unknown> & {
      createdAt?: Date;
      updatedAt?: Date;
    };
    return {
      id: doc._id.toString(),
      tenantId: doc.tenantId.toString(),
      ownerId: doc.ownerId.toString(),
      name: doc.name,
      company: doc.company || '',
      phone: maskPhones ? maskPhoneNumber(doc.phone) : doc.phone || '',
      email: doc.email || '',
      city: doc.city || 'Delhi-NCR',
      source: doc.source,
      status: doc.status,
      estimatedValue: doc.estimatedValue || 0,
      aiScore: doc.aiScore || 70,
      aiLabel: doc.aiLabel || 'Warm',
      aiInsight: doc.aiInsight || '',
      tags: doc.tags || [],
      notes: doc.notes || '',
      activities: doc.activities || [],
      createdAt: raw.createdAt ? new Date(raw.createdAt).toISOString() : new Date().toISOString(),
      updatedAt: raw.updatedAt ? new Date(raw.updatedAt).toISOString() : new Date().toISOString(),
    };
  }

  async findAll(auth: AuthContext, query: LeadsQuery) {
    // Non-blocking check for stale New / Proposal leads needing automated WhatsApp follow-up
    this.workflowsService?.runStaleLeadFollowUps(auth).catch(() => {});

    const tenantObjectId = new Types.ObjectId(auth.tenantId);
    const ownerScope = await resolveOwnerScopeFilter(this.leadModel.db, auth);
    const baseScope: Record<string, unknown> = {
      tenantId: tenantObjectId,
      ...ownerScope,
    };
    const filter: Record<string, unknown> = { ...baseScope };

    if (query.status && query.status !== 'all') {
      filter.status = query.status;
    }
    if (query.source && query.source !== 'all') {
      filter.source = query.source;
    }
    if (query.aiLabel && query.aiLabel !== 'all') {
      filter.aiLabel = query.aiLabel;
    }
    if (query.search?.trim()) {
      const regex = new RegExp(query.search.trim(), 'i');
      filter.$or = [
        { name: regex },
        { company: regex },
        { phone: regex },
        { email: regex },
        { city: regex },
      ];
    }

    const sortField = query.sortBy || 'createdAt';
    const sortObj: Record<string, 1 | -1> =
      sortField === 'aiScore'
        ? { aiScore: -1, createdAt: -1 }
        : sortField === 'estimatedValue'
        ? { estimatedValue: -1, createdAt: -1 }
        : { createdAt: -1 };

    const [docs, allTenantLeads, maskPhones] = await Promise.all([
      this.leadModel.find(filter).sort(sortObj).exec(),
      this.leadModel.find(baseScope).exec(),
      this.auditService
        ? this.auditService.shouldMaskViewerPhones(auth.tenantId, auth.userId)
        : Promise.resolve(false),
    ]);

    const total = allTenantLeads.length;
    const hotCount = allTenantLeads.filter((l) => l.aiLabel === 'Hot').length;
    const qualifiedCount = allTenantLeads.filter((l) =>
      ['qualified', 'proposal', 'converted'].includes(l.status),
    ).length;
    const convertedCount = allTenantLeads.filter(
      (l) => l.status === 'converted',
    ).length;
    const totalPipelineValue = allTenantLeads
      .filter((l) => l.status !== 'lost')
      .reduce((acc, l) => acc + (Number(l.estimatedValue) || 0), 0);
    const avgAiScore =
      total > 0
        ? Math.round(
            allTenantLeads.reduce((acc, l) => acc + (l.aiScore || 70), 0) /
              total,
          )
        : 0;

    return {
      data: docs.map((d) => this.toDto(d, maskPhones)),
      stats: {
        total,
        hotCount,
        qualifiedCount,
        convertedCount,
        totalPipelineValue,
        avgAiScore,
      },
    };
  }

  async findOne(auth: AuthContext, id: string) {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Lead not found.');
    }
    const ownerScope = await resolveOwnerScopeFilter(this.leadModel.db, auth);
    const doc = await this.leadModel
      .findOne({
        _id: new Types.ObjectId(id),
        tenantId: new Types.ObjectId(auth.tenantId),
        ...ownerScope,
      })
      .exec();

    if (!doc) {
      throw new NotFoundException('Lead not found in your workspace.');
    }
    const maskPhones = this.auditService
      ? await this.auditService.shouldMaskViewerPhones(auth.tenantId, auth.userId)
      : false;
    return this.toDto(doc, maskPhones);
  }

  async create(auth: AuthContext, dto: CreateLeadDto) {
    if (!dto.name?.trim()) {
      throw new BadRequestException('Lead name is required.');
    }

    const eff = this.superAdminService
      ? await this.superAdminService.getTenantEffectiveState(auth.tenantId).catch(() => null)
      : null;
    const aiEnabled = eff?.effectiveFeatures?.aiScoring ?? true;
    if (aiEnabled) {
      await this.superAdminService?.consumeTenantQuota(auth.tenantId, 'ai', 1);
    }
    const ai = aiEnabled
      ? this.computeAiIntelligence(dto)
      : {
          aiScore: 0,
          aiLabel: 'Warm' as const,
          aiInsight: 'SetuAI Lead Scoring disabled by Leadsetu HQ.',
        };
    const nowIso = new Date().toISOString();

    const initialActivity: LeadActivity = {
      id: randomBytes(6).toString('hex'),
      type: 'created',
      description: `Lead captured via ${(dto.source || 'whatsapp').toUpperCase()} · SetuAI scored ${ai.aiScore}/100 (${ai.aiLabel})`,
      authorName: auth.email.split('@')[0],
      createdAt: nowIso,
    };

    const doc = await this.leadModel.create({
      tenantId: new Types.ObjectId(auth.tenantId),
      ownerId: new Types.ObjectId(auth.userId),
      name: dto.name.trim(),
      company: dto.company?.trim() || '',
      phone: dto.phone?.trim() || '',
      email: dto.email?.trim().toLowerCase() || '',
      city: dto.city?.trim() || 'New Delhi',
      source: dto.source || 'whatsapp',
      status: dto.status || 'new',
      estimatedValue: Number(dto.estimatedValue) || 0,
      aiScore: ai.aiScore,
      aiLabel: ai.aiLabel,
      aiInsight: ai.aiInsight,
      tags: Array.isArray(dto.tags) ? dto.tags : [],
      notes: dto.notes?.trim() || '',
      activities: [initialActivity],
    });

    // Auto-trigger active CRM Workflows (`lead.created` & `lead.hot_scored`) with real WhatsApp dispatch
    try {
      if (this.workflowsService) {
        await this.workflowsService.handleLeadCreatedEvent(auth, doc);
      } else {
        const wfTriggers =
          ai.aiScore >= 80
            ? ['lead.created', 'lead.hot_scored']
            : ['lead.created'];
        const wfCol = this.leadModel.db.collection('workflows');
        await wfCol.updateMany(
          {
            tenantId: new Types.ObjectId(auth.tenantId),
            active: true,
            triggerType: { $in: wfTriggers },
          },
          {
            $inc: { runsCount: 1 },
            $set: { lastRunAt: nowIso },
            $push: {
              executionLogs: {
                $each: [
                  {
                    id: `log-${Date.now()}`,
                    summary: `Auto-triggered for new lead "${doc.name}" (${doc.company || doc.city}) — AI Score ${ai.aiScore}/100`,
                    status: 'success',
                    executedAt: nowIso,
                  },
                ],
                $position: 0,
                $slice: 8,
              },
            },
          } as any,
        );
      }
    } catch {
      // Non-blocking workflow hook
    }

    await this.auditService?.record({
      tenantId: auth.tenantId,
      actorId: auth.userId,
      actorEmail: auth.email,
      action: 'lead.created',
      entityType: 'lead',
      entityId: doc._id.toString(),
      entityLabel: `${doc.name}${doc.company ? ` (${doc.company})` : ''}`,
      summary: `Captured lead ${doc.name} via ${(doc.source || 'whatsapp').toUpperCase()} · AI Score ${ai.aiScore}/100`,
    });

    const maskPhones = this.auditService
      ? await this.auditService.shouldMaskViewerPhones(auth.tenantId, auth.userId)
      : false;
    return this.toDto(doc, maskPhones);
  }

  async update(auth: AuthContext, id: string, dto: UpdateLeadDto) {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Lead not found.');
    }
    const ownerScope = await resolveOwnerScopeFilter(this.leadModel.db, auth);
    const doc = await this.leadModel
      .findOne({
        _id: new Types.ObjectId(id),
        tenantId: new Types.ObjectId(auth.tenantId),
        ...ownerScope,
      })
      .exec();

    if (!doc) {
      throw new NotFoundException('Lead not found.');
    }

    const prevStatus = doc.status;

    if (dto.name !== undefined) doc.name = dto.name.trim();
    if (dto.company !== undefined) doc.company = dto.company.trim();
    if (dto.phone !== undefined) doc.phone = dto.phone.trim();
    if (dto.email !== undefined) doc.email = dto.email.trim().toLowerCase();
    if (dto.city !== undefined) doc.city = dto.city.trim();
    if (dto.source !== undefined) doc.source = dto.source;
    if (dto.status !== undefined) doc.status = dto.status;
    if (dto.estimatedValue !== undefined)
      doc.estimatedValue = Number(dto.estimatedValue) || 0;
    if (dto.tags !== undefined) doc.tags = dto.tags;
    if (dto.notes !== undefined) doc.notes = dto.notes.trim();

    if (dto.rescoreAi) {
      await this.superAdminService?.assertFeatureEnabled(auth.tenantId, 'aiScoring');
    }
    const eff = this.superAdminService
      ? await this.superAdminService.getTenantEffectiveState(auth.tenantId).catch(() => null)
      : null;
    if (!eff || eff.effectiveFeatures.aiScoring) {
      if (dto.rescoreAi) {
        await this.superAdminService?.consumeTenantQuota(auth.tenantId, 'ai', 1);
      }
      const ai = this.computeAiIntelligence({
        source: doc.source,
        status: doc.status,
        estimatedValue: doc.estimatedValue,
        company: doc.company,
        phone: doc.phone,
        email: doc.email,
        notes: doc.notes,
      });
      doc.aiScore = ai.aiScore;
      doc.aiLabel = ai.aiLabel;
      doc.aiInsight = ai.aiInsight;
    }

    if (dto.status && dto.status !== prevStatus) {
      const activity: LeadActivity = {
        id: randomBytes(6).toString('hex'),
        type: 'status_change',
        description: `Stage updated from "${prevStatus.toUpperCase()}" to "${dto.status.toUpperCase()}"`,
        authorName: auth.email.split('@')[0],
        createdAt: new Date().toISOString(),
      };
      doc.activities = [activity, ...(doc.activities || [])];
    }

    await doc.save();
    if (dto.status && dto.status !== prevStatus) {
      await this.auditService?.record({
        tenantId: auth.tenantId,
        actorId: auth.userId,
        actorEmail: auth.email,
        action: 'lead.status_changed',
        entityType: 'lead',
        entityId: doc._id.toString(),
        entityLabel: `${doc.name}${doc.company ? ` (${doc.company})` : ''}`,
        summary: `Lead ${doc.name} status updated: ${prevStatus.toUpperCase()} -> ${dto.status.toUpperCase()}`,
      });
    }
    const maskPhones = this.auditService
      ? await this.auditService.shouldMaskViewerPhones(auth.tenantId, auth.userId)
      : false;
    return this.toDto(doc, maskPhones);
  }

  async addActivity(
    auth: AuthContext,
    id: string,
    body: { type?: LeadActivity['type']; description: string },
  ) {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Lead not found.');
    }
    if (!body.description?.trim()) {
      throw new BadRequestException('Activity note cannot be empty.');
    }

    const ownerScope = await resolveOwnerScopeFilter(this.leadModel.db, auth);
    const doc = await this.leadModel
      .findOne({
        _id: new Types.ObjectId(id),
        tenantId: new Types.ObjectId(auth.tenantId),
        ...ownerScope,
      })
      .exec();

    if (!doc) {
      throw new NotFoundException('Lead not found.');
    }

    const activity: LeadActivity = {
      id: randomBytes(6).toString('hex'),
      type: body.type || 'note',
      description: body.description.trim(),
      authorName: auth.email.split('@')[0],
      createdAt: new Date().toISOString(),
    };

    doc.activities = [activity, ...(doc.activities || [])];
    await doc.save();
    const maskPhones = this.auditService
      ? await this.auditService.shouldMaskViewerPhones(auth.tenantId, auth.userId)
      : false;
    return this.toDto(doc, maskPhones);
  }

  async remove(auth: AuthContext, id: string) {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Lead not found.');
    }
    const ownerScope = await resolveOwnerScopeFilter(this.leadModel.db, auth);
    const doc = await this.leadModel
      .findOneAndDelete({
        _id: new Types.ObjectId(id),
        tenantId: new Types.ObjectId(auth.tenantId),
        ...ownerScope,
      })
      .exec();

    if (doc) {
      await this.auditService?.record({
        tenantId: auth.tenantId,
        actorId: auth.userId,
        actorEmail: auth.email,
        action: 'lead.deleted',
        entityType: 'lead',
        entityId: id,
        entityLabel: `${doc.name}${doc.company ? ` (${doc.company})` : ''}`,
        summary: `Deleted lead ${doc.name}`,
      });
    }

    return { success: true, id };
  }

  private last10Digits(raw?: string): string {
    if (!raw) return '';
    const digits = raw.replace(/\D/g, '');
    return digits.length >= 10 ? digits.slice(-10) : '';
  }

  private async findDuplicateLead(
    tenantObjectId: Types.ObjectId,
    phone?: string,
    email?: string,
    ownerScope: Record<string, unknown> = {},
  ): Promise<LeadDocument | null> {
    const orClauses: Record<string, unknown>[] = [];
    const tenDigits = this.last10Digits(phone);
    if (tenDigits) {
      const pattern = `${tenDigits.slice(0, 5)}\\D*${tenDigits.slice(5)}$`;
      orClauses.push({ phone: { $regex: pattern } });
    }
    const cleanEmail = (email ?? '').trim().toLowerCase();
    if (cleanEmail) {
      orClauses.push({ email: cleanEmail });
    }
    if (orClauses.length === 0) return null;
    return this.leadModel
      .findOne({ tenantId: tenantObjectId, ...ownerScope, $or: orClauses })
      .exec();
  }

  async bulkImport(auth: AuthContext, rows: CreateLeadDto[]) {
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new BadRequestException('Provide at least one CSV lead row to import.');
    }
    const tenantObjectId = new Types.ObjectId(auth.tenantId);
    const ownerScope = await resolveOwnerScopeFilter(this.leadModel.db, auth);
    const batch = rows.slice(0, 500);
    const data = [];
    let importedCount = 0;
    let duplicateUpdatedCount = 0;
    let skippedCount = 0;

    for (const row of batch) {
      const name = String(row?.name ?? '').trim();
      if (!name) {
        skippedCount += 1;
        continue;
      }

      const formattedPhone =
        normalizeIndianPhone(row.phone) ?? String(row.phone ?? '').trim();
      const email = String(row.email ?? '').trim().toLowerCase();

      const existing = await this.findDuplicateLead(
        tenantObjectId,
        formattedPhone,
        email,
        ownerScope,
      );

      if (existing) {
        const noteText = row.notes?.trim()
          ? `CSV Bulk Import refresh: ${row.notes.trim()}`
          : 'CSV Bulk Import match — refreshed inquiry timestamp.';
        existing.activities.unshift({
          id: randomBytes(6).toString('hex'),
          type: 'note',
          description: noteText,
          authorName: auth.email.split('@')[0],
          createdAt: new Date().toISOString(),
        });
        if (!existing.company && row.company) existing.company = row.company.trim();
        if (!existing.email && email) existing.email = email;
        await existing.save();
        duplicateUpdatedCount += 1;
        data.push(await this.findOne(auth, String(existing._id)));
        continue;
      }

      const created = await this.create(auth, {
        name,
        company: row.company?.trim() ?? '',
        phone: formattedPhone,
        email,
        city: row.city?.trim() || 'Delhi-NCR',
        source: row.source || 'manual',
        estimatedValue: Number(row.estimatedValue ?? 0) || 0,
        notes: row.notes?.trim() ?? '',
      });
      importedCount += 1;
      data.push(created);
    }

    await this.auditService?.record({
      tenantId: auth.tenantId,
      actorId: auth.userId,
      actorEmail: auth.email,
      action: 'lead.bulk_imported',
      entityType: 'lead',
      entityId: auth.tenantId,
      entityLabel: 'CSV Bulk Import',
      summary: `CSV bulk import: ${importedCount} created, ${duplicateUpdatedCount} deduplicated, ${skippedCount} skipped`,
    });

    return {
      importedCount,
      duplicateUpdatedCount,
      skippedCount,
      totalProcessed: batch.length,
      data,
    };
  }

  async getWebhookConfig(auth: AuthContext) {
    await this.superAdminService?.assertFeatureEnabled(auth.tenantId, 'apiWebhooks');
    const tenantObjectId = new Types.ObjectId(auth.tenantId);
    const tenantsCol = this.leadModel.db.collection('tenants');
    const tenant = await tenantsCol.findOne({ _id: tenantObjectId });
    if (!tenant) {
      throw new NotFoundException('Workspace tenant not found.');
    }

    let webhookKey =
      typeof tenant.webhookKey === 'string' && tenant.webhookKey
        ? tenant.webhookKey
        : '';

    if (!webhookKey) {
      webhookKey = `lsw_${randomBytes(16).toString('hex')}`;
      await tenantsCol.updateOne(
        { _id: tenantObjectId },
        { $set: { webhookKey } },
      );
    }

    const maskPhones = this.auditService
      ? await this.auditService.shouldMaskViewerPhones(auth.tenantId, auth.userId)
      : false;

    const recentDocs = await this.leadModel
      .find({
        tenantId: tenantObjectId,
        source: { $in: ['indiamart', 'justdial', 'meta_ads', 'website'] },
      })
      .sort({ createdAt: -1 })
      .limit(8)
      .exec();

    return {
      webhookKey,
      webhookPath: `/v1/leads/webhook/${webhookKey}`,
      roundRobinIndex: Number(tenant.roundRobinIndex ?? 0),
      recentWebhookLeads: recentDocs.map((doc) => this.toDto(doc, maskPhones)),
    };
  }

  async rotateWebhookKey(auth: AuthContext) {
    await this.superAdminService?.assertFeatureEnabled(auth.tenantId, 'apiWebhooks');
    const actor = await this.leadModel.db
      .collection('users')
      .findOne({ _id: new Types.ObjectId(auth.userId) });
    const role = String(actor?.role ?? '');
    if (role !== 'owner' && role !== 'admin') {
      throw new UnauthorizedException(
        'Only workspace owners or admins can rotate the webhook capture key.',
      );
    }

    const tenantObjectId = new Types.ObjectId(auth.tenantId);
    const webhookKey = `lsw_${randomBytes(16).toString('hex')}`;
    await this.leadModel.db
      .collection('tenants')
      .updateOne({ _id: tenantObjectId }, { $set: { webhookKey } });

    await this.auditService?.record({
      tenantId: auth.tenantId,
      actorId: auth.userId,
      actorEmail: auth.email,
      action: 'webhook.key_rotated',
      entityType: 'security',
      entityId: auth.tenantId,
      entityLabel: 'Inbound Webhook Key',
      summary: 'Rotated inbound lead capture webhook key',
    });

    return {
      webhookKey,
      webhookPath: `/v1/leads/webhook/${webhookKey}`,
    };
  }

  private resolveWebhookSource(raw?: unknown): LeadSource {
    const val = String(raw ?? '').trim().toLowerCase();
    if (val === 'indiamart') return 'indiamart';
    if (val === 'justdial') return 'justdial';
    if (val === 'meta_ads' || val === 'meta' || val === 'facebook') return 'meta_ads';
    if (val === 'google_ads' || val === 'google') return 'google_ads';
    if (val === 'whatsapp') return 'whatsapp';
    if (val === 'referral') return 'referral';
    if (val === 'manual') return 'manual';
    return 'website';
  }

  async captureWebhook(webhookKey: string, payload: Record<string, unknown>) {
    const key = String(webhookKey ?? '').trim();
    if (!key) {
      throw new NotFoundException('Webhook key is required.');
    }

    const tenantsCol = this.leadModel.db.collection('tenants');
    const tenant = await tenantsCol.findOne({ webhookKey: key });
    if (!tenant) {
      throw new NotFoundException('Invalid or rotated webhook key.');
    }

    const tenantObjectId = tenant._id as Types.ObjectId;
    const tenantIdStr = String(tenantObjectId);
    await this.superAdminService?.assertFeatureEnabled(tenantIdStr, 'apiWebhooks');
    const rawName = String(
      payload?.SENDER_NAME ??
        payload?.name ??
        payload?.fullName ??
        payload?.customerName ??
        '',
    ).trim();
    const rawPhone = String(
      payload?.SENDER_MOBILE ??
        payload?.phone ??
        payload?.mobile ??
        payload?.SENDER_MOBILE_ALT ??
        '',
    ).trim();
    const rawEmail = String(
      payload?.SENDER_EMAIL ?? payload?.email ?? '',
    )
      .trim()
      .toLowerCase();

    if (!rawName && !rawPhone && !rawEmail) {
      throw new BadRequestException(
        'Webhook payload must include a contact name, phone, or email.',
      );
    }

    const formattedPhone = normalizeIndianPhone(rawPhone) ?? rawPhone;
    const inferredSource = payload?.SENDER_NAME || payload?.QUERY_ID
      ? 'indiamart'
      : this.resolveWebhookSource(payload?.source);

    const rawNotes = String(
      payload?.QUERY_MESSAGE ??
        payload?.QUERY_PRODUCT_NAME ??
        payload?.notes ??
        payload?.message ??
        '',
    ).trim();

    const existing = await this.findDuplicateLead(
      tenantObjectId,
      formattedPhone,
      rawEmail,
    );

    if (existing) {
      existing.activities.unshift({
        id: randomBytes(6).toString('hex'),
        type: 'note',
        description: `Inbound ${inferredSource} webhook inquiry: ${rawNotes || 'Repeat inquiry captured automatically.'}`,
        authorName: 'Webhook Capture',
        createdAt: new Date().toISOString(),
      });
      await existing.save();

      await this.auditService?.record({
        tenantId: tenantIdStr,
        actorId: String(existing.ownerId),
        actorName: 'Webhook Capture',
        actorRole: 'system',
        action: 'lead.webhook_deduplicated',
        entityType: 'lead',
        entityId: String(existing._id),
        entityLabel: existing.name,
        summary: `Deduplicated inbound ${inferredSource} inquiry for ${existing.name}`,
      });

      return {
        status: 'deduplicated' as const,
        assignedRepName: 'Existing Owner',
        lead: this.toDto(existing, false),
      };
    }

    const usersCol = this.leadModel.db.collection('users');
    const reps = await usersCol
      .find({ tenantId: tenantObjectId, isActive: { $ne: false } })
      .sort({ _id: 1 })
      .toArray();

    if (reps.length === 0) {
      throw new BadRequestException('No active sales users in workspace.');
    }

    const currentIdx = Number(tenant.roundRobinIndex ?? 0);
    const chosenRep = reps[currentIdx % reps.length];
    await tenantsCol.updateOne(
      { _id: tenantObjectId },
      { $set: { roundRobinIndex: (currentIdx + 1) % reps.length } },
    );

    const repAuth: AuthContext = {
      userId: String(chosenRep._id),
      tenantId: tenantIdStr,
      email: String(chosenRep.email ?? 'webhook@leadsetu.in'),
    };
    const repName = String(chosenRep.name ?? 'Sales Rep');

    const leadName = rawName || `Inquiry ${formattedPhone || rawEmail}`;
    const company = String(
      payload?.SENDER_COMPANY ?? payload?.company ?? '',
    ).trim();
    const city = String(
      payload?.SENDER_CITY ?? payload?.city ?? 'Delhi-NCR',
    ).trim();
    const estimatedValue = Number(payload?.estimatedValue ?? payload?.budget ?? 0) || 0;

    const created = await this.create(repAuth, {
      name: leadName,
      company,
      phone: formattedPhone,
      email: rawEmail,
      city,
      source: inferredSource,
      estimatedValue,
      notes: rawNotes || `Captured live via ${inferredSource} webhook`,
    });

    await this.auditService?.record({
      tenantId: tenantIdStr,
      actorId: repAuth.userId,
      actorName: 'Webhook Capture',
      actorEmail: repAuth.email,
      actorRole: 'system',
      action: 'lead.webhook_captured',
      entityType: 'lead',
      entityId: created.id,
      entityLabel: created.name,
      summary: `Captured ${inferredSource} webhook lead ${created.name}, assigned round-robin to ${repName}`,
    });

    return {
      status: 'created' as const,
      assignedRepName: repName,
      lead: created,
    };
  }
}
