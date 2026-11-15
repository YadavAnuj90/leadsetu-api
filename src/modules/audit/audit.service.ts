import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import {
  InjectConnection,
  InjectModel,
  Prop,
  Schema,
  SchemaFactory,
} from '@nestjs/mongoose';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Connection, HydratedDocument, Model, Types } from 'mongoose';
import {
  AuditAuthContext,
  AuditEntityType,
  RecordAuditInput,
  UpdateSecuritySettingsDto,
} from './dto/audit.dto';
import { SuperAdminService } from '../super-admin/super-admin.service';

export type AuditLogDocument = HydratedDocument<AuditLog>;

@Schema({ timestamps: true, collection: 'audit_logs' })
export class AuditLog {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  actorId!: Types.ObjectId;

  @Prop({ trim: true, default: 'Workspace User' })
  actorName!: string;

  @Prop({ trim: true, lowercase: true, default: '' })
  actorEmail!: string;

  @Prop({ trim: true, default: '' })
  actorUserCode!: string;

  @Prop({ trim: true, default: 'owner' })
  actorRole!: string;

  @Prop({ required: true, trim: true, index: true })
  action!: string;

  @Prop({
    required: true,
    enum: [
      'security',
      'team',
      'lead',
      'deal',
      'contact',
      'invoice',
      'ticket',
      'document',
    ],
    index: true,
  })
  entityType!: AuditEntityType;

  @Prop({ trim: true, default: '' })
  entityId!: string;

  @Prop({ trim: true, default: '' })
  entityLabel!: string;

  @Prop({ required: true, trim: true })
  summary!: string;

  @Prop({ type: Object, default: {} })
  metadata!: Record<string, unknown>;
}

export const AuditLogSchema = SchemaFactory.createForClass(AuditLog);
AuditLogSchema.index({ tenantId: 1, createdAt: -1 });

@Injectable()
export class AuditService {
  constructor(
    @InjectModel(AuditLog.name) private readonly auditModel: Model<AuditLogDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    @Optional() private readonly superAdminService?: SuperAdminService,
  ) {}

