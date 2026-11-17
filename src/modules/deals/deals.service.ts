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
  Deal,
  DealActivity,
  DealDocument,
  DealStage,
} from './schemas/deal.schema';
import { AuditService } from '../audit/audit.module';
import { maskPhoneNumber, resolveOwnerScopeFilter } from '../auth/identity.util';

export interface CreateDealDto {
  title: string;
  company?: string;
  contactName?: string;
  contactPhone?: string;
  contactEmail?: string;
  city?: string;
  value?: number;
  stage?: DealStage;
  probability?: number;
  expectedCloseDate?: string;
  source?: string;
  gstApplicable?: boolean;
  notes?: string;
  tags?: string[];
}

export type UpdateDealDto = Partial<CreateDealDto>;

interface AuthContext {
  userId: string;
  tenantId: string;
  email: string;
}

const stageProbabilities: Record<DealStage, number> = {
  qualified: 25,
  discovery: 45,
  proposal: 65,
  negotiation: 85,
  won: 100,
  lost: 0,
};

@Injectable()
export class DealsService {
  constructor(
    @InjectModel(Deal.name) private readonly dealModel: Model<DealDocument>,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    @Optional() private readonly auditService?: AuditService,
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

  private toDto(doc: DealDocument, maskPhones = false) {
    const raw = doc.toObject() as unknown as Record<string, unknown> & {
      createdAt?: Date;
      updatedAt?: Date;
    };
    return {
      id: doc._id.toString(),
      tenantId: doc.tenantId.toString(),
      ownerId: doc.ownerId.toString(),
      title: doc.title,
      company: doc.company || '',
      contactName: doc.contactName || '',
      contactPhone: maskPhones
        ? maskPhoneNumber(doc.contactPhone)
        : doc.contactPhone || '',
      contactEmail: doc.contactEmail || '',
      city: doc.city || 'Delhi-NCR',
      value: doc.value || 0,
      stage: doc.stage || 'qualified',
      probability:
        doc.probability ?? stageProbabilities[doc.stage || 'qualified'] ?? 40,
      expectedCloseDate: doc.expectedCloseDate || '',
      source: doc.source || 'whatsapp',
      gstApplicable: doc.gstApplicable ?? true,
      notes: doc.notes || '',
      tags: doc.tags || [],
      activities: doc.activities || [],
      createdAt: raw.createdAt
        ? new Date(raw.createdAt).toISOString()
        : new Date().toISOString(),
      updatedAt: raw.updatedAt
        ? new Date(raw.updatedAt).toISOString()
        : new Date().toISOString(),
    };
  }

  async findAll(
    auth: AuthContext,
    query: { search?: string; stage?: string },
  ) {
    const tenantObjectId = new Types.ObjectId(auth.tenantId);
    const ownerScope = await resolveOwnerScopeFilter(this.dealModel.db, auth);
    const baseScope: Record<string, unknown> = {
      tenantId: tenantObjectId,
      ...ownerScope,
    };
    const filter: Record<string, unknown> = { ...baseScope };

    if (query.stage && query.stage !== 'all') {
      filter.stage = query.stage;
    }
    if (query.search?.trim()) {
      const regex = new RegExp(query.search.trim(), 'i');
      filter.$or = [
        { title: regex },
        { company: regex },
        { contactName: regex },
        { city: regex },
      ];
    }

    const [docs, allDeals, maskPhones] = await Promise.all([
      this.dealModel.find(filter).sort({ updatedAt: -1 }).exec(),
      this.dealModel.find(baseScope).exec(),
      this.auditService
        ? this.auditService.shouldMaskViewerPhones(auth.tenantId, auth.userId)
        : Promise.resolve(false),
    ]);

    const openDeals = allDeals.filter(
      (d) => d.stage !== 'won' && d.stage !== 'lost',
    );
    const wonDeals = allDeals.filter((d) => d.stage === 'won');

    const openPipelineValue = openDeals.reduce(
      (sum, d) => sum + (Number(d.value) || 0),
      0,
    );
    const weightedForecast = openDeals.reduce(
      (sum, d) =>
        sum +
        Math.round(((Number(d.value) || 0) * (d.probability || 40)) / 100),
      0,
    );
    const wonRevenue = wonDeals.reduce(
      (sum, d) => sum + (Number(d.value) || 0),
      0,
    );

    return {
      data: docs.map((d) => this.toDto(d, maskPhones)),
      stats: {
        totalDeals: allDeals.length,
        openCount: openDeals.length,
        wonCount: wonDeals.length,
        openPipelineValue,
        weightedForecast,
        wonRevenue,
      },
    };
  }

  async findOne(auth: AuthContext, id: string) {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Deal not found.');
    }
    const ownerScope = await resolveOwnerScopeFilter(this.dealModel.db, auth);
    const doc = await this.dealModel
      .findOne({
        _id: new Types.ObjectId(id),
        tenantId: new Types.ObjectId(auth.tenantId),
        ...ownerScope,
      })
      .exec();
    if (!doc) {
      throw new NotFoundException('Deal not found.');
    }
    const maskPhones = this.auditService
      ? await this.auditService.shouldMaskViewerPhones(auth.tenantId, auth.userId)
      : false;
    return this.toDto(doc, maskPhones);
  }

