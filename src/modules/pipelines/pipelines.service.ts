import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Model, Types } from 'mongoose';
import {
  DEFAULT_PIPELINE_STAGES,
  Pipeline,
  PipelineDocument,
  PipelineStage,
  StageCategory,
} from './schemas/pipeline.schema';
import { Deal, DealDocument } from '../deals/schemas/deal.schema';
import { CreatePipelineDto, UpdatePipelineDto } from './dto/pipeline.dto';

export interface PipelineAuthContext {
  userId: string;
  tenantId: string;
  email: string;
  role: string;
}

const PRESET_TEMPLATES: Record<string, PipelineStage[]> = {
  b2b_sales: DEFAULT_PIPELINE_STAGES,
  dealer_onboarding: [
    { id: 'inquiry', name: 'Distributor Inquiry', probability: 20, color: '#3978EA', category: 'open', rottenAfterDays: 7 },
    { id: 'kyc_gst', name: 'GSTIN & Shop KYC', probability: 40, color: '#0EA5E9', category: 'open', rottenAfterDays: 5 },
    { id: 'sample_dispatch', name: 'Sample & Rate Card', probability: 65, color: '#8B5CF6', category: 'open', rottenAfterDays: 7 },
    { id: 'security_deposit', name: 'Margin & Stock PO', probability: 85, color: '#F59E0B', category: 'open', rottenAfterDays: 5 },
    { id: 'won', name: 'Onboarded Partner', probability: 100, color: '#10B981', category: 'won', rottenAfterDays: 0 },
    { id: 'lost', name: 'Dropped', probability: 0, color: '#64748B', category: 'lost', rottenAfterDays: 0 },
  ],
  amc_renewals: [
    { id: 'upcoming', name: 'Renewal Due (30d)', probability: 35, color: '#3978EA', category: 'open', rottenAfterDays: 10 },
    { id: 'audit_quote', name: 'Service Quote Shared', probability: 60, color: '#F59E0B', category: 'open', rottenAfterDays: 7 },
    { id: 'po_pending', name: 'PO / Approval', probability: 85, color: '#EC4899', category: 'open', rottenAfterDays: 5 },
    { id: 'won', name: 'Renewed', probability: 100, color: '#10B981', category: 'won', rottenAfterDays: 0 },
    { id: 'lost', name: 'Churned', probability: 0, color: '#64748B', category: 'lost', rottenAfterDays: 0 },
  ],
  blank: [
    { id: 'new_deal', name: 'New Opportunity', probability: 25, color: '#3978EA', category: 'open', rottenAfterDays: 7 },
    { id: 'in_progress', name: 'In Progress', probability: 60, color: '#F59E0B', category: 'open', rottenAfterDays: 7 },
    { id: 'won', name: 'Closed Won', probability: 100, color: ' #10B981'.trim(), category: 'won', rottenAfterDays: 0 },
    { id: 'lost', name: 'Closed Lost', probability: 0, color: '#64748B', category: 'lost', rottenAfterDays: 0 },
  ],
};

function slugifyStageId(raw: string): string {
  const slug = raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return slug || `stage_${Date.now().toString(36)}`;
}

