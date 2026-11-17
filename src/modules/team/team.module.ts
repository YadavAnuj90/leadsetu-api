import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Injectable,
  Module,
  NotFoundException,
  Optional,
  Param,
  Patch,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectModel, MongooseModule } from '@nestjs/mongoose';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiProperty,
  ApiPropertyOptional,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Model, Types } from 'mongoose';
import { AuditService } from '../audit/audit.module';
import { PLAN_CATALOG } from '../tenants/tenants.service';
import { DEFAULT_PLAN_MATRIX } from '../super-admin/schemas/platform-config.schema';
import { User, UserDocument, UserSchema } from '../auth/schemas/user.schema';
import {
  Tenant,
  TenantDocument,
  TenantSchema,
} from '../auth/schemas/tenant.schema';
import {
  generateAccountId,
  generateInviteToken,
  generateTemporaryPassword,
  generateUserCode,
  hashSecret,
  isDuplicateKeyError,
  normalizeIndianPhone,
  normalizeUserFeatureAccess,
  USER_FEATURE_KEYS,
  USER_FEATURE_LABELS,
} from '../auth/identity.util';
import { dispatchTeamInviteEmail } from '../auth/email.util';

type Role = 'owner' | 'admin' | 'manager' | 'agent';
type AssignableRole = Exclude<Role, 'owner'>;
const ASSIGNABLE_ROLES: AssignableRole[] = ['admin', 'manager', 'agent'];

/** Collections whose `ownerId` is re-assigned when a member is removed. */
const OWNED_COLLECTIONS = ['leads', 'deals', 'tasks', 'contacts'];

// ─── DTOs ────────────────────────────────────────────────────────────────────

export class AddTeamMemberDto {
  @ApiProperty({ description: 'Full name of the team member', example: 'Rohit Verma' })
  name!: string;

  @ApiProperty({
    description: 'Work email — used as the login ID. Must not already be registered on Leadsetu.',
    example: 'rohit.verma@yadavtraders.in',
  })
  email!: string;

  @ApiProperty({
    description: '10-digit Indian mobile (WhatsApp). Accepts +91 / 0 prefixes; stored as "+91 XXXXX XXXXX".',
    example: '+91 98765 43210',
  })
  phone!: string;

  @ApiPropertyOptional({
    description: 'Role. Only the workspace owner can add an admin.',
    enum: ASSIGNABLE_ROLES,
    default: 'agent',
  })
  role?: AssignableRole;

  @ApiPropertyOptional({
    description: 'Sales territory / city cluster',
    example: 'Noida Sector 62 & Greater Noida',
  })
  territory?: string;

  @ApiPropertyOptional({
    description: 'Monthly revenue target in INR (₹)',
    example: 500000,
    default: 0,
  })
  monthlyTarget?: number;

  @ApiPropertyOptional({
    description:
      'Optional initial password (min 8 chars). If omitted, a temporary password is generated and returned ONCE in the response.',
    example: 'Welcome@2026',
  })
  password?: string;

  @ApiPropertyOptional({
    description: 'Per-feature CRM access toggles assigned to this Sales Manager or User',
    example: { leads: true, deals: true, whatsappCloud: true, gstBilling: false },
  })
  featureAccess?: Record<string, boolean>;

  @ApiPropertyOptional({
    description: 'Whether to dispatch an invite email link upon creation',
    default: true,
  })
  sendInviteEmail?: boolean;

  @ApiPropertyOptional({
    description: 'Per-user daily AI call cap (0 = unlimited within workspace balance)',
    example: 50,
  })
  aiDailyCallLimit?: number;
}

export class UpdateTeamMemberDto {
  @ApiPropertyOptional({ example: 'Rohit Verma' })
  name?: string;

  @ApiPropertyOptional({ example: '+91 98765 43210' })
  phone?: string;

  @ApiPropertyOptional({ enum: ASSIGNABLE_ROLES, example: 'manager' })
  role?: AssignableRole;

  @ApiPropertyOptional({ example: 'Gurugram Udyog Vihar' })
  territory?: string;

  @ApiPropertyOptional({ example: 750000 })
  monthlyTarget?: number;

  @ApiPropertyOptional({
    description: 'Override to hide full client mobile numbers for this member',
    example: true,
  })
  maskPhones?: boolean;

  @ApiPropertyOptional({
    description: 'Updated per-feature CRM module access toggles for this member',
  })
  featureAccess?: Record<string, boolean>;

  @ApiPropertyOptional({
    description: 'Per-user daily AI call cap (0 = unlimited within workspace balance)',
    example: 50,
  })
  aiDailyCallLimit?: number;
}

export class SetMemberStatusDto {
  @ApiProperty({ description: 'true = active, false = deactivated (login blocked)', example: false })
  isActive!: boolean;
}

// ─── Service ─────────────────────────────────────────────────────────────────

interface Actor {
  user: UserDocument;
  tenant: TenantDocument;
}

interface RepPerformance {
  leadsCount: number;
  hotLeads: number;
  convertedLeads: number;
  openPipeline: number;
  wonDeals: number;
  wonRevenue: number;
}

