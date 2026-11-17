import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import axios from 'axios';
import { Model, Types } from 'mongoose';
import { User, UserDocument } from '../auth/schemas/user.schema';
import { Tenant, TenantDocument } from '../auth/schemas/tenant.schema';
import { AuditService } from '../audit/audit.service';
import {
  CallLog,
  CallLogDocument,
  CallLogStatus,
  IcePathType,
} from './schemas/call-log.schema';
import {
  CallTelemetrySample,
  CallTelemetrySampleDocument,
} from './schemas/call-telemetry-sample.schema';
import {
  AgentPresenceStatus,
  CallAuthContext,
  CallTelemetrySnapshotDto,
} from './dto/calls.dto';

export const CALL_RING_TIMEOUT_MS = 30_000;

interface ActiveCallRuntime {
  callId: string;
  tenantId: string;
  callerId: string;
  calleeId: string;
  rttSamples: number[];
}

export interface TenantPresenceItem {
  userId: string;
  name: string;
  role: string;
  userCode: string;
  territory: string;
  status: AgentPresenceStatus;
  inCall: boolean;
}

@Injectable()
export class CallsService {
  /** tenantId -> (userId -> Set<socketId>) */
  private readonly tenantUserSockets = new Map<
    string,
    Map<string, Set<string>>
  >();

  /** `${tenantId}:${userId}` -> manual presence preference while connected */
  private readonly manualPresence = new Map<string, AgentPresenceStatus>();

  /** `${tenantId}:${userId}` -> callId (atomic busy-state lock) */
  private readonly activeCallLocks = new Map<string, string>();

  /** callId -> runtime lock/RTT metadata */
  private readonly runtimeCalls = new Map<string, ActiveCallRuntime>();