@Injectable()
export class PipelinesService {
  constructor(
    @InjectModel(Pipeline.name)
    private readonly pipelineModel: Model<PipelineDocument>,
    @InjectModel(Deal.name)
    private readonly dealModel: Model<DealDocument>,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  async verifyAuth(authHeader?: string): Promise<PipelineAuthContext> {
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

  private assertCanConfigurePipelines(auth: PipelineAuthContext) {
    if (auth.role !== 'owner' && auth.role !== 'admin') {
      throw new ForbiddenException(
        'Only Workspace Owners or Admins can create, edit, or delete sales pipelines.',
      );
    }
  }

  private normalizeStages(inputStages: Array<Partial<PipelineStage>>): PipelineStage[] {
    if (!Array.isArray(inputStages) || inputStages.length < 2) {
      throw new BadRequestException(
        'A pipeline must contain at least 2 stages (e.g. an open stage and an outcome stage).',
      );
    }

    const seenIds = new Set<string>();
    const normalized: PipelineStage[] = [];

    for (const raw of inputStages) {
      const name = String(raw.name || '').trim();
      if (!name) {
        throw new BadRequestException('Every pipeline stage must have a non-empty name.');
      }

      let id = slugifyStageId(String(raw.id || name));
      let counter = 2;
      while (seenIds.has(id)) {
        id = `${slugifyStageId(String(raw.id || name))}_${counter}`;
        counter += 1;
      }
      seenIds.add(id);

      const category: StageCategory =
        raw.category === 'won' || raw.category === 'lost' ? raw.category : 'open';

      const probRaw = Number(raw.probability);
      const probability = Number.isFinite(probRaw)
        ? Math.min(100, Math.max(0, Math.round(probRaw)))
        : category === 'won'
          ? 100
          : category === 'lost'
            ? 0
            : 50;

      const color =
        typeof raw.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(raw.color.trim())
          ? raw.color.trim()
          : category === 'won'
            ? '#10B981'
            : category === 'lost'
              ? '#64748B'
              : '#3978EA';

      normalized.push({
        id,
        name,
        probability,
        color,
        category,
        rottenAfterDays: Math.max(0, Number(raw.rottenAfterDays) || 0),
        requireNoteOnEnter: Boolean(raw.requireNoteOnEnter),
      });
    }

    if (!normalized.some((s) => s.category === 'open')) {
      throw new BadRequestException(
        'A pipeline must include at least one active (open) stage.',
      );
    }

    return normalized;
  }

  async ensureDefaultPipeline(tenantId: string): Promise<PipelineDocument> {
    const tenantObjectId = new Types.ObjectId(tenantId);
    const existing = await this.pipelineModel
      .find({ tenantId: tenantObjectId })
      .sort({ isDefault: -1, createdAt: 1 })
      .exec();

    if (existing.length > 0) {
      const def = existing.find((p) => p.isDefault);
      if (def) return def;
      existing[0].isDefault = true;
      await existing[0].save();
      return existing[0];
    }

    return this.pipelineModel.create({
      tenantId: tenantObjectId,
      name: 'B2B Sales Pipeline',
      description: 'Default workspace deal workflow synced across Leads, Quotes & GST Invoices.',
      isDefault: true,
      stages: DEFAULT_PIPELINE_STAGES,
    });
  }

  async resolvePipelineForTenant(
    tenantId: string,
    pipelineId?: string,
  ): Promise<PipelineDocument> {
    const defaultPipeline = await this.ensureDefaultPipeline(tenantId);
    if (!pipelineId || pipelineId === 'default' || pipelineId === 'all') {
      return defaultPipeline;
    }
    if (!Types.ObjectId.isValid(pipelineId)) {
      return defaultPipeline;
    }
    const target = await this.pipelineModel
      .findOne({
        _id: new Types.ObjectId(pipelineId),
        tenantId: new Types.ObjectId(tenantId),
      })
      .exec();
    return target || defaultPipeline;
  }

  private toDto(
    doc: PipelineDocument,
    stats?: { dealCount: number; totalValue: number; stageCounts: Record<string, number> },
  ) {
    const raw = doc.toObject() as unknown as Record<string, unknown> & {
      createdAt?: Date;
      updatedAt?: Date;
    };
    return {
      id: doc._id.toString(),
      tenantId: doc.tenantId.toString(),
      name: doc.name,
      description: doc.description || '',
      isDefault: Boolean(doc.isDefault),
      stages: doc.stages || DEFAULT_PIPELINE_STAGES,
      dealCount: stats?.dealCount ?? 0,
      totalValue: stats?.totalValue ?? 0,
      stageCounts: stats?.stageCounts ?? {},
      createdAt: raw.createdAt
        ? new Date(raw.createdAt).toISOString()
        : new Date().toISOString(),
      updatedAt: raw.updatedAt
        ? new Date(raw.updatedAt).toISOString()
        : new Date().toISOString(),
    };
  }

  async listPipelines(auth: PipelineAuthContext) {
    const defaultPipeline = await this.ensureDefaultPipeline(auth.tenantId);
    const tenantObjectId = new Types.ObjectId(auth.tenantId);
    const [pipelines, deals] = await Promise.all([
      this.pipelineModel
        .find({ tenantId: tenantObjectId })
        .sort({ isDefault: -1, createdAt: 1 })
        .exec(),
      this.dealModel
        .find({ tenantId: tenantObjectId })
        .select({ pipelineId: 1, stage: 1, value: 1 })
        .exec(),
    ]);

    const defaultId = defaultPipeline._id.toString();
    const statsByPipeline = new Map<
      string,
      { dealCount: number; totalValue: number; stageCounts: Record<string, number> }
    >();

    for (const d of deals) {
      const pid = d.pipelineId ? d.pipelineId.toString() : defaultId;
      const entry = statsByPipeline.get(pid) || {
        dealCount: 0,
        totalValue: 0,
        stageCounts: {},
      };
      entry.dealCount += 1;
      entry.totalValue += Number(d.value) || 0;
      const st = d.stage || 'qualified';
      entry.stageCounts[st] = (entry.stageCounts[st] || 0) + 1;
      statsByPipeline.set(pid, entry);
    }

    return {
      data: pipelines.map((p) => this.toDto(p, statsByPipeline.get(p._id.toString()))),
      defaultPipelineId: defaultId,
    };
  }

  async createPipeline(auth: PipelineAuthContext, dto: CreatePipelineDto) {
    this.assertCanConfigurePipelines(auth);
    const name = dto.name?.trim();
    if (!name) {
      throw new BadRequestException('Pipeline name is required.');
    }

    await this.ensureDefaultPipeline(auth.tenantId);
    const tenantObjectId = new Types.ObjectId(auth.tenantId);

    const templateStages =
      (dto.template && PRESET_TEMPLATES[dto.template]) || DEFAULT_PIPELINE_STAGES;
    const stages = dto.stages?.length
      ? this.normalizeStages(dto.stages)
      : templateStages.map((s) => ({ ...s }));

    if (dto.isDefault) {
      await this.pipelineModel
        .updateMany({ tenantId: tenantObjectId }, { $set: { isDefault: false } })
        .exec();
    }

    const doc = await this.pipelineModel.create({
      tenantId: tenantObjectId,
      name,
      description: dto.description?.trim() || '',
      isDefault: Boolean(dto.isDefault),
      stages,
      createdBy: new Types.ObjectId(auth.userId),
    });

    return this.toDto(doc);
  }

  async updatePipeline(
    auth: PipelineAuthContext,
    id: string,
    dto: UpdatePipelineDto,
  ) {
    this.assertCanConfigurePipelines(auth);
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Pipeline not found.');
    }

    const tenantObjectId = new Types.ObjectId(auth.tenantId);
    const doc = await this.pipelineModel
      .findOne({ _id: new Types.ObjectId(id), tenantId: tenantObjectId })
      .exec();

    if (!doc) {
      throw new NotFoundException('Pipeline not found.');
    }

    if (dto.name !== undefined) {
      const trimmed = dto.name.trim();
      if (!trimmed) {
        throw new BadRequestException('Pipeline name cannot be empty.');
      }
      doc.name = trimmed;
    }

    if (dto.description !== undefined) {
      doc.description = dto.description.trim();
    }

    if (dto.stages !== undefined) {
      const nextStages = this.normalizeStages(dto.stages);
      const nextIds = new Set(nextStages.map((s) => s.id));
      const removedIds = (doc.stages || [])
        .map((s) => s.id)
        .filter((oldId) => !nextIds.has(oldId));

      if (removedIds.length > 0) {
        const dealScopeFilter = doc.isDefault
          ? {
              tenantId: tenantObjectId,
              $or: [{ pipelineId: doc._id }, { pipelineId: null }, { pipelineId: { $exists: false } }],
              stage: { $in: removedIds },
            }
          : {
              tenantId: tenantObjectId,
              pipelineId: doc._id,
              stage: { $in: removedIds },
            };

        const affectedDeals = await this.dealModel.find(dealScopeFilter).exec();
        const fallbackStage =
          nextStages.find((s) => s.category === 'open') || nextStages[0];

        if (affectedDeals.length > 0) {
          for (const deal of affectedDeals) {
            const explicitTarget = dto.stageMigrations?.[deal.stage];
            const targetStage =
              (explicitTarget && nextStages.find((s) => s.id === explicitTarget)) ||
              fallbackStage;
            deal.stage = targetStage.id;
            deal.probability = targetStage.probability;
            deal.stageCategory = targetStage.category;
            await deal.save();
          }
        }
      }

      doc.stages = nextStages;
    }

    if (dto.isDefault === true && !doc.isDefault) {
      await this.pipelineModel
        .updateMany(
          { tenantId: tenantObjectId, _id: { $ne: doc._id } },
          { $set: { isDefault: false } },
        )
        .exec();
      doc.isDefault = true;
    }

    await doc.save();
    return this.toDto(doc);
  }

  async setDefaultPipeline(auth: PipelineAuthContext, id: string) {
    return this.updatePipeline(auth, id, { isDefault: true });
  }

  async deletePipeline(
    auth: PipelineAuthContext,
    id: string,
    reassignToPipelineId?: string,
  ) {
    this.assertCanConfigurePipelines(auth);
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Pipeline not found.');
    }

    const tenantObjectId = new Types.ObjectId(auth.tenantId);
    const doc = await this.pipelineModel
      .findOne({ _id: new Types.ObjectId(id), tenantId: tenantObjectId })
      .exec();

    if (!doc) {
      throw new NotFoundException('Pipeline not found.');
    }
    if (doc.isDefault) {
      throw new BadRequestException(
        'Cannot delete the default workspace pipeline. Set another pipeline as default first.',
      );
    }

    const defaultPipeline = await this.ensureDefaultPipeline(auth.tenantId);
    let targetPipeline = defaultPipeline;
    if (
      reassignToPipelineId &&
      reassignToPipelineId !== id &&
      Types.ObjectId.isValid(reassignToPipelineId)
    ) {
      const candidate = await this.pipelineModel
        .findOne({
          _id: new Types.ObjectId(reassignToPipelineId),
          tenantId: tenantObjectId,
        })
        .exec();
      if (candidate) targetPipeline = candidate;
    }

    const fallbackOpen =
      targetPipeline.stages.find((s) => s.category === 'open') ||
      targetPipeline.stages[0];

    const dealsInPipeline = await this.dealModel
      .find({ tenantId: tenantObjectId, pipelineId: doc._id })
      .exec();

    for (const deal of dealsInPipeline) {
      const matchedStage =
        targetPipeline.stages.find((s) => s.id === deal.stage) || fallbackOpen;
      deal.pipelineId = targetPipeline._id;
      deal.stage = matchedStage.id;
      deal.probability = matchedStage.probability;
      deal.stageCategory = matchedStage.category;
      await deal.save();
    }

    await this.pipelineModel.deleteOne({ _id: doc._id }).exec();

    return {
      deleted: true,
      id,
      reassignedDealsCount: dealsInPipeline.length,
      reassignedToPipelineId: targetPipeline._id.toString(),
    };
  }
}
