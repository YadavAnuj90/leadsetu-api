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
import { randomBytes } from 'crypto';
import { AuditService } from '../audit/audit.module';
import { maskPhoneNumber, resolveOwnerScopeFilter } from '../auth/identity.util';
import { SuperAdminService } from '../super-admin/super-admin.service';
import {
  AddTicketCommentDto,
  CreateTicketDto,
  TicketAuthContext,
  TicketCategory,
  TicketPriority,
  TicketStatus,
  UpdateTicketDto,
} from './dto/tickets.dto';

export type TicketDocument = HydratedDocument<Ticket>;

@Schema({ _id: false })
export class TicketComment {
  @Prop({ required: true, trim: true })
  id!: string;

  @Prop({ required: true, trim: true })
  authorName!: string;

  @Prop({
    default: 'agent',
    enum: ['agent', 'engineer', 'customer', 'system'],
  })
  authorRole!: 'agent' | 'engineer' | 'customer' | 'system';

  @Prop({ required: true, trim: true })
  message!: string;

  @Prop({ type: Boolean, default: false })
  isInternal!: boolean;

  @Prop({ required: true, trim: true })
  createdAt!: string;
}

export const TicketCommentSchema = SchemaFactory.createForClass(TicketComment);

@Schema({ timestamps: true, collection: 'tickets' })
export class Ticket {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  ownerId!: Types.ObjectId;

  @Prop({ required: true, trim: true, index: true })
  ticketNumber!: string;

  @Prop({ required: true, trim: true })
  subject!: string;

  @Prop({
    default: 'general',
    enum: [
      'dispatch_delay',
      'warranty',
      'gst_correction',
      'installation',
      'amc_service',
      'general',
    ],
    index: true,
  })
  category!: TicketCategory;

  @Prop({
    default: 'medium',
    enum: ['low', 'medium', 'high', 'urgent'],
    index: true,
  })
  priority!: TicketPriority;

  @Prop({
    default: 'open',
    enum: ['open', 'in_progress', 'waiting_client', 'resolved', 'closed'],
    index: true,
  })
  status!: TicketStatus;

  @Prop({ trim: true, default: '' })
  customerName!: string;

  @Prop({ trim: true, default: '' })
  company!: string;

  @Prop({ trim: true, default: '' })
  phone!: string;

  @Prop({ trim: true, lowercase: true, default: '' })
  email!: string;

  @Prop({ trim: true, default: '' })
  siteAddress!: string;

  @Prop({ trim: true, default: '' })
  linkedContactId!: string;

  @Prop({ trim: true, default: '' })
  linkedInvoiceNumber!: string;

  @Prop({ trim: true, default: '' })
  productSerialOrSku!: string;

  @Prop({ trim: true, default: '' })
  assignedToName!: string;

  @Prop({ trim: true, default: '' })
  assignedToPhone!: string;

  @Prop({ trim: true, default: '' })
  slaDueAt!: string;

  @Prop({ trim: true, default: '' })
  resolvedAt!: string;

  @Prop({ trim: true, default: '' })
  resolutionSummary!: string;

  @Prop({ type: Number, default: 0 })
  csatRating!: number;

  @Prop({ trim: true, default: '' })
  notes!: string;

  @Prop({ type: [TicketCommentSchema], default: [] })
  comments!: TicketComment[];
}

export const TicketSchema = SchemaFactory.createForClass(Ticket);

@Injectable()
export class TicketsService {
  constructor(
    @InjectModel(Ticket.name) private readonly ticketModel: Model<TicketDocument>,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    @Optional() private readonly auditService?: AuditService,
    @Optional() private readonly superAdminService?: SuperAdminService,
  ) {}