  /** callId -> 30s server-side ring timeout handle */
  private readonly ringTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    @InjectModel(CallLog.name)
    private readonly callLogModel: Model<CallLogDocument>,
    @InjectModel(CallTelemetrySample.name)
    private readonly telemetryModel: Model<CallTelemetrySampleDocument>,
    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>,
    @InjectModel(Tenant.name)
    private readonly tenantModel: Model<TenantDocument>,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    @Optional() private readonly auditService?: AuditService,
  ) {}

  private userLockKey(tenantId: string, userId: string): string {
    return `${tenantId}:${userId}`;
  }

  async verifyAuthHeader(authHeader?: string): Promise<CallAuthContext> {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Authorization token is required.');
    }
    return this.verifyRawToken(authHeader.slice(7).trim());
  }

  async verifyRawToken(token?: string): Promise<CallAuthContext> {
    const cleanToken = String(token || '').trim();
    if (!cleanToken) {
      throw new UnauthorizedException('Authentication token is required.');
    }

    const secret =
      this.configService.get<string>('JWT_SECRET') ||
      'leadsetu_super_secret_access_key_2026_delhi_ncr';

    let payload: {
      sub: string;
      tenantId: string;
      email: string;
      role?: string;
      sv?: number;
      tsv?: number;
    };
    try {
      payload = await this.jwtService.verifyAsync(cleanToken, { secret });
    } catch {
      throw new UnauthorizedException('Invalid or expired session.');
    }

    if (
      !Types.ObjectId.isValid(payload.sub) ||
      !Types.ObjectId.isValid(payload.tenantId)
    ) {
      throw new UnauthorizedException('Invalid session identity.');
    }

    const [user, tenant] = await Promise.all([
      this.userModel.findById(payload.sub).exec(),
      this.tenantModel.findById(payload.tenantId).exec(),
    ]);

    if (!user || !user.isActive) {
      throw new UnauthorizedException('Account is inactive or unavailable.');
    }
    if (!tenant || tenant.status === 'suspended') {
      throw new ForbiddenException('Workspace access is currently suspended.');
    }
    if (
      tenant.dpdpRetention?.purgedAt ||
      tenant.dpdpRetention?.softDeletedAt
    ) {
      throw new ForbiddenException('Workspace is queued for archival.');
    }
    if ((payload.sv ?? 1) !== (user.sessionVersion ?? 1)) {
      throw new UnauthorizedException('Session has been revoked.');
    }
    if ((payload.tsv ?? 1) !== (tenant.sessionVersion ?? 1)) {
      throw new UnauthorizedException('Workspace session has been revoked.');
    }

    return {
      userId: user._id.toString(),
      tenantId: tenant._id.toString(),
      email: user.email,
      role: user.role,
      name: user.name,
      userCode: user.userCode || '',
    };
  }

  // ─── Multi-Tab Presence & Atomic Busy-Lock Registry ──────────────────────

  registerSocket(
    tenantId: string,
    userId: string,
    socketId: string,
  ): { isFirstConnection: boolean; activeCallId: string | null } {
    let usersMap = this.tenantUserSockets.get(tenantId);
    if (!usersMap) {
      usersMap = new Map<string, Set<string>>();
      this.tenantUserSockets.set(tenantId, usersMap);
    }
    let sockets = usersMap.get(userId);
    const isFirstConnection = !sockets || sockets.size === 0;
    if (!sockets) {
      sockets = new Set<string>();
      usersMap.set(userId, sockets);
    }
    sockets.add(socketId);

    const key = this.userLockKey(tenantId, userId);
    if (!this.manualPresence.has(key)) {
      this.manualPresence.set(key, 'online');
    }

    return {
      isFirstConnection,
      activeCallId: this.activeCallLocks.get(key) || null,
    };
  }

  unregisterSocket(
    tenantId: string,
    userId: string,
    socketId: string,
  ): {
    remainingSockets: number;
    activeCallId: string | null;
  } {
    const usersMap = this.tenantUserSockets.get(tenantId);
    const sockets = usersMap?.get(userId);
    if (sockets) {
      sockets.delete(socketId);
      if (sockets.size === 0) {
        usersMap?.delete(userId);
      }
    }
    const remainingSockets = sockets?.size || 0;
    const key = this.userLockKey(tenantId, userId);
    if (remainingSockets === 0) {
      this.manualPresence.delete(key);
    }
    return {
      remainingSockets,
      activeCallId: this.activeCallLocks.get(key) || null,
    };
  }

  hasOnlineSockets(tenantId: string, userId: string): boolean {
    const sockets = this.tenantUserSockets.get(tenantId)?.get(userId);
    return Boolean(sockets && sockets.size > 0);
  }

  setManualPresence(
    tenantId: string,
    userId: string,
    status: AgentPresenceStatus,
  ): AgentPresenceStatus {
    const key = this.userLockKey(tenantId, userId);
    this.manualPresence.set(key, status);
    return this.getEffectivePresence(tenantId, userId);
  }

  getEffectivePresence(
    tenantId: string,
    userId: string,
  ): AgentPresenceStatus {
    const key = this.userLockKey(tenantId, userId);
    if (this.activeCallLocks.has(key)) {
      return 'busy';
    }
    if (!this.hasOnlineSockets(tenantId, userId)) {
      return 'offline';
    }
    return this.manualPresence.get(key) || 'online';
  }

  private tryAcquirePairLock(
    tenantId: string,
    callerId: string,
    calleeId: string,
    callId: string,
  ): { ok: true } | { ok: false; reason: 'caller_busy' | 'callee_busy' } {
    const callerKey = this.userLockKey(tenantId, callerId);
    const calleeKey = this.userLockKey(tenantId, calleeId);

    // Synchronous atomic check-and-set on the single Node event loop turn
    if (this.activeCallLocks.has(callerKey)) {
      return { ok: false, reason: 'caller_busy' };
    }
    if (this.activeCallLocks.has(calleeKey)) {
      return { ok: false, reason: 'callee_busy' };
    }

    this.activeCallLocks.set(callerKey, callId);
    this.activeCallLocks.set(calleeKey, callId);
    this.runtimeCalls.set(callId, {
      callId,
      tenantId,
      callerId,
      calleeId,
      rttSamples: [],
    });
    return { ok: true };
  }

  private releaseCallLocks(
    tenantId: string,
    callerId: string,
    calleeId: string,
    callId: string,
  ) {
    const callerKey = this.userLockKey(tenantId, callerId);
    const calleeKey = this.userLockKey(tenantId, calleeId);

    if (this.activeCallLocks.get(callerKey) === callId) {
      this.activeCallLocks.delete(callerKey);
    }
    if (this.activeCallLocks.get(calleeKey) === callId) {
      this.activeCallLocks.delete(calleeKey);
    }

    const timer = this.ringTimers.get(callId);
    if (timer) {
      clearTimeout(timer);
      this.ringTimers.delete(callId);
    }
    this.runtimeCalls.delete(callId);
  }

  setRingTimer(callId: string, onTimeout: () => void) {
    const existing = this.ringTimers.get(callId);
    if (existing) clearTimeout(existing);
    const handle = setTimeout(() => {
      this.ringTimers.delete(callId);
      onTimeout();
    }, CALL_RING_TIMEOUT_MS);
    this.ringTimers.set(callId, handle);
  }

  clearRingTimer(callId: string) {
    const handle = this.ringTimers.get(callId);
    if (handle) {
      clearTimeout(handle);
      this.ringTimers.delete(callId);
    }
  }

  async getTenantPresenceSnapshot(
    tenantId: string,
  ): Promise<TenantPresenceItem[]> {
    const users = await this.userModel
      .find({ tenantId: new Types.ObjectId(tenantId), isActive: true })
      .select({ name: 1, role: 1, userCode: 1, territory: 1 })
      .sort({ name: 1 })
      .exec();

    return users.map((u) => {
      const uid = u._id.toString();
      const status = this.getEffectivePresence(tenantId, uid);
      return {
        userId: uid,
        name: u.name,
        role: u.role,
        userCode: u.userCode || '',
        territory: u.territory || '',
        status,
        inCall: this.activeCallLocks.has(this.userLockKey(tenantId, uid)),
      };
    });
  }

  filterPresenceForViewer(
    snapshot: TenantPresenceItem[],
    auth: { userId: string; role: string },
  ): TenantPresenceItem[] {
    if (['owner', 'admin', 'super_admin'].includes(auth.role)) {
      return snapshot;
    }
    return snapshot.filter((item) => item.userId === auth.userId);
  }

  // ─── Call Lifecycle Operations ───────────────────────────────────────────

  async initiateCall(
    auth: CallAuthContext,
    target: string | { calleeId?: string; calleeUserCode?: string },
  ) {
    const rawCalleeId =
      typeof target === 'string' ? target.trim() : String(target?.calleeId || '').trim();
    const rawUserCode =
      typeof target === 'string'
        ? ''
        : String(target?.calleeUserCode || '').replace(/^#/, '').trim();

    let callee: UserDocument | null = null;
    if (rawCalleeId && Types.ObjectId.isValid(rawCalleeId)) {
      callee = await this.userModel
        .findOne({
          _id: new Types.ObjectId(rawCalleeId),
          tenantId: new Types.ObjectId(auth.tenantId),
          isActive: true,
        })
        .select({ name: 1, role: 1, userCode: 1, territory: 1 })
        .exec();
    } else if (rawUserCode) {
      callee = await this.userModel
        .findOne({
          userCode: rawUserCode,
          tenantId: new Types.ObjectId(auth.tenantId),
          isActive: true,
        })
        .select({ name: 1, role: 1, userCode: 1, territory: 1 })
        .exec();
    } else {
      throw new BadRequestException('Target agent ID or 10-digit UID is required.');
    }

    if (!callee) {
      throw new NotFoundException('Target teammate not found in your workspace.');
    }

    const calleeId = callee._id.toString();
    if (calleeId === auth.userId) {
      throw new BadRequestException('You cannot place a call to yourself.');
    }

    const calleePresence = this.getEffectivePresence(auth.tenantId, calleeId);
    if (calleePresence === 'offline') {
      throw new ConflictException(`${callee.name} is currently offline.`);
    }
    if (calleePresence === 'busy') {
      throw new ConflictException(
        `${callee.name} is currently busy or on another call.`,
      );
    }

    const callObjectId = new Types.ObjectId();
    const callId = callObjectId.toString();
    const lock = this.tryAcquirePairLock(
      auth.tenantId,
      auth.userId,
      calleeId,
      callId,
    );
    if (!lock.ok) {
      throw new ConflictException(
        lock.reason === 'caller_busy'
          ? 'Finish your current call before starting a new one.'
          : `${callee.name} just joined another call.`,
      );
    }

    try {
      const now = new Date();
      const doc = await this.callLogModel.create({
        _id: callObjectId,
        tenantId: new Types.ObjectId(auth.tenantId),
        callerId: new Types.ObjectId(auth.userId),
        calleeId: new Types.ObjectId(calleeId),
        callerName: auth.name,
        callerRole: auth.role,
        callerUserCode: auth.userCode,
        calleeName: callee.name,
        calleeRole: callee.role,
        calleeUserCode: callee.userCode || '',
        status: 'ringing',
        startedAt: now,
        setupTimeMs: 0,
        durationSeconds: 0,
      });

      return {
        call: this.toDto(doc, auth.userId),
        callee: {
          userId: callee._id.toString(),
          name: callee.name,
          role: callee.role,
          userCode: callee.userCode || '',
          territory: callee.territory || '',
        },
        caller: {
          userId: auth.userId,
          name: auth.name,
          role: auth.role,
          userCode: auth.userCode,
        },
      };
    } catch (err) {
      this.releaseCallLocks(auth.tenantId, auth.userId, calleeId, callId);
      throw err;
    }
  }

  async markRingTimeout(callId: string) {
    if (!Types.ObjectId.isValid(callId)) return null;
    const now = new Date();
    const doc = await this.callLogModel
      .findOneAndUpdate(
        { _id: new Types.ObjectId(callId), status: 'ringing' },
        {
          $set: {
            status: 'timeout',
            endedAt: now,
            endReason: 'No answer within 30 seconds',
          },
        },
        { new: true },
      )
      .exec();

    if (!doc) return null;

    this.releaseCallLocks(
      doc.tenantId.toString(),
      doc.callerId.toString(),
      doc.calleeId.toString(),
      callId,
    );
    return doc;
  }

  async acceptCall(auth: CallAuthContext, callId: string) {
    if (!Types.ObjectId.isValid(callId)) {
      throw new BadRequestException('Invalid call ID.');
    }
    const now = new Date();
    const doc = await this.callLogModel
      .findOneAndUpdate(
        {
          _id: new Types.ObjectId(callId),
          tenantId: new Types.ObjectId(auth.tenantId),
          calleeId: new Types.ObjectId(auth.userId),
          status: 'ringing',
        },
        {
          $set: {
            status: 'connecting',
            answeredAt: now,
          },
        },
        { new: true },
      )
      .exec();

    if (!doc) {
      throw new ConflictException(
        'Call is no longer ringing or was already answered.',
      );
    }

    this.clearRingTimer(callId);
    return doc;
  }

  async rejectCall(auth: CallAuthContext, callId: string) {
    if (!Types.ObjectId.isValid(callId)) {
      throw new BadRequestException('Invalid call ID.');
    }
    const now = new Date();
    const doc = await this.callLogModel
      .findOneAndUpdate(
        {
          _id: new Types.ObjectId(callId),
          tenantId: new Types.ObjectId(auth.tenantId),
          calleeId: new Types.ObjectId(auth.userId),
          status: 'ringing',
        },
        {
          $set: {
            status: 'rejected',
            endedAt: now,
            endedByUserId: auth.userId,
            endReason: 'Declined by recipient',
          },
        },
        { new: true },
      )
      .exec();

    if (!doc) {
      throw new ConflictException('Call is no longer waiting for response.');
    }

    this.releaseCallLocks(
      doc.tenantId.toString(),
      doc.callerId.toString(),
      doc.calleeId.toString(),
      callId,
    );
    return doc;
  }

  async markMediaConnected(auth: CallAuthContext, callId: string) {
    if (!Types.ObjectId.isValid(callId)) {
      throw new BadRequestException('Invalid call ID.');
    }
    const doc = await this.assertParticipant(auth, callId);
    if (doc.status === 'connected') {
      return doc;
    }
    if (!['connecting', 'ringing'].includes(doc.status)) {
      return doc;
    }

    const now = new Date();
    const baseline = doc.answeredAt || doc.startedAt || now;
    const setupTimeMs = Math.max(0, now.getTime() - new Date(baseline).getTime());

    doc.status = 'connected';
    doc.connectedAt = now;
    if (!doc.answeredAt) doc.answeredAt = now;
    doc.setupTimeMs = setupTimeMs;
    await doc.save();
    return doc;
  }

  async endCall(
    auth: CallAuthContext,
    callId: string,
    params?: {
      reason?: string;
      failed?: boolean;
      finalTelemetry?: CallTelemetrySnapshotDto;
    },
  ) {
    if (!Types.ObjectId.isValid(callId)) {
      throw new BadRequestException('Invalid call ID.');
    }
    const doc = await this.assertParticipant(auth, callId);
    const terminalStatuses: CallLogStatus[] = [
      'completed',
      'rejected',
      'missed',
      'cancelled',
      'timeout',
      'failed',
    ];
    if (terminalStatuses.includes(doc.status)) {
      this.releaseCallLocks(
        doc.tenantId.toString(),
        doc.callerId.toString(),
        doc.calleeId.toString(),
        callId,
      );
      return doc;
    }

    if (params?.finalTelemetry) {
      await this.recordTelemetrySample(auth, callId, params.finalTelemetry).catch(
        () => null,
      );
    }

    const refreshed = await this.callLogModel.findById(doc._id).exec();
    const target = refreshed || doc;
    const now = new Date();
    const wasAnswered = Boolean(target.connectedAt || target.answeredAt);

    let nextStatus: CallLogStatus = 'completed';
    if (params?.failed) {
      nextStatus = 'failed';
    } else if (!wasAnswered) {
      nextStatus =
        target.callerId.toString() === auth.userId ? 'cancelled' : 'missed';
    }

    const mediaStart = target.connectedAt || target.answeredAt;
    const durationSeconds =
      mediaStart && nextStatus === 'completed'
        ? Math.max(
            0,
            Math.round((now.getTime() - new Date(mediaStart).getTime()) / 1000),
          )
        : 0;

    target.status = nextStatus;
    target.endedAt = now;
    target.durationSeconds = durationSeconds;
    target.endedByUserId = auth.userId;
    target.endReason =
      params?.reason?.trim() ||
      (nextStatus === 'completed'
        ? 'Call ended'
        : nextStatus === 'cancelled'
          ? 'Caller cancelled before answer'
          : nextStatus === 'failed'
            ? 'WebRTC media connection failed'
            : 'Call ended');

    if (params?.failed && !target.connection?.iceFailureReason) {
      target.connection = {
        ...target.connection,
        icePath: 'failed',
        iceFailureReason: params.reason || 'ICE connectivity failed',
      };
    }

    await target.save();
    this.releaseCallLocks(
      target.tenantId.toString(),
      target.callerId.toString(),
      target.calleeId.toString(),
      callId,
    );

    if (nextStatus === 'completed' || nextStatus === 'failed') {
      await this.auditService?.record({
        tenantId: target.tenantId.toString(),
        actorId: auth.userId,
        actorName: auth.name,
        actorEmail: auth.email,
        actorRole: auth.role,
        action: nextStatus === 'failed' ? 'call.failed' : 'call.completed',
        entityType: 'security',
        entityId: target._id.toString(),
        entityLabel: `${target.callerName} → ${target.calleeName}`,
        summary: `CRM voice call ${nextStatus} (${durationSeconds}s, ${target.connection?.icePath || 'direct'})`,
      });
    }

    return target;
  }

  async endActiveCallOnDisconnect(
    tenantId: string,
    userId: string,
    callId: string,
  ) {
    const user = await this.userModel.findById(userId).exec();
    if (!user) return null;
    const auth: CallAuthContext = {
      userId,
      tenantId,
      email: user.email,
      role: user.role,
      name: user.name,
      userCode: user.userCode || '',
    };
    return this.endCall(auth, callId, {
      reason: 'Agent disconnected',
    }).catch(() => null);
  }

  async assertParticipant(auth: CallAuthContext, callId: string) {
    if (!Types.ObjectId.isValid(callId)) {
      throw new NotFoundException('Call record not found.');
    }
    const doc = await this.callLogModel
      .findOne({
        _id: new Types.ObjectId(callId),
        tenantId: new Types.ObjectId(auth.tenantId),
      })
      .exec();

    if (!doc) {
      throw new NotFoundException('Call session not found.');
    }

    const isParticipant =
      doc.callerId.toString() === auth.userId ||
      doc.calleeId.toString() === auth.userId;
    if (!isParticipant) {
      throw new ForbiddenException('You are not a participant of this call.');
    }
    return doc;
  }

  // ─── Telemetry Sampling & Selected-Pair Aggregation ──────────────────────

  async recordTelemetrySample(
    auth: CallAuthContext,
    callId: string,
    dto: CallTelemetrySnapshotDto,
  ) {
    const doc = await this.assertParticipant(auth, callId);

    const localType = String(dto.localCandidateType || '').trim();
    const remoteType = String(dto.remoteCandidateType || '').trim();
    const inferredTurn =
      Boolean(dto.turnUsed) ||
      localType === 'relay' ||
      remoteType === 'relay' ||
      dto.icePath === 'turn_relay';
    const icePath: IcePathType =
      dto.icePath === 'failed'
        ? 'failed'
        : inferredTurn
          ? 'turn_relay'
          : 'direct';

    const rttMs = Math.max(0, Math.round(Number(dto.rttMs) || 0));
    const jitterMs = Math.max(0, Math.round(Number(dto.jitterMs) || 0));
    const packetsLost = Math.max(0, Math.round(Number(dto.packetsLost) || 0));
    const bytesSent = Math.max(0, Math.round(Number(dto.bytesSent) || 0));
    const bytesReceived = Math.max(
      0,
      Math.round(Number(dto.bytesReceived) || 0),
    );
    const relayProtocol = String(dto.relayProtocol || '').trim().toLowerCase();
    const iceFailureReason = String(dto.iceFailureReason || '').trim();

    await this.telemetryModel.create({
      callId: doc._id,
      tenantId: doc.tenantId,
      reporterUserId: new Types.ObjectId(auth.userId),
      sampledAt: new Date(),
      icePath,
      turnUsed: inferredTurn,
      localCandidateType: localType,
      remoteCandidateType: remoteType,
      relayProtocol,
      rttMs,
      jitterMs,
      packetsLost,
      bytesSent,
      bytesReceived,
      iceConnectionState: String(dto.iceConnectionState || '').trim(),
      iceFailureReason,
    });

    // Track RTT average smoothly in runtime memory (and fall back cleanly if restarted)
    const rt = this.runtimeCalls.get(callId);
    let avgRttMs = rttMs;
    if (rt && rttMs > 0) {
      rt.rttSamples.push(rttMs);
      avgRttMs = Math.round(
        rt.rttSamples.reduce((s, n) => s + n, 0) / rt.rttSamples.length,
      );
    } else if (doc.connection?.rttMs > 0 && rttMs > 0) {
      avgRttMs = Math.round((doc.connection.rttMs + rttMs) / 2);
    } else if (doc.connection?.rttMs > 0) {
      avgRttMs = doc.connection.rttMs;
    }

    const prev = doc.connection || {
      icePath: 'direct',
      turnUsed: false,
      relayProtocol: '',
      rttMs: 0,
      maxRttMs: 0,
      packetsLost: 0,
      bytesSent: 0,
      bytesReceived: 0,
      iceFailureReason: '',
    };

    doc.connection = {
      icePath:
        icePath === 'failed'
          ? 'failed'
          : prev.turnUsed || inferredTurn
            ? 'turn_relay'
            : 'direct',
      turnUsed: Boolean(prev.turnUsed || inferredTurn),
      relayProtocol: relayProtocol || prev.relayProtocol || '',
      rttMs: avgRttMs,
      maxRttMs: Math.max(prev.maxRttMs || 0, rttMs),
      packetsLost: Math.max(prev.packetsLost || 0, packetsLost),
      bytesSent: Math.max(prev.bytesSent || 0, bytesSent),
      bytesReceived: Math.max(prev.bytesReceived || 0, bytesReceived),
      iceFailureReason: iceFailureReason || prev.iceFailureReason || '',
    };

    await doc.save();
    return {
      callId,
      connection: doc.connection,
    };
  }

  // ─── REST History, Telemetry & STUN/TURN Config ──────────────────────────

  async getHistory(
    auth: CallAuthContext,
    query: { filter?: string; limit?: string; scope?: string },
  ) {
    const limit = Math.max(1, Math.min(100, Number(query.limit) || 40));
    const tenantOid = new Types.ObjectId(auth.tenantId);
    const userOid = new Types.ObjectId(auth.userId);
    const canViewWorkspace =
      query.scope === 'workspace' &&
      ['owner', 'admin', 'super_admin'].includes(auth.role);

    const baseFilter: Record<string, unknown> = { tenantId: tenantOid };
    if (!canViewWorkspace) {
      if (query.filter === 'outgoing') {
        baseFilter.callerId = userOid;
      } else if (query.filter === 'incoming') {
        baseFilter.calleeId = userOid;
      } else {
        baseFilter.$or = [{ callerId: userOid }, { calleeId: userOid }];
      }
    }

    if (query.filter === 'missed') {
      baseFilter.status = { $in: ['missed', 'rejected', 'timeout'] };
    }

    const participantScope: Record<string, unknown> = canViewWorkspace
      ? { tenantId: tenantOid }
      : { tenantId: tenantOid, $or: [{ callerId: userOid }, { calleeId: userOid }] };

    const [docs, allUserCalls] = await Promise.all([
      this.callLogModel
        .find(baseFilter)
        .sort({ startedAt: -1 })
        .limit(limit)
        .exec(),
      this.callLogModel
        .find(participantScope)
        .sort({ startedAt: -1 })
        .limit(200)
        .exec(),
    ]);

    const answered = allUserCalls.filter((c) => c.status === 'completed');
    const missed = allUserCalls.filter((c) =>
      ['missed', 'rejected', 'timeout'].includes(c.status),
    );
    const totalDuration = answered.reduce(
      (s, c) => s + (Number(c.durationSeconds) || 0),
      0,
    );
    const avgDurationSec =
      answered.length > 0 ? Math.round(totalDuration / answered.length) : 0;

    return {
      data: docs.map((d) => this.toDto(d, auth.userId)),
      stats: {
        total: allUserCalls.length,
        answered: answered.length,
        missed: missed.length,
        avgDurationSec,
      },
    };
  }

  async getUserAnalytics(auth: CallAuthContext) {
    const tenantOid = new Types.ObjectId(auth.tenantId);
    const isAdminViewer = ['owner', 'admin', 'super_admin'].includes(
      auth.role,
    );

    const [users, calls] = await Promise.all([
      this.userModel
        .find({
          tenantId: tenantOid,
          isActive: true,
          ...(isAdminViewer ? {} : { _id: new Types.ObjectId(auth.userId) }),
        })
        .select({ name: 1, role: 1, userCode: 1, territory: 1 })
        .sort({ name: 1 })
        .exec(),
      this.callLogModel
        .find({
          tenantId: tenantOid,
          ...(isAdminViewer
            ? {}
            : {
                $or: [
                  { callerId: new Types.ObjectId(auth.userId) },
                  { calleeId: new Types.ObjectId(auth.userId) },
                ],
              }),
        })
        .select({
          callerId: 1,
          calleeId: 1,
          status: 1,
          durationSeconds: 1,
        })
        .exec(),
    ]);

    const statsMap = new Map<
      string,
      {
        totalCalls: number;
        answeredCalls: number;
        missedCalls: number;
        outgoingCalls: number;
        incomingCalls: number;
        totalDurationSeconds: number;
      }
    >();

    for (const u of users) {
      statsMap.set(u._id.toString(), {
        totalCalls: 0,
        answeredCalls: 0,
        missedCalls: 0,
        outgoingCalls: 0,
        incomingCalls: 0,
        totalDurationSeconds: 0,
      });
    }

    const isAnswered = (st: string) => st === 'completed' || st === 'connected';
    const isMissed = (st: string) =>
      st === 'missed' || st === 'rejected' || st === 'timeout';

    for (const c of calls) {
      const callerId = c.callerId.toString();
      const calleeId = c.calleeId.toString();
      const dur = Math.max(0, Number(c.durationSeconds) || 0);

      const callerBucket = statsMap.get(callerId);
      if (callerBucket) {
        callerBucket.totalCalls += 1;
        callerBucket.outgoingCalls += 1;
        if (isAnswered(c.status)) {
          callerBucket.answeredCalls += 1;
          callerBucket.totalDurationSeconds += dur;
        } else if (isMissed(c.status)) {
          callerBucket.missedCalls += 1;
        }
      }

      const calleeBucket = statsMap.get(calleeId);
      if (calleeBucket && calleeId !== callerId) {
        calleeBucket.totalCalls += 1;
        calleeBucket.incomingCalls += 1;
        if (isAnswered(c.status)) {
          calleeBucket.answeredCalls += 1;
          calleeBucket.totalDurationSeconds += dur;
        } else if (isMissed(c.status)) {
          calleeBucket.missedCalls += 1;
        }
      }
    }

    const items = users
      .map((u) => {
        const uid = u._id.toString();
        const s = statsMap.get(uid)!;
        const answerRatePct =
          s.totalCalls > 0
            ? Math.round((s.answeredCalls / s.totalCalls) * 100)
            : 0;
        return {
          userId: uid,
          name: u.name,
          role: u.role,
          userCode: u.userCode || '',
          territory: u.territory || '',
          ...s,
          answerRatePct,
        };
      })
      .sort((a, b) => b.totalCalls - a.totalCalls || a.name.localeCompare(b.name));

    return {
      isAdminView: isAdminViewer,
      myStats: items.find((i) => i.userId === auth.userId) || null,
      users: items,
    };
  }

  async getAnalytics(auth: CallAuthContext, scope?: string) {
    if (!['owner', 'admin', 'super_admin'].includes(auth.role)) {
      throw new ForbiddenException(
        'Calling analytics is restricted to Workspace Admins and Super Admins.',
      );
    }

    const filter: Record<string, unknown> =
      auth.role === 'super_admin' && scope === 'platform'
        ? {}
        : { tenantId: new Types.ObjectId(auth.tenantId) };

    const calls = await this.callLogModel
      .find(filter)
      .sort({ startedAt: -1 })
      .limit(1000)
      .exec();

    const totalCalls = calls.length;
    const connectedCalls = calls.filter(
      (c) => c.status === 'completed' || c.status === 'connected',
    );
    const failedCalls = calls.filter((c) => c.status === 'failed');
    const attemptedMediaCount = connectedCalls.length + failedCalls.length;
    const successRatePct =
      attemptedMediaCount > 0
        ? Math.round((connectedCalls.length / attemptedMediaCount) * 100)
        : 0;

    const withSetup = calls.filter((c) => (Number(c.setupTimeMs) || 0) > 0);
    const avgSetupTimeMs =
      withSetup.length > 0
        ? Math.round(
            withSetup.reduce((s, c) => s + Number(c.setupTimeMs || 0), 0) /
              withSetup.length,
          )
        : 0;

    const turnCalls = connectedCalls.filter((c) => c.connection?.turnUsed);
    const turnUsagePct =
      connectedCalls.length > 0
        ? Math.round((turnCalls.length / connectedCalls.length) * 100)
        : 0;

    const rttCalls = connectedCalls.filter(
      (c) => (Number(c.connection?.rttMs) || 0) > 0,
    );
    const avgRttMs =
      rttCalls.length > 0
        ? Math.round(
            rttCalls.reduce(
              (s, c) => s + Number(c.connection?.rttMs || 0),
              0,
            ) / rttCalls.length,
          )
        : 0;

    const estimatedRelayBytes = turnCalls.reduce(
      (s, c) =>
        s +
        Number(c.connection?.bytesSent || 0) +
        Number(c.connection?.bytesReceived || 0),
      0,
    );

    const directP2pCalls = connectedCalls.length - turnCalls.length;
    const protocolBreakdown = {
      direct: directP2pCalls,
      udp: turnCalls.filter(
        (c) => (c.connection?.relayProtocol || '').toLowerCase() === 'udp',
      ).length,
      tcp: turnCalls.filter(
        (c) => (c.connection?.relayProtocol || '').toLowerCase() === 'tcp',
      ).length,
      tls: turnCalls.filter(
        (c) => (c.connection?.relayProtocol || '').toLowerCase() === 'tls',
      ).length,
      otherRelay: turnCalls.filter(
        (c) =>
          !['udp', 'tcp', 'tls'].includes(
            (c.connection?.relayProtocol || '').toLowerCase(),
          ),
      ).length,
    };

    const recentCalls = calls.slice(0, 30).map((c) => ({
      id: c._id.toString(),
      tenantId: c.tenantId.toString(),
      callerName: c.callerName,
      calleeName: c.calleeName,
      status: c.status,
      durationSeconds: c.durationSeconds || 0,
      setupTimeMs: c.setupTimeMs || 0,
      startedAt: c.startedAt.toISOString(),
      endReason: c.endReason || '',
      connection: c.connection || {
        icePath: 'direct',
        turnUsed: false,
        relayProtocol: '',
        rttMs: 0,
        maxRttMs: 0,
        packetsLost: 0,
        bytesSent: 0,
        bytesReceived: 0,
        iceFailureReason: '',
      },
    }));

    return {
      totalCalls,
      connectedCalls: connectedCalls.length,
      directP2pCalls,
      failedCalls: failedCalls.length,
      missedOrRejectedCalls: calls.filter((c) =>
        ['missed', 'rejected', 'timeout', 'cancelled'].includes(c.status),
      ).length,
      successRatePct,
      avgSetupTimeMs,
      turnRelayCalls: turnCalls.length,
      turnUsagePct,
      avgRttMs,
      estimatedRelayBytes,
      protocolBreakdown,
      recentCalls,
    };
  }

  async getCallTelemetry(auth: CallAuthContext, callId: string) {
    if (!Types.ObjectId.isValid(callId)) {
      throw new NotFoundException('Call record not found.');
    }

    const call = await this.callLogModel
      .findOne({
        _id: new Types.ObjectId(callId),
        ...(auth.role === 'super_admin'
          ? {}
          : { tenantId: new Types.ObjectId(auth.tenantId) }),
      })
      .exec();

    if (!call) {
      throw new NotFoundException('Call record not found.');
    }

    const isParticipant =
      call.callerId.toString() === auth.userId ||
      call.calleeId.toString() === auth.userId;
    if (
      !isParticipant &&
      !['owner', 'admin', 'super_admin'].includes(auth.role)
    ) {
      throw new ForbiddenException('Access denied to this call telemetry.');
    }

    const samples = await this.telemetryModel
      .find({ callId: call._id })
      .sort({ sampledAt: 1 })
      .exec();

    return {
      call: this.toDto(call, auth.userId),
      samples: samples.map((s) => ({
        id: s._id.toString(),
        sampledAt: s.sampledAt.toISOString(),
        reporterUserId: s.reporterUserId.toString(),
        icePath: s.icePath,
        turnUsed: s.turnUsed,
        localCandidateType: s.localCandidateType,
        remoteCandidateType: s.remoteCandidateType,
        relayProtocol: s.relayProtocol,
        rttMs: s.rttMs,
        jitterMs: s.jitterMs,
        packetsLost: s.packetsLost,
        bytesSent: s.bytesSent,
        bytesReceived: s.bytesReceived,
        iceConnectionState: s.iceConnectionState,
      })),
    };
  }

  async getIceServers(auth: CallAuthContext) {
    const iceServers: Array<{
      urls: string | string[];
      username?: string;
      credential?: string;
    }> = [
      {
        urls: [
          'stun:stun.l.google.com:19302',
          'stun:stun1.l.google.com:19302',
        ],
      },
    ];

    const ttlSeconds = Math.max(
      300,
      Math.min(
        86400,
        Number(this.configService.get<string>('TURN_TTL_SECONDS') || 3600) ||
          3600,
      ),
    );

    // 1. Optional Cloudflare Calls / Realtime short-lived TURN token API
    const cfTokenId = this.configService
      .get<string>('CLOUDFLARE_TURN_TOKEN_ID')
      ?.trim();
    const cfApiToken = this.configService
      .get<string>('CLOUDFLARE_TURN_API_TOKEN')
      ?.trim();
    if (cfTokenId && cfApiToken) {
      try {
        const cfRes = await axios.post<{
          iceServers?: Array<{
            urls: string | string[];
            username?: string;
            credential?: string;
          }>;
        }>(
          `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(cfTokenId)}/credentials/generate-ice-servers`,
          { ttl: ttlSeconds },
          {
            headers: {
              Authorization: `Bearer ${cfApiToken}`,
              'Content-Type': 'application/json',
            },
            timeout: 5000,
          },
        );
        if (Array.isArray(cfRes.data?.iceServers)) {
          iceServers.push(...cfRes.data.iceServers);
        }
      } catch {
        // Non-fatal: continue with coturn/STUN fallback if configured
      }
    }

    // 2. Self-hosted coturn ephemeral HMAC-SHA1 REST credentials or static TURN
    const turnUrlsRaw =
      this.configService.get<string>('TURN_URLS') ||
      this.configService.get<string>('TURN_URL') ||
      '';
    const turnUrls = turnUrlsRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const turnSecret = this.configService.get<string>('TURN_SECRET')?.trim();

    if (turnUrls.length > 0 && turnSecret) {
      const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
      const username = `${expiresAt}:${auth.userId}`;
      const credential = createHmac('sha1', turnSecret)
        .update(username)
        .digest('base64');
      iceServers.push({
        urls: turnUrls,
        username,
        credential,
      });
    } else if (turnUrls.length > 0) {
      const username = this.configService.get<string>('TURN_USERNAME')?.trim();
      const credential = this.configService
        .get<string>('TURN_CREDENTIAL')
        ?.trim();
      if (username && credential) {
        iceServers.push({
          urls: turnUrls,
          username,
          credential,
        });
      }
    }

    const forceTurn =
      this.configService.get<string>('ICE_FORCE_TURN')?.trim().toLowerCase() ===
      'true';

    return {
      iceServers,
      iceTransportPolicy: (forceTurn && iceServers.length > 1
        ? 'relay'
        : 'all') as 'all' | 'relay',
      turnConfigured: iceServers.length > 1,
      ttlSeconds,
    };
  }

  toDto(doc: CallLogDocument, viewerUserId: string) {
    const callerId = doc.callerId.toString();
    const calleeId = doc.calleeId.toString();
    const direction = callerId === viewerUserId ? 'outgoing' : 'incoming';
    const peerId = direction === 'outgoing' ? calleeId : callerId;
    const peerName = direction === 'outgoing' ? doc.calleeName : doc.callerName;
    const peerRole = direction === 'outgoing' ? doc.calleeRole : doc.callerRole;
    const peerUserCode =
      direction === 'outgoing' ? doc.calleeUserCode : doc.callerUserCode;

    return {
      id: doc._id.toString(),
      tenantId: doc.tenantId.toString(),
      callerId,
      calleeId,
      callerName: doc.callerName,
      callerRole: doc.callerRole,
      callerUserCode: doc.callerUserCode,
      calleeName: doc.calleeName,
      calleeRole: doc.calleeRole,
      calleeUserCode: doc.calleeUserCode,
      direction,
      peerId,
      peerName,
      peerRole,
      peerUserCode,
      status: doc.status,
      startedAt: doc.startedAt.toISOString(),
      answeredAt: doc.answeredAt ? new Date(doc.answeredAt).toISOString() : null,
      connectedAt: doc.connectedAt
        ? new Date(doc.connectedAt).toISOString()
        : null,
      endedAt: doc.endedAt ? new Date(doc.endedAt).toISOString() : null,
      setupTimeMs: doc.setupTimeMs || 0,
      durationSeconds: doc.durationSeconds || 0,
      endReason: doc.endReason || '',
      connection: doc.connection || {
        icePath: 'direct',
        turnUsed: false,
        relayProtocol: '',
        rttMs: 0,
        maxRttMs: 0,
        packetsLost: 0,
        bytesSent: 0,
        bytesReceived: 0,
        iceFailureReason: '',
      },
    };
  }
}