const EMPTY_PERF: RepPerformance = {
  leadsCount: 0,
  hotLeads: 0,
  convertedLeads: 0,
  openPipeline: 0,
  wonDeals: 0,
  wonRevenue: 0,
};

@Injectable()
export class TeamService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(Tenant.name) private readonly tenantModel: Model<TenantDocument>,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    @Optional() private readonly auditService?: AuditService,
  ) {}

  /**
   * Resolves the caller from the JWT *and* the database, so role changes and
   * deactivations take effect on team endpoints immediately (not at token expiry).
   */
  async getActor(authHeader?: string): Promise<Actor> {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Authorization token is required.');
    }
    const secret =
      this.configService.get<string>('JWT_SECRET') ||
      'leadsetu_super_secret_access_key_2026_delhi_ncr';
    let payload: { sub: string; tenantId: string };
    try {
      payload = await this.jwtService.verifyAsync(authHeader.slice(7).trim(), { secret });
    } catch {
      throw new UnauthorizedException('Invalid or expired session.');
    }

    const user = await this.userModel.findById(payload.sub).exec();
    if (!user || !user.isActive || user.tenantId.toString() !== payload.tenantId) {
      throw new UnauthorizedException('Your account is inactive or no longer exists.');
    }
    const tenant = await this.tenantModel.findById(user.tenantId).exec();
    if (!tenant) throw new UnauthorizedException('Workspace not found.');

    if (!tenant.accountId) {
      tenant.accountId = await generateAccountId(this.tenantModel);
      await tenant.save();
    }
    return { user, tenant };
  }

  private canManageTeam(actor: Actor) {
    return actor.user.role === 'owner' || actor.user.role === 'admin';
  }

  /** Owner manages everyone (except themselves); admins manage managers & agents only. */
  private assertCanManageTarget(actor: Actor, target: UserDocument, action: string) {
    if (!this.canManageTeam(actor)) {
      throw new ForbiddenException('Only the workspace owner or an admin can manage the team.');
    }
    if (target._id.equals(actor.user._id)) {
      throw new ForbiddenException(`You cannot ${action} your own account.`);
    }
    if (target.role === 'owner') {
      throw new ForbiddenException(`The workspace owner cannot be ${action === 'remove' ? 'removed' : 'modified'} here.`);
    }
    if (target.role === 'admin' && actor.user.role !== 'owner') {
      throw new ForbiddenException('Only the workspace owner can manage admins.');
    }
  }

  private assertRoleAssignable(actor: Actor, role: string) {
    if (!ASSIGNABLE_ROLES.includes(role as AssignableRole)) {
      throw new BadRequestException(`Role must be one of: ${ASSIGNABLE_ROLES.join(', ')}.`);
    }
    if (role === 'admin' && actor.user.role !== 'owner') {
      throw new ForbiddenException('Only the workspace owner can grant the admin role.');
    }
  }

  private async findMember(actor: Actor, id: string) {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Team member not found.');
    const member = await this.userModel
      .findOne({ _id: new Types.ObjectId(id), tenantId: actor.tenant._id })
      .exec();
    if (!member) throw new NotFoundException('Team member not found in your workspace.');
    return member;
  }

  private async assertPhoneFreeInWorkspace(actor: Actor, phone: string, excludeId?: Types.ObjectId) {
    const members = await this.userModel
      .find({ tenantId: actor.tenant._id }, { phone: 1 })
      .lean()
      .exec();
    const clash = members.find(
      (m) =>
        (!excludeId || !m._id.equals(excludeId)) &&
        normalizeIndianPhone(m.phone) === phone,
    );
    if (clash) {
      throw new ConflictException('Another member of this workspace already uses this phone number.');
    }
  }

  private validateTarget(value: unknown) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) {
      throw new BadRequestException('Monthly target must be a positive amount in INR.');
    }
    return Math.round(n);
  }

  private async getPerformance(tenantId: Types.ObjectId) {
    const db = this.userModel.db;
    const perf = new Map<string, RepPerformance>();
    const get = (id: unknown) => {
      const key = String(id);
      if (!perf.has(key)) perf.set(key, { ...EMPTY_PERF });
      return perf.get(key)!;
    };

    try {
      const [leadRows, dealRows] = await Promise.all([
        db
          .collection('leads')
          .aggregate([
            { $match: { tenantId } },
            {
              $group: {
                _id: '$ownerId',
                leadsCount: { $sum: 1 },
                hotLeads: { $sum: { $cond: [{ $eq: ['$aiLabel', 'Hot'] }, 1, 0] } },
                convertedLeads: { $sum: { $cond: [{ $eq: ['$status', 'converted'] }, 1, 0] } },
              },
            },
          ])
          .toArray(),
        db
          .collection('deals')
          .aggregate([
            { $match: { tenantId } },
            {
              $group: {
                _id: '$ownerId',
                openPipeline: {
                  $sum: { $cond: [{ $in: ['$stage', ['won', 'lost']] }, 0, '$value'] },
                },
                wonDeals: { $sum: { $cond: [{ $eq: ['$stage', 'won'] }, 1, 0] } },
                wonRevenue: { $sum: { $cond: [{ $eq: ['$stage', 'won'] }, '$value', 0] } },
              },
            },
          ])
          .toArray(),
      ]);

      for (const r of leadRows) {
        Object.assign(get(r._id), {
          leadsCount: r.leadsCount || 0,
          hotLeads: r.hotLeads || 0,
          convertedLeads: r.convertedLeads || 0,
        });
      }
      for (const r of dealRows) {
        Object.assign(get(r._id), {
          openPipeline: r.openPipeline || 0,
          wonDeals: r.wonDeals || 0,
          wonRevenue: r.wonRevenue || 0,
        });
      }
    } catch {
      // Performance is decorative — never block the team page on it.
    }
    return perf;
  }

  private getWorkspaceFeatureLimits(tenant: TenantDocument): Record<string, boolean> {
    const planFeatures = (DEFAULT_PLAN_MATRIX[tenant.plan]?.features || {}) as Record<string, boolean>;
    const overrides = (tenant.featureOverrides || {}) as Record<string, boolean | undefined>;
    const out: Record<string, boolean> = {};
    for (const key of USER_FEATURE_KEYS) {
      if (overrides[key] === true) out[key] = true;
      else if (overrides[key] === false) out[key] = false;
      else if (key in planFeatures) out[key] = Boolean(planFeatures[key]);
      else out[key] = true;
    }
    return out;
  }

  private toMemberDto(
    m: UserDocument,
    perf?: RepPerformance,
    workspaceLimits?: Record<string, boolean>,
  ) {
    const raw = m.toObject() as unknown as { createdAt?: Date };
    const p = perf || EMPTY_PERF;
    const target = m.monthlyTarget || 0;
    const todayKey = new Date().toISOString().slice(0, 10);
    return {
      id: m._id.toString(),
      userCode: m.userCode || '',
      name: m.name,
      email: m.email,
      phone: m.phone || '',
      role: m.role,
      isActive: m.isActive,
      territory: m.territory || '',
      monthlyTarget: target,
      maskPhones: Boolean(m.maskPhones),
      aiDailyCallLimit: Math.max(0, Number(m.aiDailyCallLimit || 0)),
      aiCallsToday: m.aiCallsDayKey === todayKey ? Math.max(0, Number(m.aiCallsToday || 0)) : 0,
      featureAccess: normalizeUserFeatureAccess(m.featureAccess, m.role, workspaceLimits),
      inviteStatus: m.inviteStatus || 'active',
      inviteSentAt: m.inviteSentAt ? new Date(m.inviteSentAt).toISOString() : null,
      invitedBy: m.invitedBy ? m.invitedBy.toString() : null,
      lastLoginAt: m.lastLoginAt ? new Date(m.lastLoginAt).toISOString() : null,
      createdAt: raw.createdAt ? new Date(raw.createdAt).toISOString() : null,
      performance: {
        ...p,
        targetAchievedPct: target > 0 ? Math.min(999, Math.round((p.wonRevenue / target) * 100)) : 0,
      },
    };
  }

  async list(actor: Actor, query: { search?: string; role?: string; status?: string }) {
    const tenantId = actor.tenant._id as Types.ObjectId;
    const workspaceLimits = this.getWorkspaceFeatureLimits(actor.tenant);

    // Back-fill 10-digit user IDs for members created before Module 10.
    const missing = await this.userModel
      .find({ tenantId, $or: [{ userCode: { $exists: false } }, { userCode: null }, { userCode: '' }] })
      .exec();
    for (const m of missing) {
      m.userCode = await generateUserCode(this.userModel);
      await m.save();
    }

    const filter: Record<string, unknown> = { tenantId };
    if (query.role && query.role !== 'all') filter.role = query.role;
    if (query.status === 'active') filter.isActive = true;
    if (query.status === 'inactive') filter.isActive = false;
    if (query.search?.trim()) {
      const safe = query.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(safe, 'i');
      filter.$or = [{ name: regex }, { email: regex }, { phone: regex }, { userCode: regex }, { territory: regex }];
    }

    const [members, all, perf] = await Promise.all([
      this.userModel.find(filter).sort({ createdAt: 1 }).exec(),
      this.userModel.find({ tenantId }).exec(),
      this.getPerformance(tenantId),
    ]);

    const owner = all.find((m) => m.role === 'owner');
    const byRole = (r: Role) => all.filter((m) => m.role === r).length;

    return {
      account: {
        accountId: actor.tenant.accountId,
        name: actor.tenant.name,
        plan: actor.tenant.plan,
        status: actor.tenant.status,
        city: actor.tenant.city || 'Delhi-NCR',
        maskPhoneForAgents: Boolean(actor.tenant.maskPhoneForAgents),
        blockAgentExport: actor.tenant.blockAgentExport ?? true,
        ownerName: owner?.name || '',
        ownerEmail: owner?.email || '',
        workspaceFeatures: workspaceLimits,
      },
      viewer: {
        id: actor.user._id.toString(),
        role: actor.user.role,
        canManageTeam: this.canManageTeam(actor),
        canManageAdmins: actor.user.role === 'owner',
      },
      data: members.map((m) =>
        this.toMemberDto(m, perf.get(m._id.toString()), workspaceLimits),
      ),
      stats: {
        totalMembers: all.length,
        activeMembers: all.filter((m) => m.isActive).length,
        inactiveMembers: all.filter((m) => !m.isActive).length,
        owners: byRole('owner'),
        admins: byRole('admin'),
        managers: byRole('manager'),
        agents: byRole('agent'),
        totalMonthlyTarget: all.reduce((s, m) => s + (m.monthlyTarget || 0), 0),
        totalWonRevenue: all.reduce((s, m) => s + (perf.get(m._id.toString())?.wonRevenue || 0), 0),
      },
    };
  }

  async add(actor: Actor, dto: AddTeamMemberDto) {
    if (!this.canManageTeam(actor)) {
      throw new ForbiddenException('Only the workspace owner or an admin can add team members.');
    }
    const name = dto.name?.trim();
    const email = dto.email?.trim().toLowerCase();
    if (!name) throw new BadRequestException('Member name is required.');
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new BadRequestException('A valid email address is required.');
    }
    const phone = normalizeIndianPhone(dto.phone);
    if (!phone) {
      throw new BadRequestException('A valid 10-digit Indian mobile number is required (e.g. 98765 43210).');
    }
    const role = dto.role || 'agent';
    this.assertRoleAssignable(actor, role);

    if (dto.password !== undefined && dto.password !== '' && dto.password.length < 8) {
      throw new BadRequestException('Initial password must be at least 8 characters.');
    }

    if (await this.userModel.exists({ email })) {
      throw new ConflictException('This email is already registered with a Leadsetu account.');
    }
    await this.assertPhoneFreeInWorkspace(actor, phone);

    // Enforce plan or Super Admin seat cap override
    const seatCap =
      (typeof actor.tenant.seatLimitOverride === 'number' && actor.tenant.seatLimitOverride > 0
        ? actor.tenant.seatLimitOverride
        : PLAN_CATALOG[actor.tenant.plan]?.seatLimit) || 12;
    const currentMemberCount = await this.userModel
      .countDocuments({ tenantId: actor.tenant._id })
      .exec();
    if (currentMemberCount >= seatCap) {
      throw new ForbiddenException(
        `Seat limit reached (${currentMemberCount}/${seatCap} seats on ${actor.tenant.plan} plan). Upgrade your workspace plan in Company Settings -> Plan & Billing.`,
      );
    }

    const generated = !dto.password;
    const password = dto.password || generateTemporaryPassword();
    const workspaceLimits = this.getWorkspaceFeatureLimits(actor.tenant);
    const featureAccess = normalizeUserFeatureAccess(
      dto.featureAccess,
      role,
      workspaceLimits,
    );
    const invite = generateInviteToken();
    const inviteExpiresAt = new Date(Date.now() + 7 * 86400000);
    const frontendBase = (
      this.configService.get<string>('FRONTEND_URL') || 'http://localhost:3000'
    ).replace(/\/+$/, '');
    const inviteUrl = `${frontendBase}/invite?token=${invite.rawToken}&email=${encodeURIComponent(email)}`;

    // Retry on the (very unlikely) race where two requests pick the same user ID.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const member = await this.userModel.create({
          tenantId: actor.tenant._id,
          userCode: await generateUserCode(this.userModel),
          name,
          email,
          phone,
          passwordHash: hashSecret(password),
          role,
          featureAccess,
          inviteTokenHash: invite.tokenHash,
          inviteExpiresAt,
          inviteSentAt: new Date(),
          inviteStatus: 'pending',
          isActive: true,
          territory: dto.territory?.trim() || '',
          monthlyTarget: dto.monthlyTarget !== undefined ? this.validateTarget(dto.monthlyTarget) : 0,
          aiDailyCallLimit:
            dto.aiDailyCallLimit !== undefined
              ? Math.max(0, Math.min(100000, Math.round(Number(dto.aiDailyCallLimit) || 0)))
              : 0,
          invitedBy: actor.user._id,
        });
        const emailDispatch =
          dto.sendInviteEmail === false
            ? {
                sent: false,
                provider: 'preview' as const,
                inviteUrl,
                emailSubject: `Invite for ${member.name}`,
                emailPreview: inviteUrl,
              }
            : await dispatchTeamInviteEmail({
                toEmail: email,
                memberName: name,
                role,
                userCode: member.userCode || '',
                accountId: actor.tenant.accountId || '',
                workspaceName: actor.tenant.name,
                inviterName: actor.user.name,
                inviteUrl,
                temporaryPassword: generated ? password : null,
                featureAccess,
              });
        const enabledNames = USER_FEATURE_KEYS.filter((k) => featureAccess[k]).map(
          (k) => USER_FEATURE_LABELS[k],
        );
        await this.auditService?.record({
          tenantId: actor.tenant._id.toString(),
          actorId: actor.user._id.toString(),
          actorName: actor.user.name,
          actorEmail: actor.user.email,
          actorUserCode: actor.user.userCode,
          actorRole: actor.user.role,
          action: 'team.member_added',
          entityType: 'team',
          entityId: member._id.toString(),
          entityLabel: `${member.name} (UID #${member.userCode})`,
          summary: `Invited team member ${member.name} as ${member.role.toUpperCase()} (${email}) with ${enabledNames.length} modules`,
        });
        return {
          member: this.toMemberDto(member, undefined, workspaceLimits),
          credentials: {
            accountId: actor.tenant.accountId,
            userCode: member.userCode,
            loginEmail: email,
            // Returned exactly once; it is only stored as a hash.
            temporaryPassword: generated ? password : null,
            inviteUrl,
            emailSent: emailDispatch.sent,
            emailProvider: emailDispatch.provider,
            emailSubject: emailDispatch.emailSubject,
            emailPreview: emailDispatch.emailPreview,
          },
        };
      } catch (err) {
        if (isDuplicateKeyError(err, 'userCode')) continue;
        if (isDuplicateKeyError(err, 'email')) {
          throw new ConflictException('This email is already registered with a Leadsetu account.');
        }
        throw err;
      }
    }
    throw new ConflictException('Could not allocate a unique user ID. Please retry.');
  }

  async update(actor: Actor, id: string, dto: UpdateTeamMemberDto) {
    const member = await this.findMember(actor, id);
    const isSelf = member._id.equals(actor.user._id);

    // Members may edit their own name/phone/territory; everything else needs manage rights.
    const touchesPrivileged =
      dto.role !== undefined ||
      dto.monthlyTarget !== undefined ||
      dto.maskPhones !== undefined ||
      dto.featureAccess !== undefined ||
      dto.aiDailyCallLimit !== undefined;
    if (!isSelf || touchesPrivileged) {
      if (isSelf && dto.role !== undefined) {
        throw new ForbiddenException('You cannot change your own role.');
      }
      if (isSelf) {
        if (!this.canManageTeam(actor)) {
          throw new ForbiddenException('Only the owner or an admin can change targets, features, or masking.');
        }
      } else {
        this.assertCanManageTarget(actor, member, 'modify');
      }
    }

    const prevRole = member.role;
    const prevMask = Boolean(member.maskPhones);
    const workspaceLimits = this.getWorkspaceFeatureLimits(actor.tenant);

    if (dto.name !== undefined) {
      if (!dto.name.trim()) throw new BadRequestException('Name cannot be empty.');
      member.name = dto.name.trim();
    }
    if (dto.phone !== undefined) {
      const phone = normalizeIndianPhone(dto.phone);
      if (!phone) throw new BadRequestException('A valid 10-digit Indian mobile number is required.');
      await this.assertPhoneFreeInWorkspace(actor, phone, member._id);
      member.phone = phone;
    }
    if (dto.role !== undefined) {
      this.assertRoleAssignable(actor, dto.role);
      member.role = dto.role;
    }
    if (dto.territory !== undefined) member.territory = dto.territory.trim();
    if (dto.monthlyTarget !== undefined) member.monthlyTarget = this.validateTarget(dto.monthlyTarget);
    if (dto.maskPhones !== undefined) member.maskPhones = Boolean(dto.maskPhones);
    if (dto.aiDailyCallLimit !== undefined) {
      member.aiDailyCallLimit = Math.max(
        0,
        Math.min(100000, Math.round(Number(dto.aiDailyCallLimit) || 0)),
      );
    }
    if (dto.featureAccess !== undefined) {
      member.featureAccess = normalizeUserFeatureAccess(
        dto.featureAccess,
        member.role,
        workspaceLimits,
      );
      member.markModified('featureAccess');
    }

    await member.save();
    if (dto.featureAccess !== undefined) {
      const enabledCount = USER_FEATURE_KEYS.filter(
        (k) => (member.featureAccess || {})[k] !== false,
      ).length;
      await this.auditService?.record({
        tenantId: actor.tenant._id.toString(),
        actorId: actor.user._id.toString(),
        actorName: actor.user.name,
        actorEmail: actor.user.email,
        actorUserCode: actor.user.userCode,
        actorRole: actor.user.role,
        action: 'team.features_updated',
        entityType: 'team',
        entityId: member._id.toString(),
        entityLabel: `${member.name} (UID #${member.userCode})`,
        summary: `Updated CRM feature access for ${member.name} (${member.role.toUpperCase()}): ${enabledCount}/${USER_FEATURE_KEYS.length} modules enabled`,
      });
    }
    if (dto.role !== undefined && dto.role !== prevRole) {
      await this.auditService?.record({
        tenantId: actor.tenant._id.toString(),
        actorId: actor.user._id.toString(),
        actorName: actor.user.name,
        actorEmail: actor.user.email,
        actorUserCode: actor.user.userCode,
        actorRole: actor.user.role,
        action: 'team.role_changed',
        entityType: 'team',
        entityId: member._id.toString(),
        entityLabel: `${member.name} (UID #${member.userCode})`,
        summary: `Changed role for ${member.name}: ${prevRole.toUpperCase()} -> ${member.role.toUpperCase()}`,
      });
    }
    if (dto.maskPhones !== undefined && Boolean(dto.maskPhones) !== prevMask) {
      await this.auditService?.record({
        tenantId: actor.tenant._id.toString(),
        actorId: actor.user._id.toString(),
        actorName: actor.user.name,
        actorEmail: actor.user.email,
        actorUserCode: actor.user.userCode,
        actorRole: actor.user.role,
        action: 'security.member_mask_toggled',
        entityType: 'security',
        entityId: member._id.toString(),
        entityLabel: `${member.name} (UID #${member.userCode})`,
        summary: `Per-user phone masking ${member.maskPhones ? 'ENABLED' : 'DISABLED'} for ${member.name}`,
      });
    }
    const perf = await this.getPerformance(actor.tenant._id as Types.ObjectId);
    return this.toMemberDto(member, perf.get(member._id.toString()), workspaceLimits);
  }

  async resendInvite(actor: Actor, id: string) {
    const member = await this.findMember(actor, id);
    this.assertCanManageTarget(actor, member, 'resend invite for');

    const workspaceLimits = this.getWorkspaceFeatureLimits(actor.tenant);
    const featureAccess = normalizeUserFeatureAccess(
      member.featureAccess,
      member.role,
      workspaceLimits,
    );
    const invite = generateInviteToken();
    member.inviteTokenHash = invite.tokenHash;
    member.inviteExpiresAt = new Date(Date.now() + 7 * 86400000);
    member.inviteSentAt = new Date();
    if (member.inviteStatus !== 'accepted') {
      member.inviteStatus = 'pending';
    }
    await member.save();

    const frontendBase = (
      this.configService.get<string>('FRONTEND_URL') || 'http://localhost:3000'
    ).replace(/\/+$/, '');
    const inviteUrl = `${frontendBase}/invite?token=${invite.rawToken}&email=${encodeURIComponent(member.email)}`;

    const emailDispatch = await dispatchTeamInviteEmail({
      toEmail: member.email,
      memberName: member.name,
      role: member.role,
      userCode: member.userCode || '',
      accountId: actor.tenant.accountId || '',
      workspaceName: actor.tenant.name,
      inviterName: actor.user.name,
      inviteUrl,
      temporaryPassword: null,
      featureAccess,
    });

    await this.auditService?.record({
      tenantId: actor.tenant._id.toString(),
      actorId: actor.user._id.toString(),
      actorName: actor.user.name,
      actorEmail: actor.user.email,
      actorUserCode: actor.user.userCode,
      actorRole: actor.user.role,
      action: 'team.invite_resent',
      entityType: 'team',
      entityId: member._id.toString(),
      entityLabel: `${member.name} (UID #${member.userCode})`,
      summary: `Sent fresh invite login link to ${member.email}`,
    });

    return {
      member: this.toMemberDto(member, undefined, workspaceLimits),
      credentials: {
        accountId: actor.tenant.accountId,
        userCode: member.userCode,
        loginEmail: member.email,
        temporaryPassword: null,
        inviteUrl,
        emailSent: emailDispatch.sent,
        emailProvider: emailDispatch.provider,
        emailSubject: emailDispatch.emailSubject,
        emailPreview: emailDispatch.emailPreview,
      },
    };
  }

  async setStatus(actor: Actor, id: string, isActive: boolean) {
    if (typeof isActive !== 'boolean') {
      throw new BadRequestException('`isActive` must be true or false.');
    }
    const member = await this.findMember(actor, id);
    this.assertCanManageTarget(actor, member, isActive ? 'activate' : 'deactivate');
    member.isActive = isActive;
    if (!isActive) member.refreshTokenHash = null; // force sign-out on refresh
    await member.save();
    await this.auditService?.record({
      tenantId: actor.tenant._id.toString(),
      actorId: actor.user._id.toString(),
      actorName: actor.user.name,
      actorEmail: actor.user.email,
      actorUserCode: actor.user.userCode,
      actorRole: actor.user.role,
      action: isActive ? 'team.member_activated' : 'team.member_deactivated',
      entityType: 'team',
      entityId: member._id.toString(),
      entityLabel: `${member.name} (UID #${member.userCode})`,
      summary: `${isActive ? 'Activated' : 'Deactivated'} member ${member.name}`,
    });
    return this.toMemberDto(member);
  }

  async resetPassword(actor: Actor, id: string) {
    const member = await this.findMember(actor, id);
    this.assertCanManageTarget(actor, member, 'reset the password of');
    const temporaryPassword = generateTemporaryPassword();
    member.passwordHash = hashSecret(temporaryPassword);
    member.refreshTokenHash = null;
    await member.save();
    await this.auditService?.record({
      tenantId: actor.tenant._id.toString(),
      actorId: actor.user._id.toString(),
      actorName: actor.user.name,
      actorEmail: actor.user.email,
      actorUserCode: actor.user.userCode,
      actorRole: actor.user.role,
      action: 'security.password_reset',
      entityType: 'security',
      entityId: member._id.toString(),
      entityLabel: `${member.name} (UID #${member.userCode})`,
      summary: `Generated new one-time temporary password for ${member.name}`,
    });
    return {
      member: this.toMemberDto(member),
      credentials: {
        accountId: actor.tenant.accountId,
        userCode: member.userCode,
        loginEmail: member.email,
        temporaryPassword,
      },
    };
  }

  async remove(actor: Actor, id: string) {
    const member = await this.findMember(actor, id);
    this.assertCanManageTarget(actor, member, 'remove');

    // Hand the member's records to the workspace owner so nothing is orphaned.
    const owner = await this.userModel
      .findOne({ tenantId: actor.tenant._id, role: 'owner' })
      .exec();
    const newOwnerId = owner?._id || actor.user._id;
    const reassigned: Record<string, number> = {};
    for (const col of OWNED_COLLECTIONS) {
      try {
        const res = await this.userModel.db
          .collection(col)
          .updateMany(
            { tenantId: actor.tenant._id, ownerId: member._id },
            { $set: { ownerId: newOwnerId } },
          );
        reassigned[col] = res.modifiedCount;
      } catch {
        reassigned[col] = 0;
      }
    }

    await this.userModel.deleteOne({ _id: member._id, tenantId: actor.tenant._id }).exec();
    await this.auditService?.record({
      tenantId: actor.tenant._id.toString(),
      actorId: actor.user._id.toString(),
      actorName: actor.user.name,
      actorEmail: actor.user.email,
      actorUserCode: actor.user.userCode,
      actorRole: actor.user.role,
      action: 'team.member_removed',
      entityType: 'team',
      entityId: id,
      entityLabel: `${member.name} (UID #${member.userCode})`,
      summary: `Removed ${member.name} and reassigned CRM records to ${owner?.name || 'Owner'}`,
      metadata: { reassigned },
    });
    return {
      success: true,
      id,
      reassignedTo: owner ? { id: owner._id.toString(), name: owner.name } : null,
      reassigned,
    };
  }

  async getMyPerformance(actor: Actor) {
    const tenantId = actor.tenant._id as Types.ObjectId;
    const perfMap = await this.getPerformance(tenantId);
    const p = perfMap.get(actor.user._id.toString()) || EMPTY_PERF;
    const target = actor.user.monthlyTarget || 0;
    const todayKey = new Date().toISOString().slice(0, 10);
    return {
      userId: actor.user._id.toString(),
      name: actor.user.name,
      role: actor.user.role,
      territory: actor.user.territory || '',
      monthlyTarget: target,
      aiDailyCallLimit: Math.max(0, Number(actor.user.aiDailyCallLimit || 0)),
      aiCallsToday:
        actor.user.aiCallsDayKey === todayKey
          ? Math.max(0, Number(actor.user.aiCallsToday || 0))
          : 0,
      performance: {
        ...p,
        targetAchievedPct:
          target > 0 ? Math.min(999, Math.round((p.wonRevenue / target) * 100)) : 0,
      },
    };
  }

  async getMyTeam(actor: Actor) {
    if (actor.user.role === 'agent') {
      throw new ForbiddenException(
        'Team overview is only available to Sales Managers, Admins, and Owners.',
      );
    }
    const tenantId = actor.tenant._id as Types.ObjectId;
    const workspaceLimits = this.getWorkspaceFeatureLimits(actor.tenant);
    const [allAgents, perfMap, taskCounts] = await Promise.all([
      this.userModel.find({ tenantId, role: 'agent' }).sort({ name: 1 }).exec(),
      this.getPerformance(tenantId),
      this.userModel.db
        .collection('tasks')
        .aggregate<{ _id: Types.ObjectId; pending: number }>([
          { $match: { tenantId, status: { $ne: 'done' } } },
          { $group: { _id: '$ownerId', pending: { $sum: 1 } } },
        ])
        .toArray()
        .catch(() => []),
    ]);

    const taskMap = new Map(taskCounts.map((r) => [String(r._id), r.pending]));
    const mgrTerritory = (actor.user.territory || '').trim().toLowerCase();
    const scoped =
      actor.user.role === 'manager' && mgrTerritory
        ? allAgents.filter((a) => {
            const t = (a.territory || '').trim().toLowerCase();
            return !t || t.includes(mgrTerritory) || mgrTerritory.includes(t);
          })
        : allAgents;

    const reps = scoped.map((m) => {
      const dto = this.toMemberDto(
        m,
        perfMap.get(m._id.toString()),
        workspaceLimits,
      );
      return {
        ...dto,
        pendingTasks: taskMap.get(m._id.toString()) || 0,
      };
    });

    const totalWonRevenue = reps.reduce((s, r) => s + r.performance.wonRevenue, 0);
    const totalOpenPipeline = reps.reduce((s, r) => s + r.performance.openPipeline, 0);
    const avgTargetPct =
      reps.length > 0
        ? Math.round(
            reps.reduce((s, r) => s + r.performance.targetAchievedPct, 0) / reps.length,
          )
        : 0;

    return {
      territory: actor.user.territory || 'All Territories',
      summary: {
        repCount: reps.length,
        totalWonRevenue,
        totalOpenPipeline,
        avgTargetPct,
      },
      data: reps,
    };
  }
}

