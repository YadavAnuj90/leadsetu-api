import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { randomBytes } from 'crypto';
import { Model, Types } from 'mongoose';
import { AuditService } from '../audit/audit.module';
import {
  CreatePlatformTicketDto,
  PlatformTicketReplyDto,
  SuperAdminUpdatePlatformTicketDto,
} from './dto/platform-tickets.dto';
import {
  PlatformTicket,
  PlatformTicketComment,
  PlatformTicketDocument,
  PlatformTicketStatus,
} from './schemas/platform-ticket.schema';

interface VerifiedActor {
  userId: string;
  tenantId: string;
  role: string;
  name: string;
  email: string;
  accountId: string;
  companyName: string;
  businessMode: string;
  tenantPlan: string;
}

@Injectable()
export class PlatformTicketsService {
  constructor(
    @InjectModel(PlatformTicket.name)
    private readonly ticketModel: Model<PlatformTicketDocument>,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    @Optional() private readonly auditService?: AuditService,
  ) {}

  private async verifyJwtAndUser(authHeader?: string): Promise<VerifiedActor> {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Authorization token is required.');
    }
    const token = authHeader.slice(7).trim();
    const secret =
      this.configService.get<string>('JWT_SECRET') ||
      'leadsetu_super_secret_access_key_2026';

    let payload: { sub: string; tenantId?: string; email?: string; role?: string };
    try {
      payload = await this.jwtService.verifyAsync(token, { secret });
    } catch {
      throw new UnauthorizedException('Invalid or expired session.');
    }

    if (!Types.ObjectId.isValid(payload.sub)) {
      throw new UnauthorizedException('Invalid session account.');
    }

    const db = this.ticketModel.db;
    const userDoc = await db
      .collection('users')
      .findOne(
        { _id: new Types.ObjectId(payload.sub) },
        {
          projection: {
            _id: 1,
            tenantId: 1,
            name: 1,
            email: 1,
            role: 1,
            isActive: 1,
          },
        },
      );

    if (!userDoc || userDoc.isActive === false) {
      throw new UnauthorizedException('Account is inactive or missing.');
    }

    const tenantObjId = userDoc.tenantId as Types.ObjectId | undefined;
    const tenantDoc = tenantObjId
      ? await db
          .collection('tenants')
          .findOne(
            { _id: tenantObjId },
            {
              projection: {
                _id: 1,
                accountId: 1,
                name: 1,
                companyName: 1,
                businessMode: 1,
                plan: 1,
              },
            },
          )
      : null;

