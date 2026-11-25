import {
  BadRequestException,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
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
  WorkflowStepNodeDto,
  WorkflowTriggerType,
} from './dto/workflows.dto';
import { SuperAdminService } from '../super-admin/super-admin.service';
import { resolveOwnerScopeFilter } from '../auth/identity.util';
import { InboxService } from '../inbox/inbox.service';
import { Lead, LeadDocument } from '../leads/schemas/lead.schema';
import { AiBridgeService } from '../ai-bridge/ai-bridge.service';
import {
  WorkflowEnrollment,
  WorkflowEnrollmentDocument,
} from './schemas/workflow-enrollment.schema';

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

  @Prop({ type: Number, default: 10 })
  staleMinutes?: number;

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
      'reassign_rep_sla_alert',
      'multi_step_whatsapp_drip',
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

  @Prop({ type: Array, default: [] })
  nodes?: WorkflowStepNodeDto[];

  @Prop({ type: Boolean, default: true })
  stopOnReply?: boolean;
}

export const WorkflowSchema = SchemaFactory.createForClass(Workflow);

@Injectable()
export class WorkflowsService implements OnModuleInit, OnModuleDestroy {
  private dripSweepTimer: NodeJS.Timeout | null = null;

  constructor(
    @InjectModel(Workflow.name)
    private readonly workflowModel: Model<WorkflowDocument>,
    @InjectModel(WorkflowEnrollment.name)
    private readonly enrollmentModel: Model<WorkflowEnrollmentDocument>,
    @InjectModel(Lead.name)
    private readonly leadModel: Model<LeadDocument>,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly inboxService: InboxService,
    @Optional() private readonly superAdminService?: SuperAdminService,
    @Optional() private readonly aiBridge?: AiBridgeService,
  ) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test') return;
    this.dripSweepTimer = setInterval(() => {
      void this.processDueEnrollments().catch(() => {});
    }, 60_000);
    if (this.dripSweepTimer.unref) {
      this.dripSweepTimer.unref();
    }
  }

  onModuleDestroy() {
    if (this.dripSweepTimer) {
      clearInterval(this.dripSweepTimer);
      this.dripSweepTimer = null;
    }
  }

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

  private synthesizeDefaultNodes(params: {
    triggerType: WorkflowTriggerType;
    sourceFilter?: string;
    staleStage?: string;
    staleHours?: number;
    staleMinutes?: number;
    conditionSummary: string;
    actionType: WorkflowActionType;
    actionSummary: string;
    whatsappTemplateBody?: string;
  }): WorkflowStepNodeDto[] {
    const src = params.sourceFilter && params.sourceFilter !== 'all'
      ? params.sourceFilter
      : 'indiamart,meta_ads,website';

    const triggerTitleMap: Record<WorkflowTriggerType, string> = {
      'lead.created': 'New Lead Arrives (IndiaMART / Meta / Webhook)',
      'lead.hot_scored': 'SetuAI Scores Lead >= 80 (Hot Buyer)',
      'lead.stale_followup': `Lead Stays in ${(params.staleStage || 'new').toUpperCase()}`,
      'deal.stage_changed': 'Deal Stage Changed in Pipeline',
      'invoice.overdue': 'GST Invoice Passes Due Date',
      'whatsapp.inbound': 'Buyer Sends Inbound WhatsApp',
    };

    const nodes: WorkflowStepNodeDto[] = [
      {
        id: 'node-trigger-1',
        kind: 'trigger',
        title: triggerTitleMap[params.triggerType] || 'CRM Event Trigger',
        subtitle: params.sourceFilter && params.sourceFilter !== 'all'
          ? `Filtered to source: ${params.sourceFilter.toUpperCase()}`
          : 'Listening across all acquisition channels',
      },
    ];

    if (params.triggerType === 'lead.stale_followup') {
      nodes.push({
        id: 'node-delay-1',
        kind: 'delay',
        title: `Wait ${params.staleHours ?? 24} Hours`,
        subtitle: `Wait before checking if lead moved out of ${params.staleStage || 'new'}`,
        delayValue: params.staleHours ?? 24,
        delayUnit: 'hours',
      });
    } else if (
      params.actionType === 'reassign_rep_sla_alert' ||
      params.actionType === 'multi_step_whatsapp_drip'
    ) {
      nodes.push({
        id: 'node-delay-1',
        kind: 'delay',
        title: `Wait ${params.staleMinutes ?? 10} Minutes`,
        subtitle: 'Speed-to-Lead SLA wait window',
        delayValue: params.staleMinutes ?? 10,
        delayUnit: 'minutes',
      });
    }

    nodes.push({
      id: 'node-cond-1',
      kind: 'condition',
      title:
        params.actionType === 'reassign_rep_sla_alert'
          ? 'If Lead Still Uncontacted'
          : params.conditionSummary || 'Check Lead Qualification',
      subtitle: params.conditionSummary,
      conditionGuard:
        params.actionType === 'reassign_rep_sla_alert'
          ? 'if_uncontacted'
          : params.sourceFilter && params.sourceFilter !== 'all'
            ? 'if_source_matches'
            : 'always',
      conditionValue: src,
    });

    if (params.actionType === 'reassign_rep_sla_alert') {
      nodes.push(
        {
          id: 'node-act-wa',
          kind: 'action',
          title: 'Send Hinglish WhatsApp Follow-Up',
          subtitle: 'Auto-greets buyer with GST brochure & price list',
          actionKind: 'send_whatsapp',
          language: 'hinglish',
          whatsappTemplateBody:
            params.whatsappTemplateBody ||
            'Namaste {{buyer_name}} ji 👋, humne aapki {{company}} inquiry receive ki hai! Humare senior specialist aapko turant call karenge. Tab tak catalogue & GST details share kar rahe hain.',
        },
        {
          id: 'node-act-reassign',
          kind: 'action',
          title: 'Reassign to Backup Rep',
          subtitle: 'Rotates uncontacted lead to next available rep',
          actionKind: 'reassign_rep',
          reassignStrategy: 'round_robin_backup',
        },
        {
          id: 'node-act-sla',
          kind: 'action',
          title: 'Create Urgent SLA Alert & Task',
          subtitle: 'Logs SLA breach ticket + high-priority callback task',
          actionKind: 'create_sla_alert',
          slaPriority: 'urgent',
          taskOrAlertTitle:
            'SLA Breach: Lead uncontacted after 10 mins — reassigned to backup rep',
        },
      );
    } else if (params.actionType === 'multi_step_whatsapp_drip') {
      nodes.push(
        {
          id: 'node-act-wa-1',
          kind: 'action',
          title: 'Day 0: Hinglish WhatsApp Intro',
          subtitle: 'Instant brochure + MOQ reply',
          actionKind: 'send_whatsapp',
          language: 'hinglish',
          whatsappTemplateBody:
            params.whatsappTemplateBody ||
            'Namaste {{buyer_name}} ji 👋, {{company}} ke liye quotation & brochure share kar rahe hain. Batayein aapko kitni quantity chahiye?',
        },
        {
          id: 'node-delay-2',
          kind: 'delay',
          title: 'Wait 24 Hours',
          subtitle: 'Pause before Day 1 nudge (stops if buyer replies)',
          delayValue: 24,
          delayUnit: 'hours',
        },
        {
          id: 'node-cond-2',
          kind: 'condition',
          title: 'If No WhatsApp Reply Yet',
          subtitle: 'Skip nudge if buyer already responded',
          conditionGuard: 'if_no_whatsapp_reply',
        },
        {
          id: 'node-act-wa-2',
          kind: 'action',
          title: 'Day 1: Hinglish Quotation Nudge',
          subtitle: 'Polite follow-up + call booking prompt',
          actionKind: 'send_whatsapp',
          language: 'hinglish',
          whatsappTemplateBody:
            'Namaste {{buyer_name}} ji 🙏, kal wali inquiry par check kar rahe the. Kya hum aaj 5-minute call par best factory rate & GST invoice share karein?',
        },
      );
    } else if (params.actionType === 'send_payment_reminder') {
      nodes.push({
        id: 'node-act-pay',
        kind: 'action',
        title: 'Send WhatsApp Razorpay Reminder',
        subtitle: params.actionSummary,
        actionKind: 'send_payment_reminder',
        language: 'hinglish',
        whatsappTemplateBody: params.whatsappTemplateBody || '',
      });
    } else if (params.actionType === 'generate_gst_invoice') {
      nodes.push({
        id: 'node-act-inv',
        kind: 'action',
        title: 'Auto-Generate 18% GST Invoice Draft',
        subtitle: params.actionSummary,
        actionKind: 'generate_gst_invoice',
      });
    } else if (params.actionType === 'assign_senior_closer') {
      nodes.push(
        {
          id: 'node-act-senior',
          kind: 'action',
          title: 'Assign to Senior Closer',
          subtitle: params.actionSummary,
          actionKind: 'reassign_rep',
          reassignStrategy: 'senior_closer',
        },
        {
          id: 'node-act-task',
          kind: 'action',
          title: 'Create High-Priority Call Task',
          subtitle: 'Immediate callback reminder for senior closer',
          actionKind: 'create_task',
          taskOrAlertTitle: params.actionSummary,
        },
      );
    } else {
      nodes.push(
        {
          id: 'node-act-wa',
          kind: 'action',
          title: 'Send WhatsApp Welcome Message',
          subtitle: params.actionSummary,
          actionKind: 'send_whatsapp',
          language: 'hinglish',
          whatsappTemplateBody: params.whatsappTemplateBody || '',
        },
        {
          id: 'node-act-task',
          kind: 'action',
          title: 'Create 15-Min Follow-Up Task',
          subtitle: 'Schedules rep callback in /tasks',
          actionKind: 'create_task',
          taskOrAlertTitle: params.actionSummary,
        },
      );
    }

    return nodes;
  }

  private toDto(doc: WorkflowDocument, activeEnrollmentsCount = 0) {
    const raw = doc.toObject() as unknown as Record<string, unknown> & {
      createdAt?: Date;
      updatedAt?: Date;
    };
    const storedNodes = Array.isArray(doc.nodes) && doc.nodes.length > 0
      ? doc.nodes
      : this.synthesizeDefaultNodes({
          triggerType: doc.triggerType || 'lead.created',
          sourceFilter: doc.sourceFilter || 'all',
          staleStage: doc.staleStage || 'new',
          staleHours: doc.staleHours ?? 24,
          staleMinutes: doc.staleMinutes ?? 10,
          conditionSummary: doc.conditionSummary,
          actionType: doc.actionType || 'send_whatsapp_create_task',
          actionSummary: doc.actionSummary,
          whatsappTemplateBody: doc.whatsappTemplateBody || '',
        });

    return {
      id: doc._id.toString(),
      tenantId: doc.tenantId.toString(),
      name: doc.name,
      description: doc.description || '',
      triggerType: doc.triggerType || 'lead.created',
      sourceFilter: doc.sourceFilter || 'all',
      staleStage: doc.staleStage || 'new',
      staleHours: doc.staleHours ?? 24,
      staleMinutes: doc.staleMinutes ?? 10,
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
      nodes: storedNodes,
      stopOnReply: doc.stopOnReply ?? true,
      activeEnrollmentsCount,
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

    const [docs, all, enrollmentAgg] = await Promise.all([
      this.workflowModel.find(filter).sort({ createdAt: -1 }).exec(),
      this.workflowModel.find(baseScope).exec(),
      this.enrollmentModel
        .aggregate<{ _id: Types.ObjectId; count: number }>([
          { $match: { tenantId: tenantObjectId, status: 'active' } },
          { $group: { _id: '$workflowId', count: { $sum: 1 } } },
        ])
        .exec()
        .catch(() => []),
    ]);

    const enrollCountMap = new Map<string, number>();
    let totalActiveEnrollments = 0;
    for (const row of enrollmentAgg) {
      enrollCountMap.set(String(row._id), row.count);
      totalActiveEnrollments += row.count;
    }

    const activeCount = all.filter((w) => w.active).length;
    const totalRuns = all.reduce((s, w) => s + (w.runsCount || 0), 0);
    const totalHoursSaved = all.reduce((s, w) => s + (w.hoursSaved || 0), 0);

    return {
      data: docs.map((d) =>
        this.toDto(d, enrollCountMap.get(d._id.toString()) || 0),
      ),
      stats: {
        totalWorkflows: all.length,
        activeWorkflows: activeCount,
        pausedWorkflows: all.length - activeCount,
        totalRuns,
        totalHoursSaved,
        activeEnrollments: totalActiveEnrollments,
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

    const triggerType = dto.triggerType || 'lead.created';
    const actionType = dto.actionType || 'send_whatsapp_create_task';
    const conditionSummary =
      dto.conditionSummary?.trim() || 'When trigger condition is met';
    const actionSummary =
      dto.actionSummary?.trim() ||
      'Send WhatsApp template & create follow-up task';

    const nodes =
      Array.isArray(dto.nodes) && dto.nodes.length > 0
        ? dto.nodes
        : this.synthesizeDefaultNodes({
            triggerType,
            sourceFilter: dto.sourceFilter,
            staleStage: dto.staleStage,
            staleHours: dto.staleHours,
            staleMinutes: dto.staleMinutes,
            conditionSummary,
            actionType,
            actionSummary,
            whatsappTemplateBody: dto.whatsappTemplateBody,
          });

    const doc = await this.workflowModel.create({
      tenantId: new Types.ObjectId(auth.tenantId),
      ownerId: new Types.ObjectId(auth.userId),
      name: dto.name.trim(),
      description: dto.description?.trim() || '',
      triggerType,
      sourceFilter: dto.sourceFilter?.trim() || 'all',
      staleStage: dto.staleStage?.trim() || 'new',
      staleHours:
        dto.staleHours !== undefined
          ? Math.max(0, Number(dto.staleHours))
          : 24,
      staleMinutes:
        dto.staleMinutes !== undefined
          ? Math.max(1, Number(dto.staleMinutes))
          : 10,
      whatsappTemplateBody: dto.whatsappTemplateBody?.trim() || '',
      conditionSummary,
      actionType,
      actionSummary,
      active: dto.active ?? true,
      runsCount: runs,
      hoursSaved,
      lastRunAt: nowIso,
      nodes,
      stopOnReply: dto.stopOnReply ?? true,
      executionLogs: [
        {
          id: `log-${Date.now()}`,
          summary: `Visual workflow initialized (${nodes.length} nodes · ${actionSummary})`,
          status: 'success',
          executedAt: nowIso,
        },
      ],
    });

    return this.toDto(doc, 0);
  }

  async updateWorkflow(
    auth: { userId: string; tenantId: string },
    id: string,
    dto: Partial<CreateWorkflowDto>,
  ) {
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

    if (dto.name !== undefined && dto.name.trim()) doc.name = dto.name.trim();
    if (dto.description !== undefined) doc.description = dto.description.trim();
    if (dto.triggerType) doc.triggerType = dto.triggerType;
    if (dto.sourceFilter !== undefined) doc.sourceFilter = dto.sourceFilter.trim();
    if (dto.staleStage !== undefined) doc.staleStage = dto.staleStage.trim();
    if (dto.staleHours !== undefined) doc.staleHours = Math.max(0, Number(dto.staleHours));
    if (dto.staleMinutes !== undefined) doc.staleMinutes = Math.max(1, Number(dto.staleMinutes));
    if (dto.whatsappTemplateBody !== undefined) {
      doc.whatsappTemplateBody = dto.whatsappTemplateBody.trim();
    }
    if (dto.conditionSummary !== undefined) {
      doc.conditionSummary = dto.conditionSummary.trim();
    }
    if (dto.actionType) doc.actionType = dto.actionType;
    if (dto.actionSummary !== undefined) doc.actionSummary = dto.actionSummary.trim();
    if (dto.active !== undefined) doc.active = Boolean(dto.active);
    if (dto.stopOnReply !== undefined) doc.stopOnReply = Boolean(dto.stopOnReply);
    if (Array.isArray(dto.nodes) && dto.nodes.length > 0) {
      doc.nodes = dto.nodes;
      doc.markModified('nodes');
    }

    await doc.save();
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
    priority?: 'high' | 'medium' | 'low';
  }) {
    try {
      const tasksCol = this.workflowModel.db.collection('tasks');
      await tasksCol.insertOne({
        tenantId: params.tenantObjectId,
        ownerId: params.ownerId,
        title: `[Auto-Workflow] ${params.workflowName}: ${params.leadName}`,
        description: `Automatically triggered (${params.triggerType}): ${params.actionSummary}`,
        priority: params.priority || 'high',
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

  private async createWorkflowSlaTicket(params: {
    tenantObjectId: Types.ObjectId;
    ownerId: Types.ObjectId;
    workflowName: string;
    title: string;
    priority: 'high' | 'urgent';
    lead: LeadDocument;
    assignedRepName: string;
  }) {
    try {
      const ticketsCol = this.workflowModel.db.collection('tickets');
      const ticketNumber = `SLA-${Date.now().toString().slice(-6)}`;
      await ticketsCol.insertOne({
        tenantId: params.tenantObjectId,
        ownerId: params.ownerId,
        ticketNumber,
        subject: `${params.title} — ${params.lead.name}`,
        category: 'general',
        priority: params.priority,
        status: 'open',
        customerName: params.lead.name,
        company: params.lead.company || '',
        phone: params.lead.phone || '',
        email: params.lead.email || '',
        siteAddress: params.lead.city || '',
        assignedToName: params.assignedRepName,
        slaDueAt: new Date(Date.now() + 30 * 60_000).toISOString(),
        notes: `Raised automatically by Visual Workflow "${params.workflowName}"`,
        comments: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      return ticketNumber;
    } catch {
      return '';
    }
  }

  private async reassignLeadToBackupRep(params: {
    tenantObjectId: Types.ObjectId;
    lead: LeadDocument;
    strategy: 'round_robin_backup' | 'senior_closer' | 'territory_owner';
    workflowName: string;
  }): Promise<{ newOwnerId: Types.ObjectId; newOwnerName: string }> {
    const usersCol = this.workflowModel.db.collection('users');
    const currentOwnerStr = String(params.lead.ownerId || '');
    const users = await usersCol
      .find({ tenantId: params.tenantObjectId, isActive: { $ne: false } })
      .sort({ _id: 1 })
      .toArray();

    const availableBackups = users.filter(
      (u) =>
        String(u._id) !== currentOwnerStr &&
        u.availabilityStatus !== 'away' &&
        u.availabilityStatus !== 'on_leave',
    );
    const anyBackups = users.filter((u) => String(u._id) !== currentOwnerStr);
    const searchPool = availableBackups.length > 0 ? availableBackups : anyBackups;

    let candidate = searchPool[0] || users[0];

    if (params.strategy === 'senior_closer') {
      const senior = searchPool.find(
        (u) =>
          u.role === 'admin' || u.role === 'owner' || u.role === 'manager',
      );
      if (senior) candidate = senior;
    }

    const newOwnerId = candidate
      ? new Types.ObjectId(String(candidate._id))
      : params.lead.ownerId;
    const newOwnerName = candidate?.name
      ? String(candidate.name)
      : 'Backup Sales Specialist';

    params.lead.ownerId = newOwnerId;
    params.lead.activities = Array.isArray(params.lead.activities)
      ? params.lead.activities
      : [];
    params.lead.activities.unshift({
      id: `act-wf-reassign-${Date.now()}`,
      type: 'status_change',
      description: `Lead auto-reassigned to ${newOwnerName} by workflow "${params.workflowName}"`,
      authorName: 'Workflow Engine',
      createdAt: new Date().toISOString(),
    });
    params.lead.markModified('activities');
    await params.lead.save();

    return { newOwnerId, newOwnerName };
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

  private computeDelayMs(node: WorkflowStepNodeDto): number {
    const val = Math.max(0, Number(node.delayValue ?? 10));
    if (node.delayUnit === 'days') return val * 86_400_000;
    if (node.delayUnit === 'hours') return val * 3_600_000;
    return val * 60_000;
  }

  private async hasBuyerRepliedSince(
    tenantObjectId: Types.ObjectId,
    leadId: string,
    sinceDate: Date,
  ): Promise<boolean> {
    try {
      const conv = await this.workflowModel.db
        .collection('conversations')
        .findOne({
          tenantId: tenantObjectId,
          linkedEntityType: 'lead',
          linkedEntityId: leadId,
        });
      if (!conv) return false;
      const msgs = Array.isArray(conv.messages) ? conv.messages : [];
      return msgs.some(
        (m: { direction?: string; createdAt?: string }) =>
          m.direction === 'inbound' &&
          m.createdAt &&
          new Date(m.createdAt).getTime() >= sinceDate.getTime(),
      );
    } catch {
      return false;
    }
  }

  private async evaluateConditionNode(
    node: WorkflowStepNodeDto,
    lead: LeadDocument,
    tenantObjectId: Types.ObjectId,
    enrolledAt: Date,
  ): Promise<{ passed: boolean; reason: string }> {
    const guard = node.conditionGuard || 'always';
    if (guard === 'always') {
      return { passed: true, reason: 'Condition passed (always)' };
    }
    if (guard === 'if_uncontacted') {
      const isUncontacted = lead.status === 'new';
      return {
        passed: isUncontacted,
        reason: isUncontacted
          ? 'Lead is still uncontacted (status = new)'
          : `Skipped — Lead already moved to "${lead.status}"`,
      };
    }
    if (guard === 'if_no_whatsapp_reply') {
      const replied = await this.hasBuyerRepliedSince(
        tenantObjectId,
        lead._id.toString(),
        enrolledAt,
      );
      return {
        passed: !replied,
        reason: replied
          ? 'Stopped — Buyer already replied on WhatsApp'
          : 'No inbound WhatsApp reply yet — continuing drip',
      };
    }
    if (guard === 'if_ai_score_gte') {
      const threshold = Number(node.conditionValue || 75);
      const passed = (lead.aiScore || 0) >= threshold;
      return {
        passed,
        reason: passed
          ? `SetuAI score ${lead.aiScore || 0} >= ${threshold}`
          : `SetuAI score ${lead.aiScore || 0} < ${threshold}`,
      };
    }
    if (guard === 'if_deal_value_gte') {
      const threshold = Number(node.conditionValue || 50000);
      const passed = (lead.estimatedValue || 0) >= threshold;
      return {
        passed,
        reason: passed
          ? `Est. value ₹${lead.estimatedValue || 0} >= ₹${threshold}`
          : `Est. value ₹${lead.estimatedValue || 0} < ₹${threshold}`,
      };
    }
    if (guard === 'if_source_matches') {
      const allowed = String(node.conditionValue || '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      const passed =
        allowed.length === 0 || allowed.includes((lead.source || '').toLowerCase());
      return {
        passed,
        reason: passed
          ? `Source "${lead.source}" matches [${allowed.join(', ')}]`
          : `Source "${lead.source}" does not match [${allowed.join(', ')}]`,
      };
    }
    if (guard === 'if_city_matches') {
      const target = String(node.conditionValue || '').trim().toLowerCase();
      const passed =
        !target || (lead.city || '').toLowerCase().includes(target);
      return {
        passed,
        reason: passed
          ? `City "${lead.city}" matches "${target}"`
          : `City "${lead.city}" does not match "${target}"`,
      };
    }
    return { passed: true, reason: 'Condition passed' };
  }

  private async executeActionNode(params: {
    node: WorkflowStepNodeDto;
    wf: WorkflowDocument;
    lead: LeadDocument;
    tenantObjectId: Types.ObjectId;
    actorUserId: string;
    actorName: string;
  }): Promise<{ status: 'success' | 'skipped'; detail: string }> {
    const { node, wf, lead, tenantObjectId, actorUserId, actorName } = params;
    const actionKind = node.actionKind || 'send_whatsapp';

    if (actionKind === 'send_whatsapp' || actionKind === 'send_payment_reminder') {
      if (!lead.phone?.trim()) {
        return {
          status: 'skipped',
          detail: `Skipped WhatsApp for "${lead.name}" (missing phone number)`,
        };
      }
      const messageBody =
        node.whatsappTemplateBody?.trim() || this.buildWelcomeMessage(wf, lead);
      const dispatch = await this.inboxService.dispatchAutomatedWhatsApp({
        tenantId: tenantObjectId.toString(),
        userId: actorUserId,
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
        timelineMarker: `[Workflow:${wf._id.toString()}:${node.id}]`,
      });
      if (dispatch.skippedDnd) {
        return {
          status: 'skipped',
          detail: `Skipped WhatsApp (${lead.phone}) — Buyer opted out (DND)`,
        };
      }
      return {
        status: 'success',
        detail: `Sent ${node.language === 'hinglish' ? 'Hinglish ' : ''}WhatsApp (${
          dispatch.deliveryProvider === 'meta_cloud' ? 'Meta Cloud' : 'CRM Inbox'
        }) to ${lead.name} (${lead.phone})`,
      };
    }

    if (actionKind === 'reassign_rep') {
      const reassigned = await this.reassignLeadToBackupRep({
        tenantObjectId,
        lead,
        strategy: node.reassignStrategy || 'round_robin_backup',
        workflowName: wf.name,
      });
      return {
        status: 'success',
        detail: `Reassigned "${lead.name}" to backup rep ${reassigned.newOwnerName}`,
      };
    }

    if (actionKind === 'create_sla_alert') {
      const ticketNo = await this.createWorkflowSlaTicket({
        tenantObjectId,
        ownerId: Types.ObjectId.isValid(actorUserId)
          ? new Types.ObjectId(actorUserId)
          : lead.ownerId,
        workflowName: wf.name,
        title: node.taskOrAlertTitle || node.title,
        priority: node.slaPriority || 'urgent',
        lead,
        assignedRepName: actorName,
      });
      await this.createWorkflowFollowUpTask({
        tenantObjectId,
        ownerId: lead.ownerId,
        workflowName: wf.name,
        triggerType: wf.triggerType,
        actionSummary: node.taskOrAlertTitle || node.title,
        leadName: lead.name,
        leadCompany: lead.company,
        leadPhone: lead.phone,
        priority: 'high',
      });
      return {
        status: 'success',
        detail: `Created ${node.slaPriority || 'urgent'} SLA Alert ${
          ticketNo ? `(${ticketNo}) ` : ''
        }& Callback Task for "${lead.name}"`,
      };
    }

    await this.createWorkflowFollowUpTask({
      tenantObjectId,
      ownerId: Types.ObjectId.isValid(actorUserId)
        ? new Types.ObjectId(actorUserId)
        : lead.ownerId,
      workflowName: wf.name,
      triggerType: wf.triggerType,
      actionSummary: node.taskOrAlertTitle || wf.actionSummary,
      leadName: lead.name,
      leadCompany: lead.company,
      leadPhone: lead.phone,
    });
    return {
      status: 'success',
      detail: `Created CRM Task "${node.taskOrAlertTitle || node.title}" for "${lead.name}"`,
    };
  }

  /**
   * Advances a single WorkflowEnrollment across nodes until it completes,
   * stops on condition/reply, or hits a `delay` node.
   */
  async advanceEnrollment(
    enrollment: WorkflowEnrollmentDocument,
    wf: WorkflowDocument,
    options?: {
      forceSkipDelays?: boolean;
      actorUserId?: string;
      actorName?: string;
    },
  ): Promise<WorkflowEnrollmentDocument> {
    const nodes =
      Array.isArray(wf.nodes) && wf.nodes.length > 0
        ? wf.nodes
        : this.synthesizeDefaultNodes({
            triggerType: wf.triggerType,
            sourceFilter: wf.sourceFilter,
            staleStage: wf.staleStage,
            staleHours: wf.staleHours,
            staleMinutes: wf.staleMinutes,
            conditionSummary: wf.conditionSummary,
            actionType: wf.actionType,
            actionSummary: wf.actionSummary,
            whatsappTemplateBody: wf.whatsappTemplateBody,
          });

    const lead = await this.leadModel.findById(enrollment.leadId).exec();
    if (!lead) {
      enrollment.status = 'skipped';
      enrollment.stopReason = 'Lead record deleted';
      await enrollment.save();
      return enrollment;
    }

    const actorUserId = options?.actorUserId || String(wf.ownerId);
    const actorName = options?.actorName || 'SetuFlow Drip Engine';
    const enrolledAt =
      (enrollment as unknown as { createdAt?: Date }).createdAt || new Date();

    if (enrollment.stopOnReply) {
      const replied = await this.hasBuyerRepliedSince(
        enrollment.tenantId,
        lead._id.toString(),
        enrolledAt,
      );
      if (replied) {
        enrollment.status = 'stopped_on_reply';
        enrollment.stopReason = 'Buyer replied on WhatsApp — drip paused automatically';
        enrollment.stepLogs.push({
          nodeId: 'reply-guard',
          kind: 'condition',
          title: 'WhatsApp Reply Guard',
          status: 'stopped',
          detail: enrollment.stopReason,
          executedAt: new Date().toISOString(),
        });
        enrollment.markModified('stepLogs');
        await enrollment.save();
        return enrollment;
      }
    }

    let idx = enrollment.currentStepIndex || 0;
    let ranActionCount = 0;

    while (idx < nodes.length) {
      const node = nodes[idx];
      const nowIso = new Date().toISOString();

      if (node.kind === 'trigger') {
        enrollment.stepLogs.push({
          nodeId: node.id,
          kind: 'trigger',
          title: node.title,
          status: 'success',
          detail: `Triggered for "${lead.name}" (${lead.source || 'website'})`,
          executedAt: nowIso,
        });
        idx += 1;
        continue;
      }

      if (node.kind === 'delay') {
        const delayMs = this.computeDelayMs(node);
        const alreadyScheduledHere = enrollment.stepLogs.some(
          (l) => l.nodeId === node.id && l.status === 'scheduled',
        );
        if (!options?.forceSkipDelays && delayMs > 0 && !alreadyScheduledHere) {
          enrollment.currentStepIndex = idx;
          enrollment.nextRunAt = new Date(Date.now() + delayMs);
          enrollment.status = 'active';
          enrollment.stepLogs.push({
            nodeId: node.id,
            kind: 'delay',
            title: node.title,
            status: 'scheduled',
            detail: `Waiting ${node.delayValue ?? 10} ${node.delayUnit || 'minutes'} (next run: ${enrollment.nextRunAt.toISOString()})`,
            executedAt: nowIso,
          });
          enrollment.markModified('stepLogs');
          await enrollment.save();
          return enrollment;
        }
        enrollment.stepLogs.push({
          nodeId: node.id,
          kind: 'delay',
          title: node.title,
          status: 'success',
          detail: options?.forceSkipDelays
            ? `Fast-forwarded ${node.delayValue ?? 10} ${node.delayUnit || 'minutes'} delay`
            : `Delay window (${node.delayValue ?? 10} ${node.delayUnit || 'minutes'}) elapsed`,
          executedAt: nowIso,
        });
        idx += 1;
        continue;
      }

      if (node.kind === 'condition') {
        const cond = await this.evaluateConditionNode(
          node,
          lead,
          enrollment.tenantId,
          enrolledAt,
        );
        enrollment.stepLogs.push({
          nodeId: node.id,
          kind: 'condition',
          title: node.title,
          status: cond.passed ? 'success' : 'skipped',
          detail: cond.reason,
          executedAt: nowIso,
        });
        if (!cond.passed) {
          enrollment.status = 'skipped';
          enrollment.stopReason = cond.reason;
          enrollment.currentStepIndex = idx;
          enrollment.markModified('stepLogs');
          await enrollment.save();
          return enrollment;
        }
        idx += 1;
        continue;
      }

      if (node.kind === 'action') {
        const act = await this.executeActionNode({
          node,
          wf,
          lead,
          tenantObjectId: enrollment.tenantId,
          actorUserId,
          actorName,
        });
        enrollment.stepLogs.push({
          nodeId: node.id,
          kind: 'action',
          title: node.title,
          status: act.status,
          detail: act.detail,
          executedAt: nowIso,
        });
        ranActionCount += 1;

        wf.executionLogs.unshift({
          id: `log-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
          summary: act.detail,
          status: act.status,
          executedAt: nowIso,
        });
        idx += 1;
        continue;
      }

      idx += 1;
    }

    enrollment.currentStepIndex = nodes.length;
    enrollment.status = 'completed';
    enrollment.markModified('stepLogs');
    await enrollment.save();

    if (ranActionCount > 0) {
      wf.runsCount = (wf.runsCount || 0) + 1;
      wf.hoursSaved = Math.max(1, Math.round(wf.runsCount * 0.15));
      wf.lastRunAt = new Date().toISOString();
      if (wf.executionLogs.length > 10) {
        wf.executionLogs = wf.executionLogs.slice(0, 10);
      }
      wf.markModified('executionLogs');
      await wf.save();
    }

    return enrollment;
  }

  async processDueEnrollments(options?: {
    tenantId?: string;
    workflowId?: string;
    forceSkipDelays?: boolean;
  }) {
    const filter: Record<string, unknown> = { status: 'active' };
    if (options?.tenantId && Types.ObjectId.isValid(options.tenantId)) {
      filter.tenantId = new Types.ObjectId(options.tenantId);
    }
    if (options?.workflowId && Types.ObjectId.isValid(options.workflowId)) {
      filter.workflowId = new Types.ObjectId(options.workflowId);
    }
    if (!options?.forceSkipDelays) {
      filter.nextRunAt = { $lte: new Date() };
    }

    const due = await this.enrollmentModel
      .find(filter)
      .sort({ nextRunAt: 1 })
      .limit(50)
      .exec();

    let processed = 0;
    let completed = 0;
    let stoppedOnReply = 0;

    for (const enr of due) {
      const wf = await this.workflowModel.findById(enr.workflowId).exec();
      if (!wf || !wf.active) continue;
      const updated = await this.advanceEnrollment(enr, wf, {
        forceSkipDelays: Boolean(options?.forceSkipDelays),
      });
      processed += 1;
      if (updated.status === 'completed') completed += 1;
      if (updated.status === 'stopped_on_reply') stoppedOnReply += 1;
    }

    return { processed, completed, stoppedOnReply };
  }

  async listWorkflowEnrollments(
    auth: { userId: string; tenantId: string },
    workflowId: string,
  ) {
    if (!Types.ObjectId.isValid(workflowId)) {
      throw new NotFoundException('Workflow not found.');
    }
    const items = await this.enrollmentModel
      .find({
        tenantId: new Types.ObjectId(auth.tenantId),
        workflowId: new Types.ObjectId(workflowId),
      })
      .sort({ updatedAt: -1 })
      .limit(30)
      .lean()
      .exec();

    return {
      enrollments: items.map((item) => ({
        id: String(item._id),
        workflowId: String(item.workflowId),
        workflowName: item.workflowName,
        leadId: String(item.leadId),
        leadName: item.leadName,
        leadPhone: item.leadPhone,
        leadSource: item.leadSource,
        currentStepIndex: item.currentStepIndex,
        status: item.status,
        nextRunAt: item.nextRunAt ? new Date(item.nextRunAt).toISOString() : '',
        stopReason: item.stopReason || '',
        stepLogs: item.stepLogs || [],
      })),
    };
  }

  async simulateLeadThroughWorkflow(
    auth: { userId: string; tenantId: string; email?: string; name?: string },
    workflowId: string,
    body?: { forceSkipDelays?: boolean; leadId?: string },
  ) {
    if (!Types.ObjectId.isValid(workflowId)) {
      throw new NotFoundException('Workflow not found.');
    }
    const tenantObjectId = new Types.ObjectId(auth.tenantId);
    const wf = await this.workflowModel
      .findOne({ _id: new Types.ObjectId(workflowId), tenantId: tenantObjectId })
      .exec();
    if (!wf) throw new NotFoundException('Workflow not found.');

    let lead: LeadDocument | null = null;
    if (body?.leadId && Types.ObjectId.isValid(body.leadId)) {
      lead = await this.leadModel
        .findOne({ _id: new Types.ObjectId(body.leadId), tenantId: tenantObjectId })
        .exec();
    }
    if (!lead) {
      lead = await this.leadModel
        .findOne({ tenantId: tenantObjectId, phone: { $exists: true, $ne: '' } })
        .sort({ createdAt: -1 })
        .exec();
    }
    if (!lead) {
      lead = await this.leadModel.create({
        tenantId: tenantObjectId,
        ownerId: new Types.ObjectId(auth.userId),
        name: 'Vikramaditya Rao (Demo Lead)',
        company: 'Apex Precision Valves Pvt Ltd',
        phone: '+919811122233',
        normalizedPhone: '+919811122233',
        city: 'Noida',
        source: wf.sourceFilter && wf.sourceFilter !== 'all' ? wf.sourceFilter : 'indiamart',
        status: 'new',
        aiScore: 86,
        estimatedValue: 250000,
      });
    }

    const enrollment = await this.enrollmentModel.create({
      tenantId: tenantObjectId,
      workflowId: wf._id,
      workflowName: wf.name,
      leadId: lead._id,
      leadName: lead.name,
      leadPhone: lead.phone || '',
      leadSource: lead.source || 'website',
      currentStepIndex: 0,
      status: 'active',
      nextRunAt: new Date(),
      stopOnReply: wf.stopOnReply ?? true,
      stepLogs: [],
    });

    const updated = await this.advanceEnrollment(enrollment, wf, {
      forceSkipDelays: body?.forceSkipDelays ?? true,
      actorUserId: auth.userId,
      actorName: auth.name || auth.email?.split('@')[0] || 'Workflow Simulator',
    });

    return {
      workflow: this.toDto(wf),
      enrollment: {
        id: updated._id.toString(),
        leadId: lead._id.toString(),
        leadName: lead.name,
        status: updated.status,
        stepLogs: updated.stepLogs,
      },
    };
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

      // If workflow has visual nodes with a delay or multi-step sequence, enroll in drip runner
      const hasMultiStepNodes =
        Array.isArray(wf.nodes) &&
        wf.nodes.length > 0 &&
        (wf.nodes.some((n) => n.kind === 'delay') || wf.nodes.length > 3);

      if (hasMultiStepNodes) {
        const enrollment = await this.enrollmentModel.create({
          tenantId: tenantObjectId,
          workflowId: wf._id,
          workflowName: wf.name,
          leadId: lead._id,
          leadName: lead.name,
          leadPhone: lead.phone || '',
          leadSource: lead.source || 'website',
          currentStepIndex: 0,
          status: 'active',
          nextRunAt: new Date(),
          stopOnReply: wf.stopOnReply ?? true,
          stepLogs: [],
        });
        await this.advanceEnrollment(enrollment, wf, {
          forceSkipDelays: false,
          actorUserId: auth.userId,
          actorName,
        });
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

    if (Array.isArray(doc.nodes) && doc.nodes.length > 2) {
      const sim = await this.simulateLeadThroughWorkflow(auth, id, {
        forceSkipDelays: true,
      });
      return sim.workflow;
    }

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

    const minMatch = lower.match(/(\d+)\s*(?:m|min|mins|minute|minutes)/i);
    const hourMatch = lower.match(/(\d+)\s*(?:h|hr|hrs|hour|hours)/i);
    const dayMatch = lower.match(/(\d+)\s*(?:d|day|days)/i);
    const staleMinutes = minMatch ? Math.min(120, Math.max(1, Number(minMatch[1]))) : 10;
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
    if (/reassign|sla|uncontacted|backup/i.test(lower)) {
      actionType = 'reassign_rep_sla_alert';
    } else if (/drip|sequence|day 1|multi/i.test(lower)) {
      actionType = 'multi_step_whatsapp_drip';
    } else if (
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
    if (actionType === 'reassign_rep_sla_alert') {
      conditionParts.push(`Uncontacted after ${staleMinutes}m`);
    }
    const conditionSummary = conditionParts.join(' AND ');

    const actionSummary =
      actionType === 'reassign_rep_sla_alert'
        ? `Wait ${staleMinutes}m -> Hinglish WhatsApp Follow-Up + Reassign Backup Rep + Urgent SLA Alert`
        : actionType === 'multi_step_whatsapp_drip'
          ? 'Multi-Step Hinglish WhatsApp Drip (Stops automatically on buyer reply)'
          : actionType === 'send_payment_reminder'
            ? 'Send Hinglish WhatsApp Payment Reminder with Razorpay Link'
            : `Send GST Brochure & Catalogue on WhatsApp + Create Follow-Up Task`;

    const whatsappTemplateBody =
      actionType === 'send_payment_reminder'
        ? 'Namaste {{buyer_name}} ji 🙏, gentle reminder regarding your pending GST invoice for {{company}} ({{deal_value}}). You can complete payment directly via the Razorpay link shared.'
        : `Namaste {{buyer_name}} ji 👋, thank you for your ${sourceFilter !== 'all' ? `${sourceLabel} ` : ''}inquiry for {{company}}${cityLabel ? ` (${cityLabel})` : ''}. Sharing our GST brochure, product catalogue & best rate right away!`;

    const name =
      actionType === 'reassign_rep_sla_alert'
        ? `${sourceLabel} -> ${staleMinutes}m Uncontacted SLA -> Hinglish WhatsApp + Backup Rep`
        : `${sourceLabel} -> Automated Hinglish WhatsApp & Task Flow`;

    const nodes = this.synthesizeDefaultNodes({
      triggerType,
      sourceFilter,
      staleStage,
      staleHours,
      staleMinutes,
      conditionSummary,
      actionType,
      actionSummary,
      whatsappTemplateBody,
    });

    return {
      name,
      description: `AI-generated visual flow from: "${goal.slice(0, 140)}"`,
      triggerType,
      sourceFilter,
      staleStage,
      staleHours,
      staleMinutes,
      conditionSummary,
      actionType,
      actionSummary,
      whatsappTemplateBody,
      nodes,
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

    const s = aiRes?.structured;
    const triggerType =
      s?.triggerType && validTriggers.has(s.triggerType as WorkflowTriggerType)
        ? (s.triggerType as WorkflowTriggerType)
        : fallback.triggerType;

    return {
      prompt,
      name: s?.name?.trim() || fallback.name,
      description: s?.description?.trim() || fallback.description,
      triggerType,
      sourceFilter: fallback.sourceFilter,
      staleStage: fallback.staleStage,
      staleHours: fallback.staleHours,
      staleMinutes: fallback.staleMinutes,
      conditionSummary: s?.conditionSummary?.trim() || fallback.conditionSummary,
      actionType: fallback.actionType,
      actionSummary: s?.actionSummary?.trim() || fallback.actionSummary,
      whatsappTemplateBody:
        s?.whatsappTemplateBody?.trim() || fallback.whatsappTemplateBody,
      nodes: fallback.nodes,
      provider: aiRes?.provider || 'fallback',
      model: aiRes?.model || 'leadsetu-heuristic-v1',
    };
  }
}