  async create(auth: AuthContext, dto: CreateDealDto) {
    if (!dto.title?.trim()) {
      throw new BadRequestException('Deal title is required.');
    }
    const stage: DealStage = dto.stage || 'qualified';
    const probability =
      dto.probability !== undefined
        ? Number(dto.probability)
        : stageProbabilities[stage];

    const activity: DealActivity = {
      id: randomBytes(6).toString('hex'),
      type: 'created',
      description: `Deal created in "${stage.toUpperCase()}" stage · Value ₹${(
        Number(dto.value) || 0
      ).toLocaleString('en-IN')}`,
      authorName: auth.email.split('@')[0],
      createdAt: new Date().toISOString(),
    };

    const doc = await this.dealModel.create({
      tenantId: new Types.ObjectId(auth.tenantId),
      ownerId: new Types.ObjectId(auth.userId),
      title: dto.title.trim(),
      company: dto.company?.trim() || '',
      contactName: dto.contactName?.trim() || '',
      contactPhone: dto.contactPhone?.trim() || '',
      contactEmail: dto.contactEmail?.trim() || '',
      city: dto.city?.trim() || 'New Delhi',
      value: Number(dto.value) || 0,
      stage,
      probability,
      expectedCloseDate:
        dto.expectedCloseDate ||
        new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10),
      source: dto.source || 'whatsapp',
      gstApplicable: dto.gstApplicable ?? true,
      notes: dto.notes?.trim() || '',
      tags: Array.isArray(dto.tags) ? dto.tags : [],
      activities: [activity],
    });

    return this.toDto(doc);
  }

  async update(auth: AuthContext, id: string, dto: UpdateDealDto) {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Deal not found.');
    }
    const ownerScope = await resolveOwnerScopeFilter(this.dealModel.db, auth);
    const doc = await this.dealModel
      .findOne({
        _id: new Types.ObjectId(id),
        tenantId: new Types.ObjectId(auth.tenantId),
        ...ownerScope,
      })
      .exec();
    if (!doc) {
      throw new NotFoundException('Deal not found.');
    }

    const prevStage = doc.stage;
    if (dto.title !== undefined) doc.title = dto.title.trim();
    if (dto.company !== undefined) doc.company = dto.company.trim();
    if (dto.contactName !== undefined) doc.contactName = dto.contactName.trim();
    if (dto.contactPhone !== undefined)
      doc.contactPhone = dto.contactPhone.trim();
    if (dto.contactEmail !== undefined)
      doc.contactEmail = dto.contactEmail.trim();
    if (dto.city !== undefined) doc.city = dto.city.trim();
    if (dto.value !== undefined) doc.value = Number(dto.value) || 0;
    if (dto.expectedCloseDate !== undefined)
      doc.expectedCloseDate = dto.expectedCloseDate;
    if (dto.source !== undefined) doc.source = dto.source;
    if (dto.gstApplicable !== undefined) doc.gstApplicable = dto.gstApplicable;
    if (dto.notes !== undefined) doc.notes = dto.notes.trim();
    if (dto.tags !== undefined) doc.tags = dto.tags;

    if (dto.stage !== undefined) {
      doc.stage = dto.stage;
      if (dto.probability === undefined) {
        doc.probability = stageProbabilities[dto.stage];
      }
    }
    if (dto.probability !== undefined) {
      doc.probability = Number(dto.probability);
    }

    if (dto.stage && dto.stage !== prevStage) {
      const activity: DealActivity = {
        id: randomBytes(6).toString('hex'),
        type: 'stage_change',
        description: `Moved deal from ${prevStage.toUpperCase()} → ${dto.stage.toUpperCase()} (${doc.probability}% win probability)`,
        authorName: auth.email.split('@')[0],
        createdAt: new Date().toISOString(),
      };
      doc.activities = [activity, ...(doc.activities || [])];
    }

    await doc.save();
    if (dto.stage && dto.stage !== prevStage) {
      await this.auditService?.record({
        tenantId: auth.tenantId,
        actorId: auth.userId,
        actorEmail: auth.email,
        action: 'deal.stage_changed',
        entityType: 'deal',
        entityId: doc._id.toString(),
        entityLabel: `${doc.title}${doc.company ? ` (${doc.company})` : ''}`,
        summary: `Moved deal "${doc.title}" stage: ${prevStage.toUpperCase()} -> ${dto.stage.toUpperCase()}`,
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
    body: { type?: DealActivity['type']; description: string },
  ) {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Deal not found.');
    }
    const ownerScope = await resolveOwnerScopeFilter(this.dealModel.db, auth);
    const doc = await this.dealModel
      .findOne({
        _id: new Types.ObjectId(id),
        tenantId: new Types.ObjectId(auth.tenantId),
        ...ownerScope,
      })
      .exec();
    if (!doc) {
      throw new NotFoundException('Deal not found.');
    }
    const activity: DealActivity = {
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
      throw new NotFoundException('Deal not found.');
    }
    const ownerScope = await resolveOwnerScopeFilter(this.dealModel.db, auth);
    const doc = await this.dealModel
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
        action: 'deal.deleted',
        entityType: 'deal',
        entityId: id,
        entityLabel: doc.title,
        summary: `Deleted deal "${doc.title}"`,
      });
    }
    return { success: true, id };
  }
}