  async verifyAuth(authHeader?: string): Promise<TicketAuthContext> {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Authorization token is required.');
    }
    const token = authHeader.slice(7).trim();
    const secret =
      this.configService.get<string>('JWT_SECRET') ||
      'leadsetu_super_secret_access_key';
    let payload: { sub: string; tenantId: string; email: string; name?: string };
    try {
      payload = await this.jwtService.verifyAsync<{
        sub: string;
        tenantId: string;
        email: string;
        name?: string;
      }>(token, { secret });
    } catch {
      throw new UnauthorizedException('Invalid or expired session.');
    }
    await this.superAdminService?.assertFeatureEnabled(
      payload.tenantId,
      'slaTickets',
    );
    return {
      userId: payload.sub,
      tenantId: payload.tenantId,
      email: payload.email,
      name: payload.name || payload.email.split('@')[0],
    };
  }

  private computeSlaState(status: string, slaDueAt?: string) {
    const isResolved = status === 'resolved' || status === 'closed';
    if (!slaDueAt) {
      return { isSlaBreached: false, slaRemainingHours: 48 };
    }
    const dueEndMs = new Date(`${slaDueAt.slice(0, 10)}T23:59:59`).getTime();
    if (!Number.isFinite(dueEndMs)) {
      return { isSlaBreached: false, slaRemainingHours: 48 };
    }
    const diffHours = Math.round((dueEndMs - Date.now()) / 3600000);
    return {
      isSlaBreached: !isResolved && diffHours < 0,
      slaRemainingHours: isResolved ? 0 : diffHours,
    };
  }

  private toDto(doc: TicketDocument, maskPhones = false) {
    const raw = doc.toObject() as unknown as {
      createdAt?: Date;
      updatedAt?: Date;
    };
    const sla = this.computeSlaState(doc.status, doc.slaDueAt);

    return {
      id: doc._id.toString(),
      tenantId: doc.tenantId.toString(),
      ownerId: doc.ownerId.toString(),
      ticketNumber: doc.ticketNumber,
      subject: doc.subject,
      category: doc.category,
      priority: doc.priority,
      status: doc.status,
      customerName: doc.customerName || '',
      company: doc.company || '',
      phone: maskPhones ? maskPhoneNumber(doc.phone) : doc.phone || '',
      email: doc.email || '',
      siteAddress: doc.siteAddress || '',
      linkedContactId: doc.linkedContactId || '',
      linkedInvoiceNumber: doc.linkedInvoiceNumber || '',
      productSerialOrSku: doc.productSerialOrSku || '',
      assignedToName: doc.assignedToName || '',
      assignedToPhone: doc.assignedToPhone || '',
      slaDueAt: doc.slaDueAt || '',
      isSlaBreached: sla.isSlaBreached,
      slaRemainingHours: sla.slaRemainingHours,
      resolvedAt: doc.resolvedAt || '',
      resolutionSummary: doc.resolutionSummary || '',
      csatRating: Number(doc.csatRating) || 0,
      notes: doc.notes || '',
      comments: Array.isArray(doc.comments) ? doc.comments : [],
      createdAt: raw.createdAt
        ? new Date(raw.createdAt).toISOString()
        : new Date().toISOString(),
      updatedAt: raw.updatedAt
        ? new Date(raw.updatedAt).toISOString()
        : new Date().toISOString(),
    };
  }

  async findAll(
    auth: TicketAuthContext,
    query: {
      status?: string;
      priority?: string;
      category?: string;
      slaBreached?: string;
      search?: string;
    },
  ) {
    const tenantObjectId = new Types.ObjectId(auth.tenantId);
    const ownerScope = await resolveOwnerScopeFilter(this.ticketModel.db, auth);
    const baseScope: Record<string, unknown> = {
      tenantId: tenantObjectId,
      ...ownerScope,
    };
    const filter: Record<string, unknown> = { ...baseScope };

    if (query.status && query.status !== 'all') {
      filter.status = query.status;
    }
    if (query.priority && query.priority !== 'all') {
      filter.priority = query.priority;
    }
    if (query.category && query.category !== 'all') {
      filter.category = query.category;
    }
    if (query.search?.trim()) {
      const rx = new RegExp(query.search.trim(), 'i');
      filter.$or = [
        { ticketNumber: rx },
        { subject: rx },
        { customerName: rx },
        { company: rx },
        { linkedInvoiceNumber: rx },
        { productSerialOrSku: rx },
        { assignedToName: rx },
        { siteAddress: rx },
      ];
    }

    const [docs, allDocs, maskPhones] = await Promise.all([
      this.ticketModel.find(filter).sort({ createdAt: -1 }).exec(),
      this.ticketModel.find(baseScope).exec(),
      this.auditService
        ? this.auditService.shouldMaskViewerPhones(auth.tenantId, auth.userId)
        : Promise.resolve(false),
    ]);

    const mappedAll = allDocs.map((d) => this.toDto(d, maskPhones));
    let mappedFiltered = docs.map((d) => this.toDto(d, maskPhones));
    if (query.slaBreached === 'true') {
      mappedFiltered = mappedFiltered.filter((t) => t.isSlaBreached);
    }

    const rated = mappedAll.filter((t) => t.csatRating > 0);
    const avgCsat =
      rated.length > 0
        ? Math.round(
            (rated.reduce((s, t) => s + t.csatRating, 0) / rated.length) * 10,
          ) / 10
        : 0;

    return {
      data: mappedFiltered,
      stats: {
        total: allDocs.length,
        openCount: allDocs.filter((t) =>
          ['open', 'in_progress', 'waiting_client'].includes(t.status),
        ).length,
        inProgressCount: allDocs.filter((t) => t.status === 'in_progress').length,
        waitingClientCount: allDocs.filter((t) => t.status === 'waiting_client')
          .length,
        urgentCount: allDocs.filter(
          (t) =>
            (t.priority === 'urgent' || t.priority === 'high') &&
            !['resolved', 'closed'].includes(t.status),
        ).length,
        resolvedCount: allDocs.filter((t) =>
          ['resolved', 'closed'].includes(t.status),
        ).length,
        slaBreachedCount: mappedAll.filter((t) => t.isSlaBreached).length,
        avgCsat,
      },
    };
  }

  async findOne(auth: TicketAuthContext, id: string) {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Ticket not found.');
    }
    const ownerScope = await resolveOwnerScopeFilter(this.ticketModel.db, auth);
    const doc = await this.ticketModel
      .findOne({
        _id: new Types.ObjectId(id),
        tenantId: new Types.ObjectId(auth.tenantId),
        ...ownerScope,
      })
      .exec();
    if (!doc) {
      throw new NotFoundException('Ticket not found.');
    }
    const maskPhones = this.auditService
      ? await this.auditService.shouldMaskViewerPhones(auth.tenantId, auth.userId)
      : false;
    return this.toDto(doc, maskPhones);
  }

  async create(auth: TicketAuthContext, dto: CreateTicketDto) {
    if (!dto.subject?.trim()) {
      throw new BadRequestException('Ticket subject is required.');
    }

    const existingCount = await this.ticketModel
      .countDocuments({ tenantId: new Types.ObjectId(auth.tenantId) })
      .exec();
    const ticketNumber = `TKT-2026-${String(existingCount + 101)}`;
    const priority = dto.priority || 'medium';
    const slaDays =
      priority === 'urgent'
        ? 0
        : priority === 'high'
          ? 1
          : priority === 'medium'
            ? 2
            : 3;
    const defaultSla = new Date(Date.now() + slaDays * 86400000)
      .toISOString()
      .slice(0, 10);
    const nowIso = new Date().toISOString();

    const initialComments: TicketComment[] = [
      {
        id: `cmt-${Date.now()}-${randomBytes(2).toString('hex')}`,
        authorName: auth.name || auth.email || 'Support Desk',
        authorRole: 'system',
        message: `Ticket ${ticketNumber} opened (${priority.toUpperCase()} priority)${
          dto.assignedToName ? ` and assigned to ${dto.assignedToName}` : ''
        }.${dto.notes ? ` Initial note: ${dto.notes.trim()}` : ''}`,
        isInternal: false,
        createdAt: nowIso,
      },
    ];

    const status = dto.status || 'open';
    const doc = await this.ticketModel.create({
      tenantId: new Types.ObjectId(auth.tenantId),
      ownerId: new Types.ObjectId(auth.userId),
      ticketNumber,
      subject: dto.subject.trim(),
      category: dto.category || 'general',
      priority,
      status,
      customerName: dto.customerName?.trim() || '',
      company: dto.company?.trim() || '',
      phone: dto.phone?.trim() || '',
      email: dto.email?.trim().toLowerCase() || '',
      siteAddress: dto.siteAddress?.trim() || '',
      linkedContactId: dto.linkedContactId?.trim() || '',
      linkedInvoiceNumber: dto.linkedInvoiceNumber?.trim() || '',
      productSerialOrSku: dto.productSerialOrSku?.trim() || '',
      assignedToName: dto.assignedToName?.trim() || '',
      assignedToPhone: dto.assignedToPhone?.trim() || '',
      slaDueAt: dto.slaDueAt || defaultSla,
      resolvedAt: status === 'resolved' || status === 'closed' ? nowIso : '',
      resolutionSummary: dto.resolutionSummary?.trim() || '',
      csatRating: Number(dto.csatRating) || 0,
      notes: dto.notes?.trim() || '',
      comments: initialComments,
    });

    await this.auditService?.record({
      tenantId: auth.tenantId,
      actorId: auth.userId,
      actorEmail: auth.email,
      action: 'ticket.created',
      entityType: 'ticket',
      entityId: doc._id.toString(),
      entityLabel: `${ticketNumber} · ${doc.subject}`,
      summary: `Opened SLA ticket ${ticketNumber} (${doc.priority.toUpperCase()} priority)`,
    });

    const maskPhones = this.auditService
      ? await this.auditService.shouldMaskViewerPhones(auth.tenantId, auth.userId)
      : false;
    return this.toDto(doc, maskPhones);
  }

  async update(auth: TicketAuthContext, id: string, dto: UpdateTicketDto) {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Ticket not found.');
    }
    const ownerScope = await resolveOwnerScopeFilter(this.ticketModel.db, auth);
    const doc = await this.ticketModel
      .findOne({
        _id: new Types.ObjectId(id),
        tenantId: new Types.ObjectId(auth.tenantId),
        ...ownerScope,
      })
      .exec();
    if (!doc) {
      throw new NotFoundException('Ticket not found.');
    }

    const prevStatus = doc.status;
    const prevAssignee = doc.assignedToName;
    const nowIso = new Date().toISOString();

    if (dto.subject !== undefined) doc.subject = dto.subject.trim();
    if (dto.category !== undefined) doc.category = dto.category;
    if (dto.priority !== undefined) doc.priority = dto.priority;
    if (dto.status !== undefined) {
      doc.status = dto.status;
      if (
        (dto.status === 'resolved' || dto.status === 'closed') &&
        !doc.resolvedAt
      ) {
        doc.resolvedAt = nowIso;
      } else if (dto.status !== 'resolved' && dto.status !== 'closed') {
        doc.resolvedAt = '';
      }
    }
    if (dto.customerName !== undefined)
      doc.customerName = dto.customerName.trim();
    if (dto.company !== undefined) doc.company = dto.company.trim();
    if (dto.phone !== undefined) doc.phone = dto.phone.trim();
    if (dto.email !== undefined) doc.email = dto.email.trim().toLowerCase();
    if (dto.siteAddress !== undefined)
      doc.siteAddress = dto.siteAddress.trim();
    if (dto.linkedContactId !== undefined)
      doc.linkedContactId = dto.linkedContactId.trim();
    if (dto.slaDueAt !== undefined) doc.slaDueAt = dto.slaDueAt;
    if (dto.notes !== undefined) doc.notes = dto.notes.trim();
    if (dto.linkedInvoiceNumber !== undefined) {
      doc.linkedInvoiceNumber = dto.linkedInvoiceNumber.trim();
    }
    if (dto.productSerialOrSku !== undefined) {
      doc.productSerialOrSku = dto.productSerialOrSku.trim();
    }
    if (dto.assignedToName !== undefined) {
      doc.assignedToName = dto.assignedToName.trim();
    }
    if (dto.assignedToPhone !== undefined) {
      doc.assignedToPhone = dto.assignedToPhone.trim();
    }
    if (dto.resolutionSummary !== undefined) {
      doc.resolutionSummary = dto.resolutionSummary.trim();
    }
    if (dto.csatRating !== undefined) {
      doc.csatRating = Math.min(5, Math.max(0, Number(dto.csatRating) || 0));
    }

    const timelineEvents: string[] = [];
    if (dto.status && dto.status !== prevStatus) {
      timelineEvents.push(
        `Status changed from ${prevStatus.replace('_', ' ').toUpperCase()} to ${dto.status.replace('_', ' ').toUpperCase()}`,
      );
    }
    if (
      dto.assignedToName !== undefined &&
      dto.assignedToName.trim() !== prevAssignee
    ) {
      timelineEvents.push(
        dto.assignedToName.trim()
          ? `Assigned to ${dto.assignedToName.trim()}`
          : 'Unassigned engineer',
      );
    }
    if (dto.resolutionSummary?.trim()) {
      timelineEvents.push(`Resolution Note: ${dto.resolutionSummary.trim()}`);
    }

    if (timelineEvents.length > 0) {
      doc.comments = [
        ...(Array.isArray(doc.comments) ? doc.comments : []),
        {
          id: `cmt-${Date.now()}-${randomBytes(2).toString('hex')}`,
          authorName: auth.name || auth.email || 'Support Desk',
          authorRole: 'system',
          message: timelineEvents.join(' · '),
          isInternal: false,
          createdAt: nowIso,
        },
      ];
    }

    await doc.save();

    if (dto.status && dto.status !== prevStatus) {
      await this.auditService?.record({
        tenantId: auth.tenantId,
        actorId: auth.userId,
        actorEmail: auth.email,
        action: 'ticket.status_changed',
        entityType: 'ticket',
        entityId: doc._id.toString(),
        entityLabel: `${doc.ticketNumber} · ${doc.subject}`,
        summary: `Ticket ${doc.ticketNumber} moved ${prevStatus} -> ${dto.status}`,
      });
    }

    const maskPhones = this.auditService
      ? await this.auditService.shouldMaskViewerPhones(auth.tenantId, auth.userId)
      : false;
    return this.toDto(doc, maskPhones);
  }

  async addComment(
    auth: TicketAuthContext,
    id: string,
    dto: AddTicketCommentDto,
  ) {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Ticket not found.');
    }
    if (!dto.message?.trim()) {
      throw new BadRequestException('Comment message is required.');
    }
    const ownerScope = await resolveOwnerScopeFilter(this.ticketModel.db, auth);
    const doc = await this.ticketModel
      .findOne({
        _id: new Types.ObjectId(id),
        tenantId: new Types.ObjectId(auth.tenantId),
        ...ownerScope,
      })
      .exec();
    if (!doc) {
      throw new NotFoundException('Ticket not found.');
    }

    const nowIso = new Date().toISOString();
    const entry: TicketComment = {
      id: `cmt-${Date.now()}-${randomBytes(2).toString('hex')}`,
      authorName:
        dto.authorName?.trim() ||
        auth.name ||
        auth.email ||
        'Support Engineer',
      authorRole: dto.authorRole || 'agent',
      message: dto.message.trim(),
      isInternal: Boolean(dto.isInternal),
      createdAt: nowIso,
    };

    doc.comments = [...(Array.isArray(doc.comments) ? doc.comments : []), entry];

    if (dto.nextStatus && dto.nextStatus !== doc.status) {
      doc.status = dto.nextStatus;
      if (dto.nextStatus === 'resolved' || dto.nextStatus === 'closed') {
        doc.resolvedAt = nowIso;
      }
    }
    if (dto.resolutionSummary?.trim()) {
      doc.resolutionSummary = dto.resolutionSummary.trim();
    }

    await doc.save();

    await this.auditService?.record({
      tenantId: auth.tenantId,
      actorId: auth.userId,
      actorEmail: auth.email,
      action: 'ticket.comment_added',
      entityType: 'ticket',
      entityId: doc._id.toString(),
      entityLabel: `${doc.ticketNumber} · ${doc.subject}`,
      summary: `${entry.isInternal ? 'Added internal note' : 'Posted reply'} on ${doc.ticketNumber}${
        dto.nextStatus ? ` (Status -> ${dto.nextStatus})` : ''
      }`,
    });

    const maskPhones = this.auditService
      ? await this.auditService.shouldMaskViewerPhones(auth.tenantId, auth.userId)
      : false;
    return this.toDto(doc, maskPhones);
  }

  async remove(auth: TicketAuthContext, id: string) {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Ticket not found.');
    }
    const ownerScope = await resolveOwnerScopeFilter(this.ticketModel.db, auth);
    const doc = await this.ticketModel
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
        action: 'ticket.deleted',
        entityType: 'ticket',
        entityId: id,
        entityLabel: `${doc.ticketNumber} · ${doc.subject}`,
        summary: `Deleted support ticket ${doc.ticketNumber}`,
      });
    }

    return { success: true, id };
  }
}
