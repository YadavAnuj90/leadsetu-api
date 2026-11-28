import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Model, Types } from 'mongoose';
import { randomBytes } from 'crypto';
import {
  LeadRouting,
  LeadRoutingDocument,
  RepRoutingConfig,
  RoutingDecisionLog,
  RoutingMode,
  TerritoryRoutingRule,
} from './schemas/lead-routing.schema';
import { Lead, LeadDocument } from '../leads/schemas/lead.schema';
import { User, UserDocument } from '../auth/schemas/user.schema';
import { AuditService } from '../audit/audit.module';
import {
  SimulateLeadRoutingDto,
  UpdateLeadRoutingDto,
} from './dto/lead-routing.dto';

export interface RoutingAuthContext {
  userId: string;
  tenantId: string;
  email: string;
  role: string;
}

export interface RoutingResolutionResult {
  assignedUserId: string;
  assignedUserName: string;
  assignedUserEmail: string;
  strategyUsed: RoutingMode | 'fallback_owner';
  ruleName?: string;
  reason: string;
}

export interface RepRuntimeCandidate {
  userId: string;
  name: string;
  email: string;
  role: string;
  userCode: string;
  eligible: boolean;
  availabilityStatus: 'available' | 'away' | 'on_leave';
  availableForLeads: boolean;
  shiftStart: string;
  shiftEnd: string;
  leaveNote: string;
  dailyCap: number;
  territories: string[];
  openLeadsCount: number;
  todayAssignedCount: number;
}