// ─── Controller ──────────────────────────────────────────────────────────────

@ApiTags('10. Team & Role-Based Access')
@ApiBearerAuth('access-token')
@Controller('team')
export class TeamController {
  constructor(private readonly teamService: TeamService) {}

  @Get()
  @ApiOperation({
    summary:
      'List workspace members with 5-digit account ID, 10-digit user IDs, roles & rep-wise performance',
  })
  @ApiQuery({ name: 'search', required: false, description: 'Name, email, phone, user ID or territory', example: 'Noida' })
  @ApiQuery({ name: 'role', required: false, enum: ['all', 'owner', 'admin', 'manager', 'agent'] })
  @ApiQuery({ name: 'status', required: false, enum: ['all', 'active', 'inactive'] })
  @ApiResponse({ status: 200, description: 'Returns `{ account, viewer, data: TeamMember[], stats }`.' })
  async list(
    @Headers('authorization') authorization: string | undefined,
    @Query() query: { search?: string; role?: string; status?: string },
  ) {
    const actor = await this.teamService.getActor(authorization);
    return this.teamService.list(actor, query);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Add a team member by email + phone (owner/admin only). Generates a unique 10-digit user ID and, unless a password is given, a one-time temporary password.',
  })
  @ApiBody({ type: AddTeamMemberDto })
  @ApiResponse({ status: 201, description: 'Returns `{ member, credentials }`.' })
  @ApiResponse({ status: 409, description: 'Email already registered or phone already used in this workspace.' })
  async add(
    @Headers('authorization') authorization: string | undefined,
    @Body() dto: AddTeamMemberDto,
  ) {
    const actor = await this.teamService.getActor(authorization);
    return this.teamService.add(actor, dto);
  }

  @Get('me/performance')
  @ApiOperation({ summary: 'Get personal monthly target, won revenue, and daily AI call counters for current user' })
  async getMyPerformance(@Headers('authorization') authorization?: string) {
    const actor = await this.teamService.getActor(authorization);
    return this.teamService.getMyPerformance(actor);
  }

  @Get('my-team')
  @ApiOperation({ summary: 'Sales Manager view of reps in their territory with pipeline & target progress' })
  async getMyTeam(@Headers('authorization') authorization?: string) {
    const actor = await this.teamService.getActor(authorization);
    return this.teamService.getMyTeam(actor);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a member’s name, phone, role, territory or monthly target' })
  @ApiParam({ name: 'id', description: 'MongoDB ObjectId of the member', example: '672e1a2b3c4d5e6f7a8b9c0d' })
  @ApiBody({ type: UpdateTeamMemberDto })
  async update(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
    @Body() dto: UpdateTeamMemberDto,
  ) {
    const actor = await this.teamService.getActor(authorization);
    return this.teamService.update(actor, id, dto);
  }

  @Patch(':id/status')
  @ApiOperation({ summary: 'Activate or deactivate a member (deactivated members cannot sign in)' })
  @ApiParam({ name: 'id', description: 'MongoDB ObjectId of the member', example: '672e1a2b3c4d5e6f7a8b9c0d' })
  @ApiBody({ type: SetMemberStatusDto })
  async setStatus(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
    @Body() dto: SetMemberStatusDto,
  ) {
    const actor = await this.teamService.getActor(authorization);
    return this.teamService.setStatus(actor, id, dto.isActive);
  }

  @Post(':id/reset-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Generate a new one-time temporary password for a member' })
  @ApiParam({ name: 'id', description: 'MongoDB ObjectId of the member', example: '672e1a2b3c4d5e6f7a8b9c0d' })
  async resetPassword(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
  ) {
    const actor = await this.teamService.getActor(authorization);
    return this.teamService.resetPassword(actor, id);
  }

  @Post(':id/resend-invite')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Generate a fresh 7-day email invite login link for a member' })
  @ApiParam({ name: 'id', description: 'MongoDB ObjectId of the member', example: '672e1a2b3c4d5e6f7a8b9c0d' })
  async resendInvite(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
  ) {
    const actor = await this.teamService.getActor(authorization);
    return this.teamService.resendInvite(actor, id);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Remove a member; their leads, deals, tasks & contacts are re-assigned to the workspace owner',
  })
  @ApiParam({ name: 'id', description: 'MongoDB ObjectId of the member', example: '672e1a2b3c4d5e6f7a8b9c0d' })
  async remove(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
  ) {
    const actor = await this.teamService.getActor(authorization);
    return this.teamService.remove(actor, id);
  }
}

@Module({
  imports: [
    ConfigModule,
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: Tenant.name, schema: TenantSchema },
    ]),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret:
          config.get<string>('JWT_SECRET') ||
          'leadsetu_super_secret_access_key_2026_delhi_ncr',
      }),
    }),
  ],
  controllers: [TeamController],
  providers: [TeamService],
  exports: [TeamService],
})
export class TeamModule {}