  async verifyAuth(authHeader?: string): Promise<AuditAuthContext> {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Authorization token is required.');
    }
    const token = authHeader.slice(7).trim();
    const secret =
      this.configService.get<string>('JWT_SECRET') ||
      'leadsetu_super_secret_access_key_2026_delhi_ncr';
    let payload: { sub: string; tenantId: string; email: string; role?: string };
    try {
      payload = await this.jwtService.verifyAsync<{
        sub: string;
        tenantId: string;
        email: string;
        role?: string;
      }>(token, { secret });
    } catch {
      throw new UnauthorizedException('Invalid or expired session.');
    }
    await this.superAdminService?.assertFeatureEnabled(
      payload.tenantId,
      'auditShield',
    );
    return {
      userId: payload.sub,
      tenantId: payload.tenantId,
      email: payload.email,
      role: payload.role || 'owner',
    };
  }

  /**
   * Returns whether phone numbers should be masked for the current authenticated viewer.
   * Safe against missing DB / invalid IDs (fails closed to false only if DB is unready).
   */
  async shouldMaskViewerPhones(
    tenantId: string,
    userId: string,
  ): Promise<boolean> {
    try {
      const db = this.connection.db;
      if (
        !db ||
        !Types.ObjectId.isValid(tenantId) ||
        !Types.ObjectId.isValid(userId)
      ) {
        return false;
      }
      const [tenant, user] = await Promise.all([
        db
          .collection('tenants')
          .findOne(
            { _id: new Types.ObjectId(tenantId) },
            { projection: { maskPhoneForAgents: 1 } },
          ),
        db
          .collection('users')
          .findOne(
            { _id: new Types.ObjectId(userId) },
            { projection: { role: 1, maskPhones: 1 } },
          ),
      ]);
      if (!user) return false;
      if (user.maskPhones === true) return true;
      return Boolean(tenant?.maskPhoneForAgents && user.role === 'agent');
    } catch {
      return false;
    }
  }

  /** Non-blocking immutable audit log insert. */
  async record(input: RecordAuditInput): Promise<void> {
    try {
      if (
        !Types.ObjectId.isValid(input.tenantId) ||
        !Types.ObjectId.isValid(input.actorId)
      ) {
        return;
      }

      let actorName = input.actorName?.trim() || '';
      let actorEmail = input.actorEmail?.trim().toLowerCase() || '';
      let actorUserCode = input.actorUserCode?.trim() || '';
      let actorRole = input.actorRole || '';

      if ((!actorName || !actorUserCode || !actorRole) && this.connection.db) {
        const actorDoc = await this.connection.db
          .collection('users')
          .findOne(
            { _id: new Types.ObjectId(input.actorId) },
            { projection: { name: 1, email: 1, userCode: 1, role: 1 } },
          );
        if (actorDoc) {
          actorName = actorName || String(actorDoc.name || '');
          actorEmail = actorEmail || String(actorDoc.email || '');
          actorUserCode = actorUserCode || String(actorDoc.userCode || '');
          actorRole = actorRole || String(actorDoc.role || 'owner');
        }
      }

      await this.auditModel.create({
        tenantId: new Types.ObjectId(input.tenantId),
        actorId: new Types.ObjectId(input.actorId),
        actorName: actorName || actorEmail.split('@')[0] || 'Workspace User',
        actorEmail,
        actorUserCode,
        actorRole: actorRole || 'owner',
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId || '',
        entityLabel: input.entityLabel || '',
        summary: input.summary,
        metadata: input.metadata || {},
      });
    } catch {
      // Never break primary CRM flow if audit logging encounters a transient error
    }
  }

  async getSecuritySettings(auth: AuditAuthContext) {
    const db = this.connection.db;
    if (!db || !Types.ObjectId.isValid(auth.tenantId)) {
      throw new BadRequestException('Workspace not found.');
    }

    const [tenant, viewer] = await Promise.all([
      db
        .collection('tenants')
        .findOne(
          { _id: new Types.ObjectId(auth.tenantId) },
          {
            projection: {
              name: 1,
              accountId: 1,
              maskPhoneForAgents: 1,
              blockAgentExport: 1,
            },
          },
        ),
      Types.ObjectId.isValid(auth.userId)
        ? db
            .collection('users')
            .findOne(
              { _id: new Types.ObjectId(auth.userId) },
              { projection: { role: 1, maskPhones: 1 } },
            )
        : null,
    ]);

    const viewerRole = String(viewer?.role || auth.role || 'owner');
    const maskPhoneForAgents = Boolean(tenant?.maskPhoneForAgents);
    const blockAgentExport =
      tenant?.blockAgentExport === undefined
        ? true
        : Boolean(tenant.blockAgentExport);
    const viewerMasked = Boolean(
      viewer?.maskPhones || (maskPhoneForAgents && viewerRole === 'agent'),
    );

    return {
      accountId: String(tenant?.accountId || ''),
      workspaceName: String(tenant?.name || 'Leadsetu Workspace'),
      maskPhoneForAgents,
      blockAgentExport,
      viewerMasked,
      canEditSecurity: viewerRole === 'owner' || viewerRole === 'admin',
    };
  }

  async updateSecuritySettings(
    auth: AuditAuthContext,
    dto: UpdateSecuritySettingsDto,
  ) {
    const db = this.connection.db;
    if (
      !db ||
      !Types.ObjectId.isValid(auth.tenantId) ||
      !Types.ObjectId.isValid(auth.userId)
    ) {
      throw new BadRequestException('Invalid workspace session.');
    }

    const actor = await db
      .collection('users')
      .findOne({ _id: new Types.ObjectId(auth.userId) });
    if (!actor || (actor.role !== 'owner' && actor.role !== 'admin')) {
      throw new ForbiddenException(
        'Only the workspace owner or admin can update data-leak security settings.',
      );
    }

    const updates: Record<string, boolean> = {};
    if (typeof dto.maskPhoneForAgents === 'boolean') {
      updates.maskPhoneForAgents = dto.maskPhoneForAgents;
    }
    if (typeof dto.blockAgentExport === 'boolean') {
      updates.blockAgentExport = dto.blockAgentExport;
    }

    if (Object.keys(updates).length === 0) {
      return this.getSecuritySettings(auth);
    }

    await db
      .collection('tenants')
      .updateOne({ _id: new Types.ObjectId(auth.tenantId) }, { $set: updates });

    const changesDesc: string[] = [];
    if ('maskPhoneForAgents' in updates) {
      changesDesc.push(
        `Agent Phone Masking ${updates.maskPhoneForAgents ? 'ENABLED' : 'DISABLED'}`,
      );
    }
    if ('blockAgentExport' in updates) {
      changesDesc.push(
        `Agent CSV Export Block ${updates.blockAgentExport ? 'ENABLED' : 'DISABLED'}`,
      );
    }

    await this.record({
      tenantId: auth.tenantId,
      actorId: auth.userId,
      actorName: String(actor.name || ''),
      actorEmail: String(actor.email || ''),
      actorUserCode: String(actor.userCode || ''),
      actorRole: String(actor.role || 'owner'),
      action: 'security.shield_updated',
      entityType: 'security',
      entityId: auth.tenantId,
      entityLabel: 'Anti-Data-Leak Shield',
      summary: changesDesc.join(' · '),
      metadata: updates,
    });

    return this.getSecuritySettings(auth);
  }

  async list(
    auth: AuditAuthContext,
    query: { entityType?: string; search?: string; limit?: string },
  ) {
    const tenantObjectId = new Types.ObjectId(auth.tenantId);
    const db = this.connection.db;
    const viewer =
      db && Types.ObjectId.isValid(auth.userId)
        ? await db
            .collection('users')
            .findOne(
              { _id: new Types.ObjectId(auth.userId) },
              { projection: { role: 1 } },
            )
        : null;
    const viewerRole = String(viewer?.role || auth.role || 'owner');

    const baseScope: Record<string, unknown> = { tenantId: tenantObjectId };
    if (viewerRole === 'agent' && Types.ObjectId.isValid(auth.userId)) {
      baseScope.actorId = new Types.ObjectId(auth.userId);
    }

    const filter: Record<string, unknown> = { ...baseScope };
    if (query.entityType && query.entityType !== 'all') {
      filter.entityType = query.entityType;
    }
    if (query.search?.trim()) {
      const rx = new RegExp(query.search.trim(), 'i');
      filter.$or = [
        { summary: rx },
        { action: rx },
        { actorName: rx },
        { actorEmail: rx },
        { actorUserCode: rx },
        { entityLabel: rx },
      ];
    }

    const limit = Math.min(Math.max(Number(query.limit) || 60, 10), 200);

    const [docs, allScopedDocs, security] = await Promise.all([
      this.auditModel.find(filter).sort({ createdAt: -1 }).limit(limit).exec(),
      this.auditModel.find(baseScope).sort({ createdAt: -1 }).limit(500).exec(),
      this.getSecuritySettings(auth),
    ]);

    return {
      security,
      data: docs.map((d) => {
        const raw = d.toObject() as unknown as { createdAt?: Date };
        return {
          id: d._id.toString(),
          tenantId: d.tenantId.toString(),
          actorId: d.actorId.toString(),
          actorName: d.actorName,
          actorEmail: d.actorEmail,
          actorUserCode: d.actorUserCode,
          actorRole: d.actorRole,
          action: d.action,
          entityType: d.entityType,
          entityId: d.entityId,
          entityLabel: d.entityLabel,
          summary: d.summary,
          metadata: d.metadata || {},
          createdAt: raw.createdAt
            ? new Date(raw.createdAt).toISOString()
            : new Date().toISOString(),
        };
      }),
      stats: {
        total: allScopedDocs.length,
        securityEvents: allScopedDocs.filter((x) => x.entityType === 'security')
          .length,
        teamEvents: allScopedDocs.filter((x) => x.entityType === 'team').length,
        revenueEvents: allScopedDocs.filter((x) =>
          ['lead', 'deal', 'invoice'].includes(x.entityType),
        ).length,
      },
    };
  }
}