function splitTerritoryTokens(raw?: string | string[]): string[] {
  if (Array.isArray(raw)) {
    return raw.map((t) => String(t).trim()).filter(Boolean);
  }
  return String(raw || '')
    .split(/[,;&/]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

@Injectable()
export class LeadRoutingService {
  constructor(
    @InjectModel(LeadRouting.name)
    private readonly routingModel: Model<LeadRoutingDocument>,
    @InjectModel(Lead.name)
    private readonly leadModel: Model<LeadDocument>,
    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    @Optional() private readonly auditService?: AuditService,
  ) {}

  async verifyAuth(authHeader?: string): Promise<RoutingAuthContext> {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Authorization token is required.');
    }
    const token = authHeader.slice(7).trim();
    const secret =
      this.configService.get<string>('JWT_SECRET') ||
      'leadsetu_super_secret_access_key_2026';
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

  private assertCanManageRouting(auth: RoutingAuthContext) {
    if (auth.role !== 'owner' && auth.role !== 'admin') {
      throw new ForbiddenException(
        'Only Workspace Owners or Admins can modify Smart Lead Routing rules.',
      );
    }
  }

  async ensureConfig(tenantId: string): Promise<LeadRoutingDocument> {
    const tenantObjectId = new Types.ObjectId(tenantId);
    const existing = await this.routingModel
      .findOne({ tenantId: tenantObjectId })
      .exec();
    if (existing) return existing;

    return this.routingModel.create({
      tenantId: tenantObjectId,
      enabled: true,
      mode: 'round_robin',
      applyToSources: [
        'indiamart',
        'justdial',
        'meta_ads',
        'google_ads',
        'website',
        'whatsapp',
      ],
      applyOnManualCreate: false,
      respectDailyCap: true,
      defaultDailyCap: 25,
      repConfigs: [],
      rules: [],
      roundRobinCursor: 0,
      recentLogs: [],
    });
  }

  private async buildRepWorkloadSnapshot(
    tenantId: string,
    config: LeadRoutingDocument,
  ): Promise<RepRuntimeCandidate[]> {
    const tenantObjectId = new Types.ObjectId(tenantId);
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const [users, openCounts, todayCounts] = await Promise.all([
      this.userModel
        .find({ tenantId: tenantObjectId, isActive: { $ne: false } })
        .sort({ _id: 1 })
        .exec(),
      this.leadModel
        .aggregate<{ _id: Types.ObjectId; count: number }>([
          {
            $match: {
              tenantId: tenantObjectId,
              status: { $nin: ['converted', 'lost'] },
            },
          },
          { $group: { _id: '$ownerId', count: { $sum: 1 } } },
        ])
        .exec(),
      this.leadModel
        .aggregate<{ _id: Types.ObjectId; count: number }>([
          {
            $match: {
              tenantId: tenantObjectId,
              createdAt: { $gte: startOfToday },
            },
          },
          { $group: { _id: '$ownerId', count: { $sum: 1 } } },
        ])
        .exec(),
    ]);

    const openMap = new Map(openCounts.map((r) => [String(r._id), r.count]));
    const todayMap = new Map(todayCounts.map((r) => [String(r._id), r.count]));
    const cfgMap = new Map(
      (config.repConfigs || []).map((rc) => [rc.userId, rc]),
    );

    // If no repConfigs explicitly set yet, default eligible for sales reps/managers if present, else everyone active
    const hasSalesSpecialists = users.some(
      (u) => u.role === 'manager' || u.role === 'agent',
    );

    return users.map((u) => {
      const uid = u._id.toString();
      const saved = cfgMap.get(uid);
      const defaultEligible = hasSalesSpecialists
        ? u.role === 'manager' || u.role === 'agent'
        : true;
      const availabilityStatus =
        u.availabilityStatus === 'away' || u.availabilityStatus === 'on_leave'
          ? u.availabilityStatus
          : 'available';
      return {
        userId: uid,
        name: u.name,
        email: u.email,
        role: u.role,
        userCode: u.userCode || '',
        eligible: saved ? Boolean(saved.eligible) : defaultEligible,
        availabilityStatus,
        availableForLeads: availabilityStatus === 'available',
        shiftStart: u.shiftStart || '09:30',
        shiftEnd: u.shiftEnd || '19:30',
        leaveNote: u.leaveNote || '',
        dailyCap:
          saved && saved.dailyCap !== undefined
            ? Number(saved.dailyCap)
            : Number(config.defaultDailyCap ?? 25),
        territories:
          saved && Array.isArray(saved.territories) && saved.territories.length > 0
            ? saved.territories
            : splitTerritoryTokens(u.territory),
        openLeadsCount: openMap.get(uid) || 0,
        todayAssignedCount: todayMap.get(uid) || 0,
      };
    });
  }

  async getRoutingConfig(auth: RoutingAuthContext) {
    const config = await this.ensureConfig(auth.tenantId);
    const reps = await this.buildRepWorkloadSnapshot(auth.tenantId, config);

    return {
      id: config._id.toString(),
      tenantId: config.tenantId.toString(),
      enabled: Boolean(config.enabled),
      mode: config.mode || 'round_robin',
      applyToSources: config.applyToSources || [],
      applyOnManualCreate: Boolean(config.applyOnManualCreate),
      respectDailyCap: config.respectDailyCap ?? true,
      defaultDailyCap: Number(config.defaultDailyCap ?? 25),
      rules: config.rules || [],
      roundRobinCursor: Number(config.roundRobinCursor || 0),
      reps,
      recentLogs: (config.recentLogs || []).slice(-15).reverse(),
    };
  }

  async updateRoutingConfig(
    auth: RoutingAuthContext,
    dto: UpdateLeadRoutingDto,
  ) {
    this.assertCanManageRouting(auth);
    const config = await this.ensureConfig(auth.tenantId);

    if (dto.enabled !== undefined) config.enabled = Boolean(dto.enabled);
    if (
      dto.mode === 'round_robin' ||
      dto.mode === 'territory_first' ||
      dto.mode === 'load_balanced'
    ) {
      config.mode = dto.mode;
    }
    if (Array.isArray(dto.applyToSources)) {
      config.applyToSources = dto.applyToSources
        .map((s) => String(s).trim().toLowerCase())
        .filter(Boolean);
    }
    if (dto.applyOnManualCreate !== undefined) {
      config.applyOnManualCreate = Boolean(dto.applyOnManualCreate);
    }
    if (dto.respectDailyCap !== undefined) {
      config.respectDailyCap = Boolean(dto.respectDailyCap);
    }
    if (dto.defaultDailyCap !== undefined) {
      config.defaultDailyCap = Math.max(0, Number(dto.defaultDailyCap) || 0);
    }
    if (Array.isArray(dto.repConfigs)) {
      config.repConfigs = dto.repConfigs.map(
        (rc): RepRoutingConfig => ({
          userId: String(rc.userId),
          eligible: Boolean(rc.eligible),
          dailyCap: Math.max(0, Number(rc.dailyCap) || 0),
          territories: splitTerritoryTokens(rc.territories),
        }),
      );
      config.markModified('repConfigs');
    }
    if (Array.isArray(dto.rules)) {
      config.rules = dto.rules.map(
        (r, idx): TerritoryRoutingRule => ({
          id:
            String(r.id || '').trim() ||
            `rule_${Date.now().toString(36)}_${idx}`,
          name: String(r.name || '').trim() || `Routing Rule ${idx + 1}`,
          active: r.active !== false,
          matchCities: splitTerritoryTokens(r.matchCities),
          matchSources: (r.matchSources || [])
            .map((s) => String(s).trim().toLowerCase())
            .filter(Boolean),
          minEstimatedValue: Math.max(0, Number(r.minEstimatedValue) || 0),
          targetUserIds: (r.targetUserIds || [])
            .map((id) => String(id).trim())
            .filter(Boolean),
          strategy: r.strategy === 'load_balanced' ? 'load_balanced' : 'round_robin',
        }),
      );
      config.markModified('rules');
    }

    await config.save();

    await this.auditService?.record({
      tenantId: auth.tenantId,
      actorId: auth.userId,
      actorEmail: auth.email,
      action: 'lead_routing.updated',
      entityType: 'security',
      entityId: config._id.toString(),
      entityLabel: 'Smart Lead Routing Config',
      summary: `Updated lead routing strategy (${config.mode}) · ${config.rules.length} custom rule(s)`,
    });

    return this.getRoutingConfig(auth);
  }

  private matchesCityTokens(city: string, patterns: string[]): boolean {
    const cleanCity = city.trim().toLowerCase();
    if (!cleanCity || patterns.length === 0) return false;
    return patterns.some((pat) => {
      const p = pat.trim().toLowerCase();
      return p.length > 0 && (cleanCity.includes(p) || p.includes(cleanCity));
    });
  }

  async resolveAssigneeForLead(
    tenantId: string,
    input: {
      city?: string;
      source?: string;
      estimatedValue?: number;
      leadId?: string;
      leadName?: string;
      commit?: boolean;
    },
  ): Promise<RoutingResolutionResult> {
    const config = await this.ensureConfig(tenantId);
    const reps = await this.buildRepWorkloadSnapshot(tenantId, config);

    if (reps.length === 0) {
      throw new BadRequestException('No active users available inside workspace.');
    }

    const city = String(input.city || '').trim();
    const source = String(input.source || 'website').trim().toLowerCase();
    const estValue = Number(input.estimatedValue || 0) || 0;

    let pool = reps.filter((r) => r.eligible && r.availableForLeads);
    if (pool.length === 0) {
      pool = reps.filter((r) => r.eligible);
    }
    if (pool.length === 0) {
      pool = reps.filter((r) => r.availableForLeads);
    }
    if (pool.length === 0) {
      pool = reps;
    }

    let strategyUsed: RoutingMode | 'fallback_owner' = config.mode || 'round_robin';
    let ruleName: string | undefined;
    let reason = '';

    // 1. Evaluate explicit priority rules first
    let candidates: RepRuntimeCandidate[] = [];
    for (const rule of config.rules || []) {
      if (!rule.active || rule.targetUserIds.length === 0) continue;
      const cityOk =
        rule.matchCities.length === 0 ||
        this.matchesCityTokens(city, rule.matchCities);
      const sourceOk =
        rule.matchSources.length === 0 || rule.matchSources.includes(source);
      const valueOk =
        !rule.minEstimatedValue || estValue >= rule.minEstimatedValue;

      if (cityOk && sourceOk && valueOk) {
        const matchedTargets = pool.filter((r) =>
          rule.targetUserIds.includes(r.userId),
        );
        if (matchedTargets.length > 0) {
          candidates = matchedTargets;
          strategyUsed = rule.strategy;
          ruleName = rule.name;
          reason = `Matched priority rule "${rule.name}" (${rule.strategy.replace('_', ' ')})`;
          break;
        }
      }
    }

    // 2. If no custom rule matched & mode is territory_first, match rep territory labels
    if (candidates.length === 0 && config.mode === 'territory_first' && city) {
      const territoryMatched = pool.filter((r) =>
        this.matchesCityTokens(city, r.territories),
      );
      if (territoryMatched.length > 0) {
        candidates = territoryMatched;
        strategyUsed = 'territory_first';
        reason = `Matched territory "${city}" (${territoryMatched.length} rep(s) in region)`;
      }
    }

    if (candidates.length === 0) {
      candidates = pool;
      if (!reason) {
        reason =
          strategyUsed === 'load_balanced'
            ? 'Load-balanced by lowest open leads & daily capacity'
            : 'Rotated across active eligible sales team via Round-Robin';
      }
    }

    // 3. Enforce daily cap cleanly (if everyone capped, gracefully fall back to least-loaded in candidates)
    let underCap = candidates;
    if (config.respectDailyCap) {
      const available = candidates.filter(
        (c) => c.dailyCap === 0 || c.todayAssignedCount < c.dailyCap,
      );
      if (available.length > 0) {
        underCap = available;
      } else {
        reason += ' · All reps hit daily cap, assigned to least-loaded rep';
      }
    }

    // 4. Select winning rep
    let chosen: RepRuntimeCandidate;
    const cursor = Number(config.roundRobinCursor || 0);

    if (strategyUsed === 'load_balanced') {
      const sorted = [...underCap].sort((a, b) => {
        if (a.openLeadsCount !== b.openLeadsCount) {
          return a.openLeadsCount - b.openLeadsCount;
        }
        if (a.todayAssignedCount !== b.todayAssignedCount) {
          return a.todayAssignedCount - b.todayAssignedCount;
        }
        return a.name.localeCompare(b.name);
      });
      chosen = sorted[0];
      reason = `${reason} (${chosen.openLeadsCount} open, ${chosen.todayAssignedCount}/${chosen.dailyCap || '∞'} today)`;
    } else {
      chosen = underCap[cursor % underCap.length];
    }

    if (input.commit) {
      const logEntry: RoutingDecisionLog = {
        id: randomBytes(6).toString('hex'),
        leadId: input.leadId,
        leadName: input.leadName || 'Inbound Lead',
        source,
        city: city || '',
        estimatedValue: estValue,
        assignedUserId: chosen.userId,
        assignedUserName: chosen.name,
        strategyUsed,
        ruleName,
        assignedAt: new Date().toISOString(),
      };

      const nextLogs = [...(config.recentLogs || []), logEntry].slice(-25);
      config.roundRobinCursor = cursor + 1;
      config.recentLogs = nextLogs;
      config.markModified('recentLogs');
      await config.save();
    }

    return {
      assignedUserId: chosen.userId,
      assignedUserName: chosen.name,
      assignedUserEmail: chosen.email,
      strategyUsed,
      ruleName,
      reason,
    };
  }

  async simulateRouting(
    auth: RoutingAuthContext,
    dto: SimulateLeadRoutingDto,
  ) {
    return this.resolveAssigneeForLead(auth.tenantId, {
      city: dto.city,
      source: dto.source,
      estimatedValue: dto.estimatedValue,
      commit: false,
    });
  }
}
