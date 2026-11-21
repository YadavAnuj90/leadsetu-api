import {
  BadRequestException,
  Injectable,
  NotFoundException,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import {
  InjectModel,
  Prop,
  Schema,
  SchemaFactory,
} from '@nestjs/mongoose';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { HydratedDocument, Model, Types } from 'mongoose';
import {
  CreateWorkflowDto,
  WorkflowActionType,
  WorkflowTriggerType,
} from './dto/workflows.dto';
import { SuperAdminService } from '../super-admin/super-admin.service';
import { resolveOwnerScopeFilter } from '../auth/identity.util';
import { InboxService } from '../inbox/inbox.service';
import { Lead, LeadDocument } from '../leads/schemas/lead.schema';
import { AiBridgeService } from '../ai-bridge/ai-bridge.service';

export type WorkflowDocument = HydratedDocument<Workflow>;

@Schema({ _id: false })
export class WorkflowLogEntry {
  @Prop({ required: true })
  id!: string;

  @Prop({ required: true })
  summary!: string;

  @Prop({ default: 'success' })
  status!: 'success' | 'skipped';

  @Prop({ required: true })
  executedAt!: string;
}

export const WorkflowLogEntrySchema =
  SchemaFactory.createForClass(WorkflowLogEntry);

@Schema({ timestamps: true, collection: 'workflows' })
export class Workflow {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  ownerId!: Types.ObjectId;

  @Prop({ required: true, trim: true })
  name!: string;

  @Prop({ trim: true, default: '' })
  description!: string;

  @Prop({
    default: 'lead.created',
    enum: [
      'lead.created',
      'lead.hot_scored',
      'lead.stale_followup',
      'deal.stage_changed',
      'invoice.overdue',
      'whatsapp.inbound',
    ],
  })
  triggerType!: WorkflowTriggerType;

  @Prop({ trim: true, default: 'all' })
  sourceFilter?: string;

  @Prop({ trim: true, default: 'new' })
  staleStage?: string;

  @Prop({ type: Number, default: 24 })
  staleHours?: number;

  @Prop({ trim: true, default: '' })
  whatsappTemplateBody?: string;

  @Prop({ required: true, trim: true })
  conditionSummary!: string;

  @Prop({
    default: 'send_whatsapp_create_task',
    enum: [
      'send_whatsapp_create_task',
      'assign_senior_closer',
      'generate_gst_invoice',
      'send_payment_reminder',
    ],
  })
  actionType!: WorkflowActionType;

  @Prop({ required: true, trim: true })
  actionSummary!: string;

  @Prop({ type: Boolean, default: true })
  active!: boolean;

  @Prop({ type: Number, default: 0 })
  runsCount!: number;

  @Prop({ type: Number, default: 0 })
  hoursSaved!: number;

  @Prop({ trim: true, default: '' })
  lastRunAt!: string;

  @Prop({ type: [WorkflowLogEntrySchema], default: [] })
  executionLogs!: WorkflowLogEntry[];
}

export const WorkflowSchema = SchemaFactory.createForClass(Workflow);

@Injectable()
export class WorkflowsService {
  constructor(
    @InjectModel(Workflow.name)
    private readonly workflowModel: Model<WorkflowDocument>,
    @InjectModel(Lead.name)
    private readonly leadModel: Model<LeadDocument>,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly inboxService: InboxService,
    @Optional() private readonly superAdminService?: SuperAdminService,
    @Optional() private readonly aiBridge?: AiBridgeService,
  ) {}

  async verifyAuth(authHeader?: string) {
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
      'aiWorkflows',
    );
    const userDoc = Types.ObjectId.isValid(payload.sub)
      ? await this.workflowModel.db
          .collection('users')
          .findOne(
            { _id: new Types.ObjectId(payload.sub) },
            { projection: { name: 1 } },
          )
      : null;

    return {
      userId: payload.sub,
      tenantId: payload.tenantId,
      email: payload.email,
      name:
        (userDoc?.name ? String(userDoc.name).trim() : '') ||
        payload.email.split('@')[0],
    };
  }

  private toDto(doc: WorkflowDocument) {
    const raw = doc.toObject() as unknown as Record<string, unknown> & {
      createdAt?: Date;
      updatedAt?: Date;
    };
    return {
      id: doc._id.toString(),
      tenantId: doc.tenantId.toString(),
      name: doc.name,
      description: doc.description || '',
      triggerType: doc.triggerType || 'lead.created',
      sourceFilter: doc.sourceFilter || 'all',
      staleStage: doc.staleStage || 'new',
      staleHours: doc.staleHours ?? 24,
      whatsappTemplateBody: doc.whatsappTemplateBody || '',
      conditionSummary: doc.conditionSummary,
      actionType: doc.actionType || 'send_whatsapp_create_task',
      actionSummary: doc.actionSummary,
      active: Boolean(doc.active),
      runsCount: doc.runsCount || 0,
      hoursSaved: doc.hoursSaved || 0,
      lastRunAt:
        doc.lastRunAt ||
        (raw.updatedAt
          ? new Date(raw.updatedAt).toISOString()
          : new Date().toISOString()),
      executionLogs: doc.executionLogs || [],
      createdAt: raw.createdAt
        ? new Date(raw.createdAt).toISOString()
        : new Date().toISOString(),
    };
  }

  async findAll(
    auth: { userId: string; tenantId: string },
    query: { search?: string; triggerType?: string; active?: string },
  ) {
    const tenantObjectId = new Types.ObjectId(auth.tenantId);
    const ownerScope = await resolveOwnerScopeFilter(this.workflowModel.db, auth);
    const baseScope: Record<string, unknown> = {
      tenantId: tenantObjectId,
      ...ownerScope,
    };
    const filter: Record<string, unknown> = { ...baseScope };

    if (query.triggerType && query.triggerType !== 'all') {
      filter.triggerType = query.triggerType;
    }
    if (query.active === 'true') filter.active = true;
    if (query.active === 'false') filter.active = false;

    if (query.search?.trim()) {
      const regex = new RegExp(query.search.trim(), 'i');
      filter.$or = [
        { name: regex },
        { conditionSummary: regex },
        { actionSummary: regex },
      ];
    }

    const [docs, all] = await Promise.all([
      this.workflowModel.find(filter).sort({ createdAt: -1 }).exec(),
      this.workflowModel.find(baseScope).exec(),
    ]);

    const activeCount = all.filter((w) => w.active).length;
    const totalRuns = all.reduce((s, w) => s + (w.runsCount || 0), 0);
    const totalHoursSaved = all.reduce((s, w) => s + (w.hoursSaved || 0), 0);

    return {
      data: docs.map((d) => this.toDto(d)),
      stats: {
        totalWorkflows: all.length,
        activeWorkflows: activeCount,
        pausedWorkflows: all.length - activeCount,
        totalRuns,
        totalHoursSaved,
      },
    };
  }

  async create(
    auth: { userId: string; tenantId: string },
    dto: CreateWorkflowDto,
  ) {
    if (!dto.name?.trim()) {
      throw new BadRequestException('Workflow name is required.');
    }
    const runs =
      dto.runsCount !== undefined ? Math.max(0, Number(dto.runsCount)) : 0;
    const hoursSaved = Math.max(0, Math.round(runs * 0.15));
    const nowIso = new Date().toISOString();

    const doc = await this.workflowModel.create({
      tenantId: new Types.ObjectId(auth.tenantId),
      ownerId: new Types.ObjectId(auth.userId),
      name: dto.name.trim(),
      description: dto.description?.trim() || '',
      triggerType: dto.triggerType || 'lead.created',
      sourceFilter: dto.sourceFilter?.trim() || 'all',
      staleStage: dto.staleStage?.trim() || 'new',
      staleHours:
        dto.staleHours !== undefined
          ? Math.max(0, Number(dto.staleHours))
          : 24,
      whatsappTemplateBody: dto.whatsappTemplateBody?.trim() || '',
      conditionSummary:
        dto.conditionSummary?.trim() || 'When trigger condition is met',
      actionType: dto.actionType || 'send_whatsapp_create_task',
      actionSummary:
        dto.actionSummary?.trim() ||
        'Send WhatsApp template & create follow-up task',
      active: dto.active ?? true,
      runsCount: runs,
      hoursSaved,
      lastRunAt: nowIso,
      executionLogs: [
        {
          id: `log-${Date.now()}`,
          summary: `Workflow initialized and listening (${dto.actionSummary || 'Ready'})`,
          status: 'success',
          executedAt: nowIso,
        },
      ],
    });

    return this.toDto(doc);
  }

  async toggleActive(auth: { userId: string; tenantId: string }, id: string) {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Workflow not found.');
    }
    const ownerScope = await resolveOwnerScopeFilter(this.workflowModel.db, auth);
    const doc = await this.workflowModel
      .findOne({
        _id: new Types.ObjectId(id),
        tenantId: new Types.ObjectId(auth.tenantId),
        ...ownerScope,
      })
      .exec();
    if (!doc) throw new NotFoundException('Workflow not found.');

    doc.active = !doc.active;
    await doc.save();
    return this.toDto(doc);
  }

  private async createWorkflowFollowUpTask(params: {
    tenantObjectId: Types.ObjectId;
    ownerId: Types.ObjectId;
    workflowName: string;
    triggerType: string;
    actionSummary: string;
    leadName: string;
    leadCompany?: string;
    leadPhone?: string;
  }) {
    try {
      const tasksCol = this.workflowModel.db.collection('tasks');
      await tasksCol.insertOne({
        tenantId: params.tenantObjectId,
        ownerId: params.ownerId,
        title: `[Auto-Workflow] ${params.workflowName}: ${params.leadName}`,
        description: `Automatically triggered (${params.triggerType}): ${params.actionSummary}`,
        priority: 'high',
        status: 'pending',
        category: 'whatsapp',
        dueDate: 'Today, 5:00 PM IST',
        relatedName: params.leadName,
        relatedCompany: params.leadCompany || '',
        relatedPhone: params.leadPhone || '',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    } catch {
      // Non-blocking task write
    }
  }

  private buildWelcomeMessage(wf: WorkflowDocument, lead: LeadDocument): string {
    if (wf.whatsappTemplateBody?.trim()) {
      return wf.whatsappTemplateBody.trim();
    }
    const srcLabel = (lead.source || 'website').toUpperCase();
    return lead.company
      ? `Namaste {{buyer_name}} ji 👋, thank you for your inquiry for {{company}} via ${srcLabel}. Sharing our product brochure & GST quotation details right away!`
      : `Namaste {{buyer_name}} ji 👋, thank you for reaching out via ${srcLabel}. Our specialist is reviewing your requirement and sharing our catalogue right away!`;
  }

  private buildStaleFollowUpMessage(
    wf: WorkflowDocument,
    lead: LeadDocument,
  ): string {
    if (wf.whatsappTemplateBody?.trim()) {
      return wf.whatsappTemplateBody.trim();
    }
    if (lead.status === 'proposal') {
      return 'Namaste {{buyer_name}} ji 👋, following up on the GST proposal sent for {{company}}. Please let us know if you need any price/spec clarification or priority dispatch.';
    }
    return 'Namaste {{buyer_name}} ji 👋, checking in on your recent inquiry for {{company}}. Reply YES if you would like a quick 5-minute call or updated price list.';
  }

  /**
   * Automatically runs active `lead.created` & `lead.hot_scored` workflows when a lead arrives
   * via manual creation, webhook (IndiaMART / Website / Meta Ads), or bulk import.
   */
  async handleLeadCreatedEvent(
    auth: { userId: string; tenantId: string; email: string; name?: string },
    lead: LeadDocument,
  ): Promise<void> {
    const tenantObjectId = new Types.ObjectId(auth.tenantId);
    const triggers: WorkflowTriggerType[] =
      (lead.aiScore || 0) >= 80
        ? ['lead.created', 'lead.hot_scored']
        : ['lead.created'];

    const workflows = await this.workflowModel
      .find({
        tenantId: tenantObjectId,
        active: true,
        triggerType: { $in: triggers },
      })
      .exec();

    if (workflows.length === 0) return;

    const nowIso = new Date().toISOString();
    const actorName = auth.name || auth.email.split('@')[0];

    for (const wf of workflows) {
      const sourceRule = (wf.sourceFilter || 'all').trim().toLowerCase();
      if (sourceRule && sourceRule !== 'all' && lead.source !== sourceRule) {
        continue;
      }

      let logStatus: 'success' | 'skipped' = 'success';
      let logSummary = `Triggered for lead "${lead.name}" (${lead.company || lead.city})`;

      if (lead.phone?.trim()) {
        const messageBody = this.buildWelcomeMessage(wf, lead);
        const dispatch = await this.inboxService.dispatchAutomatedWhatsApp({
          tenantId: auth.tenantId,
          userId: auth.userId,
          actorName,
          linkedEntityType: 'lead',
          linkedEntityId: lead._id.toString(),
          contactName: lead.name,
          company: lead.company || '',
          phone: lead.phone,
          city: lead.city || 'Delhi-NCR',
          estimatedValue: lead.estimatedValue || 0,
          messageBody,
          workflowId: wf._id.toString(),
          workflowName: wf.name,
          timelineMarker: `[Workflow:${wf._id.toString()}]`,
        });

        if (dispatch.skippedDnd) {
          logStatus = 'skipped';
          logSummary = `Skipped WhatsApp for "${lead.name}" (${lead.phone}) — Buyer opted out (DND)`;
        } else {
          const providerLabel =
            dispatch.deliveryProvider === 'meta_cloud'
              ? 'Meta Cloud'
              : 'CRM Inbox';
          logSummary = `Sent auto WhatsApp welcome (${providerLabel}) to ${lead.name} (${lead.phone})`;
        }
      } else {
        logStatus = 'skipped';
        logSummary = `Created follow-up task for "${lead.name}" (no phone number for WhatsApp)`;
      }

      await this.createWorkflowFollowUpTask({
        tenantObjectId,
        ownerId: Types.ObjectId.isValid(auth.userId)
          ? new Types.ObjectId(auth.userId)
          : lead.ownerId,
        workflowName: wf.name,
        triggerType: wf.triggerType,
        actionSummary: wf.actionSummary,
        leadName: lead.name,
        leadCompany: lead.company,
        leadPhone: lead.phone,
      });

      wf.runsCount = (wf.runsCount || 0) + 1;
      wf.hoursSaved = Math.max(1, Math.round(wf.runsCount * 0.15));
      wf.lastRunAt = nowIso;
      wf.executionLogs.unshift({
        id: `log-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
        summary: logSummary,
        status: logStatus,
        executedAt: nowIso,
      });
      if (wf.executionLogs.length > 10) {
        wf.executionLogs = wf.executionLogs.slice(0, 10);
      }
      wf.markModified('executionLogs');
      await wf.save();
    }
  }

  /**
   * Sweep leads resting in target stage (`new`, `proposal`, etc.) past `staleHours`
   * and dispatch automated WhatsApp follow-up nudges once per workflow rule.
   */
  async runStaleLeadFollowUps(
    auth: { userId: string; tenantId: string; email?: string; name?: string },
    options?: { workflowId?: string; forceImmediate?: boolean },
  ): Promise<{
    workflowsProcessed: number;
    followUpsSent: number;
    details: Array<{ workflowId: string; name: string; sentCount: number }>;
  }> {
    const tenantObjectId = new Types.ObjectId(auth.tenantId);
    const filter: Record<string, unknown> = {
      tenantId: tenantObjectId,
      triggerType: 'lead.stale_followup',
    };
    if (options?.workflowId && Types.ObjectId.isValid(options.workflowId)) {
      filter._id = new Types.ObjectId(options.workflowId);
    } else {
      filter.active = true;
    }

    const workflows = await this.workflowModel.find(filter).exec();
    if (workflows.length === 0) {
      return { workflowsProcessed: 0, followUpsSent: 0, details: [] };
    }

    const actorName =
      auth.name || (auth.email ? auth.email.split('@')[0] : 'Workflow Bot');
    let followUpsSent = 0;
    const details: Array<{ workflowId: string; name: string; sentCount: number }> =
      [];

    for (const wf of workflows) {
      const targetStage = (wf.staleStage || 'any').trim();
      const stageList =
        targetStage === 'any' || !targetStage
          ? ['new', 'proposal']
          : [targetStage];
      const delayHours = Math.max(0, Number(wf.staleHours ?? 24));
      const cutoffMs = options?.forceImmediate
        ? Date.now()
        : Date.now() - delayHours * 3600 * 1000;

      const candidates = await this.leadModel
        .find({
          tenantId: tenantObjectId,
          status: { $in: stageList },
          phone: { $exists: true, $ne: '' },
        })
        .sort({ updatedAt: 1 })
        .limit(50)
        .exec();

      const wfMarker = `[Workflow:${wf._id.toString()}]`;
      const nowIso = new Date().toISOString();
      let sentForWf = 0;

      for (const lead of candidates) {
        if (sentForWf >= 25) break;

        const alreadyFollowed = (lead.activities || []).some((a) =>
          String(a.description || '').includes(wfMarker),
        );
        if (alreadyFollowed) continue;

        const rawDoc = lead.toObject() as unknown as {
          updatedAt?: Date;
          createdAt?: Date;
        };
        const touchedAt = new Date(
          rawDoc.updatedAt || rawDoc.createdAt || Date.now(),
        ).getTime();

        if (!options?.forceImmediate && delayHours > 0 && touchedAt > cutoffMs) {
          continue;
        }

        const messageBody = this.buildStaleFollowUpMessage(wf, lead);
        const dispatch = await this.inboxService.dispatchAutomatedWhatsApp({
          tenantId: auth.tenantId,
          userId: auth.userId,
          actorName,
          linkedEntityType: 'lead',
          linkedEntityId: lead._id.toString(),
          contactName: lead.name,
          company: lead.company || '',
          phone: lead.phone,
          city: lead.city || 'Delhi-NCR',
          estimatedValue: lead.estimatedValue || 0,
          messageBody,
          workflowId: wf._id.toString(),
          workflowName: wf.name,
          timelineMarker: wfMarker,
        });

        if (dispatch.skippedDnd || dispatch.status === 'failed') {
          continue;
        }

        await this.createWorkflowFollowUpTask({
          tenantObjectId,
          ownerId: Types.ObjectId.isValid(auth.userId)
            ? new Types.ObjectId(auth.userId)
            : lead.ownerId,
          workflowName: wf.name,
          triggerType: wf.triggerType,
          actionSummary: wf.actionSummary,
          leadName: lead.name,
          leadCompany: lead.company,
          leadPhone: lead.phone,
        });

        sentForWf++;
        followUpsSent++;

        wf.runsCount = (wf.runsCount || 0) + 1;
        wf.hoursSaved = Math.max(1, Math.round(wf.runsCount * 0.15));
        wf.lastRunAt = nowIso;
        wf.executionLogs.unshift({
          id: `log-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
          summary: `Stale "${lead.status.toUpperCase()}" follow-up sent to ${lead.name} (${lead.phone})`,
          status: 'success',
          executedAt: nowIso,
        });
      }

      if (sentForWf > 0) {
        if (wf.executionLogs.length > 10) {
          wf.executionLogs = wf.executionLogs.slice(0, 10);
        }
        wf.markModified('executionLogs');
        await wf.save();
      }

      details.push({
        workflowId: wf._id.toString(),
        name: wf.name,
        sentCount: sentForWf,
      });
    }

    return {
      workflowsProcessed: workflows.length,
      followUpsSent,
      details,
    };
  }

  async executeNow(
    auth: { userId: string; tenantId: string; email?: string; name?: string },
    id: string,
  ) {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Workflow not found.');
    }
    const tenantObjectId = new Types.ObjectId(auth.tenantId);
    const ownerScope = await resolveOwnerScopeFilter(this.workflowModel.db, auth);
    const doc = await this.workflowModel
      .findOne({
        _id: new Types.ObjectId(id),
        tenantId: tenantObjectId,
        ...ownerScope,
      })
      .exec();
    if (!doc) throw new NotFoundException('Workflow not found.');

    if (doc.triggerType === 'lead.stale_followup') {
      const sweep = await this.runStaleLeadFollowUps(auth, {
        workflowId: id,
        forceImmediate: true,
      });
      const refreshed = await this.workflowModel.findById(doc._id).exec();
      if (sweep.followUpsSent === 0 && refreshed) {
        const nowIso = new Date().toISOString();
        refreshed.lastRunAt = nowIso;
        refreshed.executionLogs.unshift({
          id: `log-${Date.now()}`,
          summary: `Sweep complete — no uncontacted stale leads in "${refreshed.staleStage || 'new/proposal'}"`,
          status: 'skipped',
          executedAt: nowIso,
        });
        if (refreshed.executionLogs.length > 10) {
          refreshed.executionLogs = refreshed.executionLogs.slice(0, 10);
        }
        refreshed.markModified('executionLogs');
        await refreshed.save();
        return this.toDto(refreshed);
      }
      return this.toDto(refreshed || doc);
    }

    const nowIso = new Date().toISOString();
    doc.runsCount = (doc.runsCount || 0) + 1;
    doc.hoursSaved = Math.max(1, Math.round(doc.runsCount * 0.15));
    doc.lastRunAt = nowIso;

    const latestLead = await this.leadModel
      .findOne({
        tenantId: tenantObjectId,
        phone: { $exists: true, $ne: '' },
      })
      .sort({ createdAt: -1 })
      .exec();

    let logMessage = `Executed "${doc.actionSummary}" — Follow-up task created in /tasks.`;
    let logStatus: 'success' | 'skipped' = 'success';

    if (latestLead) {
      const actorName =
        auth.name || (auth.email ? auth.email.split('@')[0] : 'Workflow Bot');
      const messageBody = this.buildWelcomeMessage(doc, latestLead);
      const dispatch = await this.inboxService.dispatchAutomatedWhatsApp({
        tenantId: auth.tenantId,
        userId: auth.userId,
        actorName,
        linkedEntityType: 'lead',
        linkedEntityId: latestLead._id.toString(),
        contactName: latestLead.name,
        company: latestLead.company || '',
        phone: latestLead.phone,
        city: latestLead.city || 'Delhi-NCR',
        estimatedValue: latestLead.estimatedValue || 0,
        messageBody,
        workflowId: doc._id.toString(),
        workflowName: doc.name,
      });

      await this.createWorkflowFollowUpTask({
        tenantObjectId,
        ownerId: new Types.ObjectId(auth.userId),
        workflowName: doc.name,
        triggerType: doc.triggerType,
        actionSummary: doc.actionSummary,
        leadName: latestLead.name,
        leadCompany: latestLead.company,
        leadPhone: latestLead.phone,
      });

      if (dispatch.skippedDnd) {
        logStatus = 'skipped';
        logMessage = `Skipped WhatsApp for ${latestLead.name} (${latestLead.phone}) — Buyer opted out (DND).`;
      } else {
        logMessage = `Sent WhatsApp (${dispatch.deliveryProvider === 'meta_cloud' ? 'Meta Cloud' : 'CRM Inbox'}) to ${latestLead.name} (${latestLead.phone}) & created Task.`;
      }
    } else {
      await this.createWorkflowFollowUpTask({
        tenantObjectId,
        ownerId: new Types.ObjectId(auth.userId),
        workflowName: doc.name,
        triggerType: doc.triggerType,
        actionSummary: doc.actionSummary,
        leadName: 'Sample CRM Buyer',
        leadCompany: 'Demo Prospect',
        leadPhone: '',
      });
    }

    doc.executionLogs.unshift({
      id: `log-${Date.now()}`,
      summary: logMessage,
      status: logStatus,
      executedAt: nowIso,
    });
    if (doc.executionLogs.length > 10) {
      doc.executionLogs = doc.executionLogs.slice(0, 10);
    }
    doc.markModified('executionLogs');

    await doc.save();
    return this.toDto(doc);
  }

  async remove(auth: { userId: string; tenantId: string }, id: string) {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Workflow not found.');
    }
    const ownerScope = await resolveOwnerScopeFilter(this.workflowModel.db, auth);
    await this.workflowModel
      .deleteOne({
        _id: new Types.ObjectId(id),
        tenantId: new Types.ObjectId(auth.tenantId),
        ...ownerScope,
      })
      .exec();
    return { success: true, id };
  }

  private buildLocalWorkflowDraft(promptText: string) {
    const goal = promptText.trim();
    const lower = goal.toLowerCase();

    const sourceFilter = /indiamart/i.test(lower)
      ? 'indiamart'
      : /justdial/i.test(lower)
        ? 'justdial'
        : /meta|facebook|instagram/i.test(lower)
          ? 'meta_ads'
          : /website|web form/i.test(lower)
            ? 'website'
            : /whatsapp/i.test(lower) &&
                !/send.*whatsapp|on whatsapp|via whatsapp/i.test(lower)
              ? 'whatsapp'
              : 'all';

    const hourMatch = lower.match(/(\d+)\s*(?:h|hr|hrs|hour|hours)/i);
    const dayMatch = lower.match(/(\d+)\s*(?:d|day|days)/i);
    const staleHours = hourMatch
      ? Math.min(720, Math.max(1, Number(hourMatch[1])))
      : dayMatch
        ? Math.min(720, Math.max(1, Number(dayMatch[1]) * 24))
        : 24;

    const cityMatch = goal.match(
      /\b(Noida|Delhi-NCR|Delhi|Gurugram|Gurgaon|Pune|Mumbai|Ahmedabad|Bengaluru|Bangalore|Chennai|Hyderabad|Surat|Jaipur)\b/i,
    );
    const cityLabel = cityMatch ? cityMatch[1] : '';

    let triggerType: WorkflowTriggerType = 'lead.created';
    if (/overdue|udhaar|due date|payment pending|unpaid invoice/i.test(lower)) {
      triggerType = 'invoice.overdue';
    } else if (
      /stays in|stale|no reply for|uncontacted for|inactive for|sit in/i.test(
        lower,
      ) &&
      !/when.*arrives|new.*lead/i.test(lower)
    ) {
      triggerType = 'lead.stale_followup';
    } else if (/hot|score.*80|high intent|ai score/i.test(lower)) {
      triggerType = 'lead.hot_scored';
    } else if (/deal.*stage|kanban|moved to|closed won/i.test(lower)) {
      triggerType = 'deal.stage_changed';
    } else if (
      /inbound.*whatsapp|buyer replies|incoming whatsapp/i.test(lower)
    ) {
      triggerType = 'whatsapp.inbound';
    }

    const staleStage = /proposal|quote/i.test(lower)
      ? 'proposal'
      : /qualified/i.test(lower)
        ? 'qualified'
        : /contacted/i.test(lower)
          ? 'contacted'
          : 'new';

    let actionType: WorkflowActionType = 'send_whatsapp_create_task';
    if (
      triggerType === 'invoice.overdue' ||
      /payment reminder|udhaar|razorpay reminder/i.test(lower)
    ) {
      actionType = 'send_payment_reminder';
    } else if (/generate.*invoice|tax invoice|18% gst invoice/i.test(lower)) {
      actionType = 'generate_gst_invoice';
    } else if (/senior closer|assign.*closer|escalate/i.test(lower)) {
      actionType = 'assign_senior_closer';
    }

    const sourceLabel =
      sourceFilter === 'indiamart'
        ? 'IndiaMART'
        : sourceFilter === 'justdial'
          ? 'Justdial'
          : sourceFilter === 'meta_ads'
            ? 'Meta Lead Ads'
            : sourceFilter === 'website'
              ? 'Website'
              : 'All Channels';

    const conditionParts: string[] = [];
    if (sourceFilter !== 'all') {
      conditionParts.push(`Lead Source = ${sourceLabel}`);
    } else {
      conditionParts.push('Lead Source IN [IndiaMART, WhatsApp, Meta Ads]');
    }
    if (cityLabel) {
      conditionParts.push(`City = ${cityLabel}`);
    }
    if (triggerType === 'lead.hot_scored') {
      conditionParts.push('SetuAI Score >= 80 (Hot)');
    }
    if (triggerType === 'lead.stale_followup') {
      conditionParts.push(
        `Stage = ${staleStage.toUpperCase()} for >= ${staleHours}h`,
      );
    }
    const conditionSummary = conditionParts.join(' AND ');

    const nudgeClause =
      hourMatch || dayMatch || /nudge|follow[- ]?up/i.test(lower)
        ? ` + Schedule ${staleHours}h Follow-Up Nudge Task`
        : ' + Create 15-Min Call Reminder Task';

    const actionSummary =
      actionType === 'send_payment_reminder'
        ? 'Send Hinglish WhatsApp Payment Reminder with Razorpay Link + Notify Accounts Team'
        : actionType === 'generate_gst_invoice'
          ? 'Auto-Generate 18% GST Tax Invoice Draft + Share Razorpay Link on WhatsApp'
          : actionType === 'assign_senior_closer'
            ? `Assign to Senior Closer + High-Priority Alert${nudgeClause}`
            : `Send GST Brochure & Catalogue on WhatsApp${nudgeClause}`;

    const whatsappTemplateBody =
      actionType === 'send_payment_reminder'
        ? 'Namaste {{buyer_name}} ji 🙏, gentle reminder regarding your pending GST invoice for {{company}} ({{deal_value}}). You can complete payment directly via the Razorpay link shared. Reply if you need assistance!'
        : triggerType === 'lead.stale_followup'
          ? `Namaste {{buyer_name}} ji 👋, checking in on your requirement for {{company}}${cityLabel ? ` (${cityLabel})` : ''} ({{deal_value}}). Let us know if you need our GST proforma quotation or priority dispatch!`
          : `Namaste {{buyer_name}} ji 👋, thank you for your ${sourceFilter !== 'all' ? `${sourceLabel} ` : ''}inquiry for {{company}} ({{city}}). Sharing our GST brochure, product catalogue & quotation details right away!`;

    const name =
      triggerType === 'invoice.overdue'
        ? 'Overdue GST Invoice -> WhatsApp Razorpay Payment Nudge'
        : triggerType === 'lead.stale_followup'
          ? `${staleHours}h Stale ${staleStage.toUpperCase()} Lead -> Auto WhatsApp Follow-Up`
          : `${sourceFilter !== 'all' ? sourceLabel : 'New'}${cityLabel ? ` ${cityLabel}` : ''} Lead -> Instant WhatsApp GST Brochure & ${staleHours}h Nudge`;

    return {
      name,
      description: `AI-generated rule from: "${goal.slice(0, 140)}"`,
      triggerType,
      sourceFilter,
      staleStage,
      staleHours,
      conditionSummary,
      actionType,
      actionSummary,
      whatsappTemplateBody,
    };
  }

  async draftWithAi(
    auth: { userId: string; tenantId: string; email: string },
    body: { prompt?: string; language?: string },
  ) {
    const prompt = String(body?.prompt || '').trim();
    if (!prompt) {
      throw new BadRequestException(
        'Please describe the automation rule you want SetuAI to build.',
      );
    }

    await this.superAdminService?.consumeTenantQuota(auth.tenantId, 'ai', 1);

    const fallback = this.buildLocalWorkflowDraft(prompt);
    const aiRes = this.aiBridge
      ? await this.aiBridge
          .draftWorkflowRule(
            {
              tenantId: auth.tenantId,
              userId: auth.userId,
              userRole: 'owner',
              context: {
                prompt,
                goal: prompt,
                language: body?.language || 'hinglish',
              },
            },
            { skipMetering: true, timeoutMs: 7500 },
          )
          .catch(() => null)
      : null;

    const validTriggers = new Set<WorkflowTriggerType>([
      'lead.created',
      'lead.hot_scored',
      'lead.stale_followup',
      'deal.stage_changed',
      'invoice.overdue',
      'whatsapp.inbound',
    ]);
    const validActions = new Set<WorkflowActionType>([
      'send_whatsapp_create_task',
      'assign_senior_closer',
      'generate_gst_invoice',
      'send_payment_reminder',
    ]);
    const validSources = new Set([
      'all',
      'indiamart',
      'website',
      'meta_ads',
      'whatsapp',
      'justdial',
    ]);
    const validStaleStages = new Set([
      'new',
      'proposal',
      'contacted',
      'qualified',
      'any',
    ]);

    const s = aiRes?.structured;
    const triggerType =
      s?.triggerType && validTriggers.has(s.triggerType as WorkflowTriggerType)
        ? (s.triggerType as WorkflowTriggerType)
        : fallback.triggerType;
    const actionType =
      s?.actionType && validActions.has(s.actionType as WorkflowActionType)
        ? (s.actionType as WorkflowActionType)
        : fallback.actionType;
    const sourceFilter =
      s?.sourceFilter && validSources.has(s.sourceFilter)
        ? s.sourceFilter
        : fallback.sourceFilter;
    const staleStage =
      s?.staleStage && validStaleStages.has(s.staleStage)
        ? s.staleStage
        : fallback.staleStage;
    const staleHours =
      typeof s?.staleHours === 'number' && s.staleHours >= 0
        ? Math.min(720, Math.round(s.staleHours))
        : fallback.staleHours;

    return {
      prompt,
      name: s?.name?.trim() || fallback.name,
      description: s?.description?.trim() || fallback.description,
      triggerType,
      sourceFilter,
      staleStage,
      staleHours,
      conditionSummary:
        s?.conditionSummary?.trim() ||
        (Array.isArray(s?.conditions) && s.conditions.length > 0
          ? s.conditions.join(' AND ')
          : fallback.conditionSummary),
      actionType,
      actionSummary:
        s?.actionSummary?.trim() ||
        (Array.isArray(s?.actions) && s.actions.length > 0
          ? s.actions.join(' + ')
          : fallback.actionSummary),
      whatsappTemplateBody:
        s?.whatsappTemplateBody?.trim() || fallback.whatsappTemplateBody,
      provider: aiRes?.provider || 'fallback',
      model: aiRes?.model || 'leadsetu-heuristic-v1',
    };
  }
}