    return {
      userId: userDoc._id.toString(),
      tenantId: tenantObjId ? tenantObjId.toString() : String(payload.tenantId || ''),
      role: String(userDoc.role || payload.role || ''),
      name: String(userDoc.name || payload.email || 'Admin'),
      email: String(userDoc.email || payload.email || ''),
      accountId: String(tenantDoc?.accountId || ''),
      companyName: String(tenantDoc?.companyName || tenantDoc?.name || ''),
      businessMode: String(tenantDoc?.businessMode || 'b2b'),
      tenantPlan: String(tenantDoc?.plan || 'starter'),
    };
  }

  async verifyTenantAdmin(authHeader?: string): Promise<VerifiedActor> {
    const actor = await this.verifyJwtAndUser(authHeader);
    if (
      actor.role !== 'owner' &&
      actor.role !== 'admin' &&
      actor.role !== 'super_admin'
    ) {
      throw new ForbiddenException(
        'Only Workspace Owners or Company Admins can raise Leadsetu HQ platform tickets.',
      );
    }
    return actor;
  }

  async verifySuperAdmin(authHeader?: string): Promise<VerifiedActor> {
    const actor = await this.verifyJwtAndUser(authHeader);
    if (actor.role !== 'super_admin') {
      throw new ForbiddenException(
        'Super Admin authority is required to view and resolve cross-tenant platform tickets.',
      );
    }
    return actor;
  }

  /** Tenant Admin view intentionally omits raw accountId/company metadata inside ticket body. */
  private toTenantDto(doc: PlatformTicketDocument) {
    const raw = doc.toObject() as unknown as {
      createdAt?: Date;
      updatedAt?: Date;
    };
    return {
      id: doc._id.toString(),
      ticketNumber: doc.ticketNumber,
      subject: doc.subject,
      category: doc.category,
      priority: doc.priority,
      status: doc.status,
      description: doc.description,
      resolutionSummary: doc.resolutionSummary || '',
      resolvedByName: doc.resolvedByName || '',
      resolvedAt: doc.resolvedAt || '',
      comments: Array.isArray(doc.comments) ? doc.comments : [],
      createdAt: raw.createdAt
        ? new Date(raw.createdAt).toISOString()
        : new Date().toISOString(),
      updatedAt: raw.updatedAt
        ? new Date(raw.updatedAt).toISOString()
        : new Date().toISOString(),
    };
  }

  /** Super Admin view exposes complete workspace identity: accountId, companyName, businessMode & plan. */
  private toSuperAdminDto(doc: PlatformTicketDocument) {
    return {
      ...this.toTenantDto(doc),
      tenantId: doc.tenantId.toString(),
      accountId: doc.accountId || '',
      companyName: doc.companyName || '',
      businessMode: doc.businessMode || 'b2b',
      tenantPlan: doc.tenantPlan || 'starter',
      raisedByUserId: doc.raisedByUserId.toString(),
      raisedByName: doc.raisedByName || '',
      raisedByEmail: doc.raisedByEmail || '',
      raisedByRole: doc.raisedByRole || 'admin',
      pageUrl: doc.pageUrl || '',
    };
  }

  private async notifyWorkspaceAdminsOfUpdate(
    ticket: PlatformTicketDocument,
    params: {
      authorUserId: string;
      authorName: string;
      title: string;
      excerpt: string;
      status: PlatformTicketStatus;
      severity?: 'urgent' | 'high' | 'info';
    },
  ) {
    const db = this.ticketModel.db;
    if (!db || typeof db.collection !== 'function') return;

    try {
      const admins = await db
        .collection('users')
        .find(
          {
            tenantId: ticket.tenantId,
            isActive: { $ne: false },
            $or: [
              { _id: ticket.raisedByUserId },
              { role: { $in: ['owner', 'admin'] } },
            ],
          },
          { projection: { _id: 1, name: 1 } },
        )
        .toArray();

      if (admins.length === 0) return;

      const now = new Date();
      const shortExcerpt =
        params.excerpt.length > 150
          ? `${params.excerpt.slice(0, 147)}...`
          : params.excerpt;

      const docs = admins.map((u) => ({
        tenantId: ticket.tenantId,
        mentionedUserId: new Types.ObjectId(String(u._id)),
        mentionedName: String(u.name || ''),
        authorId: Types.ObjectId.isValid(params.authorUserId)
          ? new Types.ObjectId(params.authorUserId)
          : params.authorUserId,
        authorName: params.authorName || 'Leadsetu HQ',
        entityType: 'platform_ticket',
        entityId: ticket._id.toString(),
        entityLabel: ticket.ticketNumber,
        entityStatus: params.status,
        severity: params.severity || (params.status === 'resolved' ? 'info' : 'high'),
        title: params.title,
        excerpt: shortExcerpt,
        href: `/support-hq?ticketId=${ticket._id.toString()}`,
        createdAt: now,
      }));

      await db.collection('mention_notifications').insertMany(docs);
    } catch {
      // Notification failure never blocks ticket resolution.
    }
  }

  async listForTenantAdmin(
    actor: VerifiedActor,
    query: { status?: string; search?: string },
  ) {
    if (!Types.ObjectId.isValid(actor.tenantId)) {
      throw new BadRequestException('Invalid workspace.');
    }
    const tenantObjId = new Types.ObjectId(actor.tenantId);
    const allDocs = await this.ticketModel
      .find({ tenantId: tenantObjId })
      .sort({ createdAt: -1 })
      .exec();

    let filtered = allDocs;
    if (query.status && query.status !== 'all') {
      filtered = filtered.filter((d) => d.status === query.status);
    }
    if (query.search?.trim()) {
      const q = query.search.trim().toLowerCase();
      filtered = filtered.filter(
        (d) =>
          d.ticketNumber.toLowerCase().includes(q) ||
          d.subject.toLowerCase().includes(q) ||
          d.description.toLowerCase().includes(q),
      );
    }

    return {
      data: filtered.map((d) => this.toTenantDto(d)),
      stats: {
        total: allDocs.length,
        openCount: allDocs.filter((d) =>
          ['open', 'in_progress', 'waiting_admin'].includes(d.status),
        ).length,
        resolvedCount: allDocs.filter((d) =>
          ['resolved', 'closed'].includes(d.status),
        ).length,
      },
    };
  }

  async createForTenantAdmin(actor: VerifiedActor, dto: CreatePlatformTicketDto) {
    if (!dto.subject?.trim()) {
      throw new BadRequestException('Issue subject is required.');
    }
    if (!dto.description?.trim()) {
      throw new BadRequestException('Please describe the glitch or issue you are facing.');
    }
    if (!Types.ObjectId.isValid(actor.tenantId)) {
      throw new BadRequestException('Invalid workspace identity.');
    }

    const count = await this.ticketModel.countDocuments().exec();
    const ticketNumber = `PLT-2026-${String(count + 101)}`;
    const nowIso = new Date().toISOString();

    const doc = await this.ticketModel.create({
      ticketNumber,
      tenantId: new Types.ObjectId(actor.tenantId),
      accountId: actor.accountId,
      companyName: actor.companyName,
      businessMode: actor.businessMode,
      tenantPlan: actor.tenantPlan,
      raisedByUserId: new Types.ObjectId(actor.userId),
      raisedByName: actor.name,
      raisedByEmail: actor.email,
      raisedByRole: actor.role,
      subject: dto.subject.trim(),
      category: dto.category || 'ui_glitch',
      priority: dto.priority || 'high',
      status: 'open',
      description: dto.description.trim(),
      pageUrl: String(dto.pageUrl || '').trim().slice(0, 240),
      comments: [
        {
          id: `pc-${Date.now()}-${randomBytes(2).toString('hex')}`,
          authorName: 'Leadsetu HQ Triage',
          authorRole: 'system',
          message: `Ticket ${ticketNumber} logged and routed to Leadsetu Super Admin engineering queue.`,
          createdAt: nowIso,
        },
      ],
    });

    await this.auditService?.record({
      tenantId: actor.tenantId,
      actorId: actor.userId,
      actorName: actor.name,
      actorEmail: actor.email,
      actorRole: actor.role,
      action: 'platform_ticket.created',
      entityType: 'ticket',
      entityId: doc._id.toString(),
      entityLabel: `${ticketNumber} · ${doc.subject}`,
      summary: `Raised HQ platform ticket ${ticketNumber} (${doc.category})`,
    });

    return this.toTenantDto(doc);
  }

  async replyForTenantAdmin(
    actor: VerifiedActor,
    id: string,
    dto: PlatformTicketReplyDto,
  ) {
    if (!Types.ObjectId.isValid(id) || !Types.ObjectId.isValid(actor.tenantId)) {
      throw new NotFoundException('Platform ticket not found.');
    }
    if (!dto.message?.trim()) {
      throw new BadRequestException('Reply message cannot be empty.');
    }

    const doc = await this.ticketModel
      .findOne({
        _id: new Types.ObjectId(id),
        tenantId: new Types.ObjectId(actor.tenantId),
      })
      .exec();

    if (!doc) {
      throw new NotFoundException('Platform ticket not found.');
    }

    const nowIso = new Date().toISOString();
    const comment: PlatformTicketComment = {
      id: `pc-${Date.now()}-${randomBytes(2).toString('hex')}`,
      authorName: actor.name,
      authorRole: 'tenant_admin',
      message: dto.message.trim(),
      createdAt: nowIso,
    };

    doc.comments = [...(Array.isArray(doc.comments) ? doc.comments : []), comment];
    if (
      doc.status === 'waiting_admin' ||
      doc.status === 'resolved' ||
      dto.nextStatus === 'open'
    ) {
      doc.status = 'in_progress';
      doc.resolvedAt = '';
    }
    await doc.save();

    return this.toTenantDto(doc);
  }

  async reopenForTenantAdmin(actor: VerifiedActor, id: string) {
    if (!Types.ObjectId.isValid(id) || !Types.ObjectId.isValid(actor.tenantId)) {
      throw new NotFoundException('Platform ticket not found.');
    }
    const doc = await this.ticketModel
      .findOne({
        _id: new Types.ObjectId(id),
        tenantId: new Types.ObjectId(actor.tenantId),
      })
      .exec();

    if (!doc) {
      throw new NotFoundException('Platform ticket not found.');
    }

    const nowIso = new Date().toISOString();
    doc.status = 'open';
    doc.resolvedAt = '';
    doc.comments = [
      ...(Array.isArray(doc.comments) ? doc.comments : []),
      {
        id: `pc-${Date.now()}-${randomBytes(2).toString('hex')}`,
        authorName: actor.name,
        authorRole: 'system',
        message: `Ticket reopened by workspace admin (${actor.name}) for further review.`,
        createdAt: nowIso,
      },
    ];
    await doc.save();

    return this.toTenantDto(doc);
  }

  // ─── Super Admin Cross-Tenant Control Center ────────────────────────────────

  async listForSuperAdmin(query: {
    status?: string;
    priority?: string;
    category?: string;
    search?: string;
  }) {
    const allDocs = await this.ticketModel.find().sort({ createdAt: -1 }).exec();

    let filtered = allDocs;
    if (query.status && query.status !== 'all') {
      if (query.status === 'active') {
        filtered = filtered.filter((d) =>
          ['open', 'in_progress', 'waiting_admin'].includes(d.status),
        );
      } else {
        filtered = filtered.filter((d) => d.status === query.status);
      }
    }
    if (query.priority && query.priority !== 'all') {
      filtered = filtered.filter((d) => d.priority === query.priority);
    }
    if (query.category && query.category !== 'all') {
      filtered = filtered.filter((d) => d.category === query.category);
    }
    if (query.search?.trim()) {
      const q = query.search.trim().toLowerCase();
      filtered = filtered.filter(
        (d) =>
          d.ticketNumber.toLowerCase().includes(q) ||
          d.subject.toLowerCase().includes(q) ||
          d.description.toLowerCase().includes(q) ||
          d.accountId.toLowerCase().includes(q) ||
          d.companyName.toLowerCase().includes(q) ||
          d.raisedByEmail.toLowerCase().includes(q) ||
          d.raisedByName.toLowerCase().includes(q),
      );
    }

    return {
      data: filtered.map((d) => this.toSuperAdminDto(d)),
      stats: {
        total: allDocs.length,
        openCount: allDocs.filter((d) => d.status === 'open').length,
        inProgressCount: allDocs.filter((d) => d.status === 'in_progress').length,
        waitingAdminCount: allDocs.filter((d) => d.status === 'waiting_admin').length,
        resolvedCount: allDocs.filter((d) =>
          ['resolved', 'closed'].includes(d.status),
        ).length,
        urgentActiveCount: allDocs.filter(
          (d) =>
            (d.priority === 'urgent' || d.priority === 'high') &&
            !['resolved', 'closed'].includes(d.status),
        ).length,
      },
    };
  }

  async updateForSuperAdmin(
    actor: VerifiedActor,
    id: string,
    dto: SuperAdminUpdatePlatformTicketDto,
  ) {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Platform ticket not found.');
    }

    const doc = await this.ticketModel.findById(id).exec();
    if (!doc) {
      throw new NotFoundException('Platform ticket not found.');
    }

    const prevStatus = doc.status;
    const nowIso = new Date().toISOString();

    if (dto.priority) doc.priority = dto.priority;
    if (dto.resolutionSummary !== undefined) {
      doc.resolutionSummary = dto.resolutionSummary.trim();
    }
    if (dto.status) {
      doc.status = dto.status;
      if (dto.status === 'resolved' || dto.status === 'closed') {
        doc.resolvedAt = nowIso;
        doc.resolvedByName = actor.name || 'Leadsetu HQ';
      } else {
        doc.resolvedAt = '';
      }
    }

    const nextComments = [...(Array.isArray(doc.comments) ? doc.comments : [])];
    if (dto.replyMessage?.trim()) {
      nextComments.push({
        id: `pc-${Date.now()}-${randomBytes(2).toString('hex')}`,
        authorName: actor.name || 'Leadsetu Super Admin',
        authorRole: 'super_admin',
        message: dto.replyMessage.trim(),
        createdAt: nowIso,
      });
    } else if (dto.status && dto.status !== prevStatus) {
      nextComments.push({
        id: `pc-${Date.now()}-${randomBytes(2).toString('hex')}`,
        authorName: actor.name || 'Leadsetu Super Admin',
        authorRole: 'system',
        message: `Ticket status updated from ${prevStatus.toUpperCase()} to ${dto.status.toUpperCase()}${
          dto.resolutionSummary?.trim() ? ` — ${dto.resolutionSummary.trim()}` : ''
        }`,
        createdAt: nowIso,
      });
    }
    doc.comments = nextComments;
    await doc.save();

    const shouldNotify =
      Boolean(dto.replyMessage?.trim()) ||
      Boolean(dto.status && dto.status !== prevStatus);

    if (shouldNotify) {
      const statusText = doc.status.replace('_', ' ').toUpperCase();
      const title =
        doc.status === 'resolved'
          ? `HQ Ticket ${doc.ticketNumber} Resolved ✓`
          : `HQ Update on ${doc.ticketNumber} (${statusText})`;
      const excerpt =
        dto.replyMessage?.trim() ||
        doc.resolutionSummary ||
        `Leadsetu HQ updated your ticket "${doc.subject}" to ${statusText}.`;

      await this.notifyWorkspaceAdminsOfUpdate(doc, {
        authorUserId: actor.userId,
        authorName: actor.name || 'Leadsetu HQ',
        title,
        excerpt,
        status: doc.status,
        severity: doc.status === 'resolved' ? 'info' : 'high',
      });
    }

    await this.auditService?.record({
      tenantId: doc.tenantId.toString(),
      actorId: actor.userId,
      actorName: actor.name,
      actorEmail: actor.email,
      actorRole: actor.role,
      action: 'platform_ticket.hq_updated',
      entityType: 'ticket',
      entityId: doc._id.toString(),
      entityLabel: `${doc.ticketNumber} · Acct #${doc.accountId}`,
      summary: `Super Admin updated ${doc.ticketNumber} (${prevStatus} -> ${doc.status})`,
    });

    return this.toSuperAdminDto(doc);
  }
}
