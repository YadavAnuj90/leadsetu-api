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
import { createHmac, randomBytes } from 'crypto';
import axios from 'axios';
import { Model, Types } from 'mongoose';
import { User, UserDocument } from '../auth/schemas/user.schema';
import { Tenant, TenantDocument } from '../auth/schemas/tenant.schema';
import { uploadToCloudinary } from '../auth/cloudinary.util';
import { resolveOwnerScopeFilter } from '../auth/identity.util';
import { AuditService } from '../audit/audit.service';
import { InboxService } from '../inbox/inbox.service';
import { AiBridgeService } from '../ai-bridge/ai-bridge.service';
import { Contact, ContactDocument } from '../contacts/contacts.service';
import { Deal, DealDocument } from '../deals/schemas/deal.schema';
import { Lead, LeadDocument } from '../leads/schemas/lead.schema';
import { TaskDocument, TaskItem } from '../tasks/tasks.service';
import { Ticket, TicketDocument } from '../tickets/tickets.service';
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
  CreateCallShareLinkDto,
  LogSimCallDto,
  PowerDialOutcomeDto,
  PublicCallCallbackDto,
  SaveCallDispositionDto,
  UploadCallRecordingDto,
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
    @InjectModel(Lead.name)
    private readonly leadModel: Model<LeadDocument>,
    @InjectModel(Deal.name)
    private readonly dealModel: Model<DealDocument>,
    @InjectModel(Ticket.name)
    private readonly ticketModel: Model<TicketDocument>,
    @InjectModel(Contact.name)
    private readonly contactModel: Model<ContactDocument>,
    @InjectModel(TaskItem.name)
    private readonly taskModel: Model<TaskDocument>,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    @Optional() private readonly auditService?: AuditService,
    @Optional() private readonly inboxService?: InboxService,
    @Optional() private readonly aiBridge?: AiBridgeService,
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
      'leadsetu_super_secret_access_key_2026';

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
    target:
      | string
      | {
          calleeId?: string;
          calleeUserCode?: string;
          customerName?: string;
          customerPhone?: string;
          linkedEntityType?: '' | 'lead' | 'deal' | 'ticket';
          linkedEntityId?: string;
          linkedEntityLabel?: string;
        },
  ) {
    const targetObj = typeof target === 'object' && target ? target : {};
    const rawCalleeId = auth.isGuestCustomer
      ? String(auth.targetAgentId || '').trim()
      : typeof target === 'string'
        ? target.trim()
        : String(targetObj.calleeId || '').trim();
    const rawUserCode = auth.isGuestCustomer
      ? ''
      : typeof target === 'string'
        ? ''
        : String(targetObj.calleeUserCode || '').replace(/^#/, '').trim();

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
      throw new NotFoundException(
        auth.isGuestCustomer
          ? 'Assigned agent is no longer available.'
          : 'Target teammate not found in your workspace.',
      );
    }

    const calleeId = callee._id.toString();
    if (!auth.isGuestCustomer && calleeId === auth.userId) {
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

    const callerType: 'agent' | 'customer' = auth.isGuestCustomer
      ? 'customer'
      : 'agent';
    const resolvedCallerName = auth.isGuestCustomer
      ? String(targetObj.customerName || '').trim() || auth.name || 'Customer'
      : auth.name;
    const resolvedCallerRole = auth.isGuestCustomer ? 'Customer' : auth.role;
    const resolvedCallerUserCode = auth.isGuestCustomer ? '' : auth.userCode;
    const resolvedCustomerPhone = auth.isGuestCustomer
      ? String(targetObj.customerPhone || '').trim() || auth.customerPhone || ''
      : '';

    const linkedEntityType: '' | 'lead' | 'deal' | 'ticket' | 'contact' =
      (auth.isGuestCustomer
        ? auth.linkedEntityType
        : targetObj.linkedEntityType) || '';
    const linkedEntityId =
      (auth.isGuestCustomer ? auth.linkedEntityId : targetObj.linkedEntityId) ||
      '';
    const linkedEntityLabel =
      (auth.isGuestCustomer
        ? auth.linkedEntityLabel
        : targetObj.linkedEntityLabel) || '';

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
        callerType,
        callerName: resolvedCallerName,
        callerRole: resolvedCallerRole,
        callerUserCode: resolvedCallerUserCode,
        customerPhone: resolvedCustomerPhone,
        calleeName: callee.name,
        calleeRole: callee.role,
        calleeUserCode: callee.userCode || '',
        linkedEntityType,
        linkedEntityId,
        linkedEntityLabel,
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
          callerType,
          name: resolvedCallerName,
          role: resolvedCallerRole,
          userCode: resolvedCallerUserCode,
          customerPhone: resolvedCustomerPhone,
          linkedEntityType,
          linkedEntityId,
          linkedEntityLabel,
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
    const user = Types.ObjectId.isValid(userId)
      ? await this.userModel.findById(userId).exec()
      : null;
    const auth: CallAuthContext = user
      ? {
          userId,
          tenantId,
          email: user.email,
          role: user.role,
          name: user.name,
          userCode: user.userCode || '',
        }
      : {
          userId,
          tenantId,
          email: '',
          role: 'customer',
          name: 'Customer',
          userCode: '',
          isGuestCustomer: true,
        };
    return this.endCall(auth, callId, {
      reason: user ? 'Agent disconnected' : 'Customer disconnected',
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
    } else if (query.filter === 'callbacks') {
      baseFilter.status = { $in: ['missed', 'rejected', 'timeout'] };
      baseFilter.callChannel = { $ne: 'sim_mobile' };
      baseFilter.callbackResolved = { $ne: true };
      if (!canViewWorkspace) {
        delete baseFilter.$or;
        baseFilter.calleeId = userOid;
      }
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
    const pendingCallbacks = missed.filter(
      (c) =>
        c.callChannel !== 'sim_mobile' &&
        (canViewWorkspace || c.calleeId.toString() === auth.userId) &&
        !c.callbackResolved,
    ).length;
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
        pendingCallbacks,
      },
    };
  }

  async toggleCallbackResolved(
    auth: CallAuthContext,
    callId: string,
    resolved?: boolean,
  ) {
    if (!Types.ObjectId.isValid(callId)) {
      throw new BadRequestException('Invalid call ID.');
    }
    const doc = await this.callLogModel
      .findOne({
        _id: new Types.ObjectId(callId),
        tenantId: new Types.ObjectId(auth.tenantId),
      })
      .exec();

    if (!doc) {
      throw new NotFoundException('Call record not found.');
    }

    const isAdmin = ['owner', 'admin', 'super_admin'].includes(auth.role);
    const isParticipant =
      doc.callerId.toString() === auth.userId ||
      doc.calleeId.toString() === auth.userId;
    if (!isParticipant && !isAdmin) {
      throw new ForbiddenException('You are not authorized to update this call.');
    }

    const nextResolved =
      typeof resolved === 'boolean' ? resolved : !doc.callbackResolved;
    doc.callbackResolved = nextResolved;
    doc.callbackResolvedAt = nextResolved ? new Date() : null;
    doc.callbackResolvedByUserId = nextResolved ? auth.userId : '';
    await doc.save();

    if (doc.followUpTaskId && Types.ObjectId.isValid(doc.followUpTaskId)) {
      await this.taskModel
        .findOneAndUpdate(
          {
            _id: new Types.ObjectId(doc.followUpTaskId),
            tenantId: doc.tenantId,
          },
          { $set: { status: nextResolved ? 'done' : 'pending' } },
        )
        .exec();
    }

    return {
      call: this.toDto(doc, auth.userId),
    };
  }

  // ─── Phase 1: CRM Linking, In-Call Notes, Disposition & Follow-up Tasks ──

  private formatOutcomeLabel(tag?: string): string {
    const map: Record<string, string> = {
      rnr: 'RNR (No Answer)',
      busy: 'Busy / Line Engaged',
      callback: 'Callback Scheduled',
      interested: 'Interested',
      not_interested: 'Not Interested',
      dnd: 'DND / Do Not Call',
      quote_discussed: 'Quote Discussed',
      followup_requested: 'Follow-up Requested',
      support_resolved: 'Support Resolved',
      escalated: 'Escalated',
      no_answer_callback: 'No Answer / Callback',
      general: 'General Discussion',
    };
    const key = String(tag || '').trim();
    if (!key) return '';
    return map[key] || key.replace(/_/g, ' ');
  }

  private async resolveEntitySnapshot(
    tenantId: string,
    entityType: '' | 'lead' | 'deal' | 'ticket' | 'contact',
    entityId: string,
  ): Promise<{
    entityLabel: string;
    customerName: string;
    customerPhone: string;
    company: string;
    ownerId: string;
  } | null> {
    if (!entityType || !entityId || !Types.ObjectId.isValid(entityId)) {
      return null;
    }
    const tenantOid = new Types.ObjectId(tenantId);
    const entityOid = new Types.ObjectId(entityId);

    if (entityType === 'lead') {
      const lead = await this.leadModel
        .findOne({ _id: entityOid, tenantId: tenantOid })
        .exec();
      if (!lead) return null;
      return {
        entityLabel: lead.company ? `${lead.name} (${lead.company})` : lead.name,
        customerName: lead.name,
        customerPhone: lead.phone || '',
        company: lead.company || '',
        ownerId: lead.ownerId?.toString() || '',
      };
    }

    if (entityType === 'deal') {
      const deal = await this.dealModel
        .findOne({ _id: entityOid, tenantId: tenantOid })
        .exec();
      if (!deal) return null;
      return {
        entityLabel: deal.company ? `${deal.title} (${deal.company})` : deal.title,
        customerName: deal.contactName || deal.title,
        customerPhone: deal.contactPhone || '',
        company: deal.company || '',
        ownerId: deal.ownerId?.toString() || '',
      };
    }

    if (entityType === 'ticket') {
      const ticket = await this.ticketModel
        .findOne({ _id: entityOid, tenantId: tenantOid })
        .exec();
      if (!ticket) return null;
      return {
        entityLabel: `${ticket.ticketNumber} · ${ticket.subject}`,
        customerName: ticket.customerName || ticket.subject,
        customerPhone: ticket.phone || '',
        company: ticket.company || '',
        ownerId: ticket.ownerId?.toString() || '',
      };
    }

    if (entityType === 'contact') {
      const contact = await this.contactModel
        .findOne({ _id: entityOid, tenantId: tenantOid })
        .exec();
      if (!contact) return null;
      return {
        entityLabel: contact.company
          ? `${contact.name} (${contact.company})`
          : contact.name,
        customerName: contact.name,
        customerPhone: contact.phone || '',
        company: contact.company || '',
        ownerId: contact.ownerId?.toString() || '',
      };
    }

    return null;
  }

  private async appendCallTimelineToEntity(
    tenantId: string,
    entityType: '' | 'lead' | 'deal' | 'ticket' | 'contact',
    entityId: string,
    authorName: string,
    summary: string,
  ) {
    if (!entityType || !entityId || !Types.ObjectId.isValid(entityId)) {
      return null;
    }
    const tenantOid = new Types.ObjectId(tenantId);
    const entityOid = new Types.ObjectId(entityId);
    const nowIso = new Date().toISOString();
    const activityId = randomBytes(6).toString('hex');

    if (entityType === 'lead') {
      const lead = await this.leadModel
        .findOne({ _id: entityOid, tenantId: tenantOid })
        .exec();
      if (!lead) return null;
      lead.activities = [
        ...(lead.activities || []),
        {
          id: activityId,
          type: 'call',
          description: summary,
          authorName,
          createdAt: nowIso,
        },
      ];
      await lead.save();
      return {
        entityLabel: lead.company ? `${lead.name} (${lead.company})` : lead.name,
        customerName: lead.name,
        company: lead.company || '',
        phone: lead.phone || '',
      };
    }

    if (entityType === 'deal') {
      const deal = await this.dealModel
        .findOne({ _id: entityOid, tenantId: tenantOid })
        .exec();
      if (!deal) return null;
      deal.activities = [
        ...(deal.activities || []),
        {
          id: activityId,
          type: 'call',
          description: summary,
          authorName,
          createdAt: nowIso,
        },
      ];
      await deal.save();
      return {
        entityLabel: deal.company ? `${deal.title} (${deal.company})` : deal.title,
        customerName: deal.contactName || deal.title,
        company: deal.company || '',
        phone: deal.contactPhone || '',
      };
    }

    if (entityType === 'ticket') {
      const ticket = await this.ticketModel
        .findOne({ _id: entityOid, tenantId: tenantOid })
        .exec();
      if (!ticket) return null;
      ticket.comments = [
        ...(ticket.comments || []),
        {
          id: activityId,
          authorName,
          authorRole: 'agent',
          message: summary,
          isInternal: false,
          createdAt: nowIso,
        },
      ];
      await ticket.save();
      return {
        entityLabel: `${ticket.ticketNumber} · ${ticket.subject}`,
        customerName: ticket.customerName || ticket.subject,
        company: ticket.company || '',
        phone: ticket.phone || '',
      };
    }

    if (entityType === 'contact') {
      const contact = await this.contactModel
        .findOne({ _id: entityOid, tenantId: tenantOid })
        .exec();
      if (!contact) return null;
      contact.activities = [
        ...(contact.activities || []),
        {
          id: activityId,
          type: 'call',
          description: summary,
          authorName,
          createdAt: nowIso,
        },
      ];
      await contact.save();
      return {
        entityLabel: contact.company
          ? `${contact.name} (${contact.company})`
          : contact.name,
        customerName: contact.name,
        company: contact.company || '',
        phone: contact.phone || '',
      };
    }

    return null;
  }

  async listLinkableCrmEntities(auth: CallAuthContext, search?: string) {
    const tenantOid = new Types.ObjectId(auth.tenantId);
    const userOid = new Types.ObjectId(auth.userId);
    const isAdmin = ['owner', 'admin', 'super_admin'].includes(auth.role);
    const q = String(search || '').trim();
    const regex = q
      ? new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      : null;

    const leadFilter: Record<string, unknown> = {
      tenantId: tenantOid,
      ...(isAdmin ? {} : { ownerId: userOid }),
      ...(regex
        ? { $or: [{ name: regex }, { company: regex }, { phone: regex }] }
        : {}),
    };
    const dealFilter: Record<string, unknown> = {
      tenantId: tenantOid,
      ...(isAdmin ? {} : { ownerId: userOid }),
      ...(regex
        ? {
            $or: [
              { title: regex },
              { company: regex },
              { contactName: regex },
              { contactPhone: regex },
            ],
          }
        : {}),
    };
    const ticketFilter: Record<string, unknown> = {
      tenantId: tenantOid,
      ...(isAdmin ? {} : { ownerId: userOid }),
      ...(regex
        ? {
            $or: [
              { ticketNumber: regex },
              { subject: regex },
              { customerName: regex },
              { company: regex },
              { phone: regex },
            ],
          }
        : {}),
    };
    const contactFilter: Record<string, unknown> = {
      tenantId: tenantOid,
      ...(isAdmin ? {} : { ownerId: userOid }),
      ...(regex
        ? { $or: [{ name: regex }, { company: regex }, { phone: regex }] }
        : {}),
    };

    let [leads, deals, tickets, contacts] = await Promise.all([
      this.leadModel.find(leadFilter).sort({ updatedAt: -1 }).limit(25).exec(),
      this.dealModel.find(dealFilter).sort({ updatedAt: -1 }).limit(25).exec(),
      this.ticketModel.find(ticketFilter).sort({ updatedAt: -1 }).limit(25).exec(),
      this.contactModel
        .find(contactFilter)
        .sort({ updatedAt: -1 })
        .limit(25)
        .exec(),
    ]);

    if (!isAdmin) {
      if (leads.length === 0) {
        leads = await this.leadModel
          .find({
            tenantId: tenantOid,
            ...(regex
              ? { $or: [{ name: regex }, { company: regex }, { phone: regex }] }
              : {}),
          })
          .sort({ updatedAt: -1 })
          .limit(25)
          .exec();
      }
      if (deals.length === 0) {
        deals = await this.dealModel
          .find({
            tenantId: tenantOid,
            ...(regex
              ? {
                  $or: [
                    { title: regex },
                    { company: regex },
                    { contactName: regex },
                    { contactPhone: regex },
                  ],
                }
              : {}),
          })
          .sort({ updatedAt: -1 })
          .limit(25)
          .exec();
      }
      if (tickets.length === 0) {
        tickets = await this.ticketModel
          .find({
            tenantId: tenantOid,
            ...(regex
              ? {
                  $or: [
                    { ticketNumber: regex },
                    { subject: regex },
                    { customerName: regex },
                    { company: regex },
                    { phone: regex },
                  ],
                }
              : {}),
          })
          .sort({ updatedAt: -1 })
          .limit(25)
          .exec();
      }
      if (contacts.length === 0) {
        contacts = await this.contactModel
          .find({
            tenantId: tenantOid,
            ...(regex
              ? { $or: [{ name: regex }, { company: regex }, { phone: regex }] }
              : {}),
          })
          .sort({ updatedAt: -1 })
          .limit(25)
          .exec();
      }
    }

    return {
      leads: leads.map((l) => ({
        id: l._id.toString(),
        type: 'lead' as const,
        label: l.name,
        sublabel: l.company || l.status || 'Lead',
        phone: l.phone || '',
        company: l.company || '',
        ownerId: l.ownerId?.toString() || '',
      })),
      deals: deals.map((d) => ({
        id: d._id.toString(),
        type: 'deal' as const,
        label: d.title,
        sublabel: d.company || d.stage || 'Deal',
        phone: d.contactPhone || '',
        company: d.company || '',
        ownerId: d.ownerId?.toString() || '',
      })),
      tickets: tickets.map((t) => ({
        id: t._id.toString(),
        type: 'ticket' as const,
        label: `${t.ticketNumber} · ${t.subject}`,
        sublabel: t.customerName || t.company || t.status || 'Ticket',
        phone: t.phone || '',
        company: t.company || '',
        ownerId: t.ownerId?.toString() || '',
      })),
      contacts: contacts.map((c) => ({
        id: c._id.toString(),
        type: 'contact' as const,
        label: c.name,
        sublabel: c.company || c.type || 'Contact',
        phone: c.phone || '',
        company: c.company || '',
        ownerId: c.ownerId?.toString() || '',
      })),
    };
  }

  private async createDispositionFollowUpTask(params: {
    tenantId: Types.ObjectId;
    userId: string;
    dto: SaveCallDispositionDto;
    cleanNotes: string;
    relatedName: string;
    relatedCompany: string;
    relatedPhone: string;
  }): Promise<string> {
    if (!params.dto.createFollowUpTask || !params.dto.taskTitle?.trim()) {
      return '';
    }
    const task = await this.taskModel.create({
      tenantId: params.tenantId,
      ownerId: new Types.ObjectId(params.userId),
      title: params.dto.taskTitle.trim(),
      description:
        params.cleanNotes ||
        `Follow-up from voice call with ${params.relatedName || 'contact'}`,
      priority: params.dto.taskPriority || 'high',
      status: 'pending',
      category: params.dto.taskCategory || 'call',
      dueDate:
        params.dto.taskDueDate?.trim() ||
        new Date(Date.now() + 86400000).toISOString().slice(0, 10),
      relatedName: params.relatedName,
      relatedCompany: params.relatedCompany,
      relatedPhone: params.relatedPhone,
    });
    return task._id.toString();
  }

  async saveCallDisposition(
    auth: CallAuthContext,
    callId: string,
    dto: SaveCallDispositionDto,
  ) {
    if (!Types.ObjectId.isValid(callId)) {
      throw new BadRequestException('Invalid call ID.');
    }
    const doc = await this.callLogModel
      .findOne({
        _id: new Types.ObjectId(callId),
        tenantId: new Types.ObjectId(auth.tenantId),
      })
      .exec();

    if (!doc) {
      throw new NotFoundException('Call record not found.');
    }

    const isAdmin = ['owner', 'admin', 'super_admin'].includes(auth.role);
    const isParticipant =
      doc.callerId.toString() === auth.userId ||
      doc.calleeId.toString() === auth.userId;
    if (!isParticipant && !isAdmin) {
      throw new ForbiddenException('You are not authorized to update this call.');
    }

    const cleanNotes = String(dto.notes ?? doc.notes ?? '').trim();
    const cleanOutcome = String(dto.outcomeTag ?? doc.outcomeTag ?? '').trim();
    doc.notes = cleanNotes;
    doc.outcomeTag = cleanOutcome;
    doc.dispositionByUserId = auth.userId;
    doc.dispositionAt = new Date();

    const outcomeLabel = this.formatOutcomeLabel(cleanOutcome);
    const summary = `Voice Call (${doc.durationSeconds || 0}s${
      outcomeLabel ? ` · ${outcomeLabel}` : ''
    })${cleanNotes ? `: ${cleanNotes}` : ''}`;

    let relatedName =
      doc.callerId.toString() === auth.userId ? doc.calleeName : doc.callerName;
    let relatedCompany = '';
    let relatedPhone = doc.customerPhone || '';

    if (
      dto.linkedEntityType &&
      dto.linkedEntityId &&
      Types.ObjectId.isValid(dto.linkedEntityId)
    ) {
      const entityMeta = await this.appendCallTimelineToEntity(
        auth.tenantId,
        dto.linkedEntityType,
        dto.linkedEntityId,
        auth.name,
        summary,
      );
      if (entityMeta) {
        doc.linkedEntityType = dto.linkedEntityType;
        doc.linkedEntityId = dto.linkedEntityId;
        doc.linkedEntityLabel = entityMeta.entityLabel;
        relatedName = entityMeta.customerName || relatedName;
        relatedCompany = entityMeta.company || '';
        relatedPhone = entityMeta.phone || relatedPhone;
      }
    } else if (dto.linkedEntityType === '') {
      doc.linkedEntityType = '';
      doc.linkedEntityId = '';
      doc.linkedEntityLabel = '';
    }

    const taskId = await this.createDispositionFollowUpTask({
      tenantId: doc.tenantId,
      userId: auth.userId,
      dto,
      cleanNotes,
      relatedName,
      relatedCompany,
      relatedPhone,
    });
    if (taskId) {
      doc.followUpTaskId = taskId;
    }

    await doc.save();
    return {
      call: this.toDto(doc, auth.userId),
      followUpTaskId: doc.followUpTaskId || '',
    };
  }

  // ─── Module A: Mobile SIM (tel:) Call Logging ────────────────────────────

  async logSimCall(auth: CallAuthContext, dto: LogSimCallDto) {
    const status: 'completed' | 'missed' | 'rejected' =
      dto.status === 'missed' || dto.status === 'rejected'
        ? dto.status
        : 'completed';
    const durationSeconds =
      status === 'completed'
        ? Math.max(0, Math.round(Number(dto.durationSeconds) || 0))
        : 0;
    const cleanNotes = String(dto.notes || '').trim();
    const cleanOutcome = String(dto.outcomeTag || '').trim();
    const outcomeLabel = this.formatOutcomeLabel(cleanOutcome);

    const customerPhone = String(dto.customerPhone || '').trim();
    let relatedName =
      String(dto.contactName || '').trim() || customerPhone || 'Mobile Contact';
    let relatedCompany = '';
    let relatedPhone = customerPhone;
    let linkedEntityType: '' | 'lead' | 'deal' | 'ticket' | 'contact' = '';
    let linkedEntityId = '';
    let linkedEntityLabel = '';

    const summaryStatus =
      status === 'completed'
        ? `Connected ${durationSeconds}s`
        : status === 'missed'
          ? 'No Answer'
          : 'Busy / Declined';
    const summary = `SIM Mobile Call (${summaryStatus}${
      outcomeLabel ? ` · ${outcomeLabel}` : ''
    })${cleanNotes ? `: ${cleanNotes}` : ''}`;

    if (
      dto.linkedEntityType &&
      dto.linkedEntityId &&
      Types.ObjectId.isValid(dto.linkedEntityId)
    ) {
      const entityMeta = await this.appendCallTimelineToEntity(
        auth.tenantId,
        dto.linkedEntityType,
        dto.linkedEntityId,
        auth.name,
        summary,
      );
      if (entityMeta) {
        linkedEntityType = dto.linkedEntityType;
        linkedEntityId = dto.linkedEntityId;
        linkedEntityLabel = entityMeta.entityLabel;
        relatedName = entityMeta.customerName || relatedName;
        relatedCompany = entityMeta.company || '';
        relatedPhone = relatedPhone || entityMeta.phone || '';
      }
    }

    const tenantOid = new Types.ObjectId(auth.tenantId);
    const taskId = await this.createDispositionFollowUpTask({
      tenantId: tenantOid,
      userId: auth.userId,
      dto,
      cleanNotes,
      relatedName,
      relatedCompany,
      relatedPhone,
    });

    const endedAt = new Date();
    const startedAt = new Date(
      endedAt.getTime() - Math.max(1, durationSeconds) * 1000,
    );
    const userOid = new Types.ObjectId(auth.userId);

    const doc = await this.callLogModel.create({
      tenantId: tenantOid,
      callerId: userOid,
      calleeId: userOid,
      callChannel: 'sim_mobile',
      callerType: 'agent',
      callerName: auth.name,
      callerRole: auth.role,
      callerUserCode: auth.userCode,
      customerPhone: relatedPhone,
      calleeName: relatedName,
      calleeRole: 'External Mobile (SIM)',
      calleeUserCode: '',
      status,
      startedAt,
      answeredAt: status === 'completed' ? startedAt : null,
      connectedAt: status === 'completed' ? startedAt : null,
      endedAt,
      setupTimeMs: 0,
      durationSeconds,
      endedByUserId: auth.userId,
      endReason:
        status === 'completed'
          ? 'Mobile SIM Call'
          : status === 'missed'
            ? 'Mobile SIM Call - No Answer'
            : 'Mobile SIM Call - Busy / Declined',
      linkedEntityType,
      linkedEntityId,
      linkedEntityLabel,
      notes: cleanNotes,
      outcomeTag: cleanOutcome,
      dispositionByUserId: auth.userId,
      dispositionAt: endedAt,
      followUpTaskId: taskId,
    });

    return {
      call: this.toDto(doc, auth.userId),
      followUpTaskId: taskId,
    };
  }

  // ─── Option 2: BPO Power Dialer Queue + Smart RNR Auto-Retry ─────────────

  async getPowerQueue(
    auth: CallAuthContext,
    query?: { onlyDue?: string; limit?: string },
  ) {
    const tenantOid = new Types.ObjectId(auth.tenantId);
    const ownerScope = await resolveOwnerScopeFilter(this.leadModel.db, auth);
    const limit = Math.min(100, Math.max(10, Number(query?.limit) || 50));
    const onlyDue = query?.onlyDue === 'true';

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const [leads, dndCount, completedTodayCount] = await Promise.all([
      this.leadModel
        .find({
          tenantId: tenantOid,
          ...ownerScope,
          status: { $nin: ['converted', 'lost'] },
          doNotCall: { $ne: true },
          lastCallOutcome: { $ne: 'interested' },
          phone: { $exists: true, $ne: '' },
        })
        .sort({ aiScore: -1, createdAt: 1 })
        .limit(200)
        .exec(),
      this.leadModel
        .countDocuments({
          tenantId: tenantOid,
          ...ownerScope,
          doNotCall: true,
        })
        .exec(),
      this.callLogModel
        .countDocuments({
          tenantId: tenantOid,
          callerId: new Types.ObjectId(auth.userId),
          startedAt: { $gte: startOfToday },
          linkedEntityType: 'lead',
        })
        .exec(),
    ]);

    const nowMs = Date.now();
    const formatted = leads.map((l) => {
      const retryMs = l.nextCallRetryAt ? Date.parse(l.nextCallRetryAt) : NaN;
      const isRetryScheduled = Number.isFinite(retryMs);
      const isDueNow = !isRetryScheduled || retryMs <= nowMs;
      const bucket: 'due_retry' | 'fresh' | 'scheduled_later' = isRetryScheduled
        ? isDueNow
          ? 'due_retry'
          : 'scheduled_later'
        : l.lastCalledAt
          ? 'due_retry'
          : 'fresh';

      return {
        id: l._id.toString(),
        name: l.name,
        company: l.company || '',
        accountKind: l.accountKind === 'consumer' ? 'consumer' : 'business',
        phone: l.phone || '',
        email: l.email || '',
        city: l.city || '',
        source: l.source || 'manual',
        status: l.status || 'new',
        estimatedValue: Number(l.estimatedValue) || 0,
        aiScore: Number(l.aiScore) || 70,
        aiLabel: l.aiLabel || 'Warm',
        aiNextAction: l.aiNextAction || l.aiSummary || '',
        notes: l.notes || '',
        rnrRetryCount: Number(l.rnrRetryCount) || 0,
        nextCallRetryAt: l.nextCallRetryAt || '',
        lastCalledAt: l.lastCalledAt || '',
        lastCallOutcome: l.lastCallOutcome || '',
        isDueNow,
        queueBucket: bucket,
      };
    });

    const bucketRank: Record<'due_retry' | 'fresh' | 'scheduled_later', number> = {
      due_retry: 0,
      fresh: 1,
      scheduled_later: 2,
    };

    formatted.sort((a, b) => {
      const rankDiff = bucketRank[a.queueBucket] - bucketRank[b.queueBucket];
      if (rankDiff !== 0) return rankDiff;
      if (a.queueBucket === 'due_retry' && b.queueBucket === 'due_retry') {
        return (a.nextCallRetryAt || '').localeCompare(b.nextCallRetryAt || '');
      }
      return b.aiScore - a.aiScore;
    });

    const filtered = onlyDue ? formatted.filter((item) => item.isDueNow) : formatted;

    return {
      data: filtered.slice(0, limit),
      stats: {
        queueTotal: filtered.length,
        dueNowCount: formatted.filter((i) => i.isDueNow).length,
        freshCount: formatted.filter((i) => i.queueBucket === 'fresh').length,
        rnrRetryPendingCount: formatted.filter(
          (i) => i.rnrRetryCount > 0 && i.nextCallRetryAt,
        ).length,
        dndCount,
        completedTodayCount,
      },
    };
  }

  async recordPowerDialOutcome(
    auth: CallAuthContext,
    dto: PowerDialOutcomeDto,
  ) {
    const leadId = String(dto.leadId || '').trim();
    if (!Types.ObjectId.isValid(leadId)) {
      throw new BadRequestException('Valid leadId is required.');
    }

    const validDispositions = new Set([
      'rnr',
      'busy',
      'callback',
      'interested',
      'not_interested',
      'dnd',
    ]);
    if (!validDispositions.has(dto.disposition)) {
      throw new BadRequestException('Invalid power dialer disposition.');
    }

    const tenantOid = new Types.ObjectId(auth.tenantId);
    const ownerScope = await resolveOwnerScopeFilter(this.leadModel.db, auth);
    const lead = await this.leadModel
      .findOne({
        _id: new Types.ObjectId(leadId),
        tenantId: tenantOid,
        ...ownerScope,
      })
      .exec();
    if (!lead) {
      throw new NotFoundException('Lead not found in your dialer queue.');
    }

    const tenantDoc = await this.tenantModel
      .findById(tenantOid)
      .select({ companyName: 1, name: 1 })
      .exec();
    const companyLabel = tenantDoc?.companyName || tenantDoc?.name || 'our team';

    const now = new Date();
    const nowIso = now.toISOString();
    const cleanNotes = String(dto.notes || '').trim();
    const outcomeLabel = this.formatOutcomeLabel(dto.disposition);

    const callStatus: 'completed' | 'missed' | 'rejected' =
      dto.disposition === 'rnr'
        ? 'missed'
        : dto.disposition === 'busy'
          ? 'rejected'
          : 'completed';
    const durationSeconds =
      callStatus === 'completed'
        ? Math.max(0, Math.round(Number(dto.durationSeconds) || 0))
        : 0;

    let scheduledFor = '';
    let retryType:
      | 'retry_1_2h'
      | 'retry_2_next_day_whatsapp'
      | 'callback_scheduled'
      | 'qualified_hot'
      | 'closed_lost'
      | 'dnd_suppressed' = 'qualified_hot';
    let whatsappSent = false;
    let whatsappStatus = '';
    let taskTitle = '';
    let taskDueDate = '';

    if (dto.disposition === 'rnr' || dto.disposition === 'busy') {
      const nextCount = (lead.rnrRetryCount || 0) + 1;
      lead.rnrRetryCount = nextCount;
      if (lead.status === 'new') {
        lead.status = 'contacted';
      }

      if (nextCount === 1) {
        const retryAt = new Date(now.getTime() + 2 * 60 * 60 * 1000);
        scheduledFor = retryAt.toISOString();
        retryType = 'retry_1_2h';
        taskTitle = `RNR Retry #1 (+2h): Call ${lead.name}`;
        taskDueDate = retryAt.toISOString().slice(0, 10);
      } else {
        const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
        tomorrow.setHours(10, 30, 0, 0);
        scheduledFor = tomorrow.toISOString();
        retryType = 'retry_2_next_day_whatsapp';
        taskTitle = `RNR Retry #${nextCount} (Next Day): Call ${lead.name}`;
        taskDueDate = tomorrow.toISOString().slice(0, 10);
      }
      lead.nextCallRetryAt = scheduledFor;
    } else if (dto.disposition === 'callback') {
      const parsedCallback = dto.callbackAt ? new Date(dto.callbackAt) : null;
      const targetAt =
        parsedCallback && Number.isFinite(parsedCallback.getTime())
          ? parsedCallback
          : new Date(now.getTime() + 4 * 60 * 60 * 1000);
      scheduledFor = targetAt.toISOString();
      retryType = 'callback_scheduled';
      lead.nextCallRetryAt = scheduledFor;
      if (lead.status === 'new') lead.status = 'contacted';
      taskTitle = `Callback Requested: Call ${lead.name}`;
      taskDueDate = targetAt.toISOString().slice(0, 10);
    } else if (dto.disposition === 'interested') {
      retryType = 'qualified_hot';
      lead.nextCallRetryAt = '';
      lead.status = 'qualified';
      lead.aiScore = Math.max(Number(lead.aiScore) || 70, 85);
      lead.aiLabel = 'Hot';
      taskTitle = `Send Quote / Next Step to Hot Lead: ${lead.name}`;
      taskDueDate = now.toISOString().slice(0, 10);
    } else if (dto.disposition === 'not_interested') {
      retryType = 'closed_lost';
      lead.nextCallRetryAt = '';
      lead.status = 'lost';
    } else if (dto.disposition === 'dnd') {
      retryType = 'dnd_suppressed';
      lead.nextCallRetryAt = '';
      lead.doNotCall = true;
      lead.status = 'lost';
      const nextTags = new Set(Array.isArray(lead.tags) ? lead.tags : []);
      nextTags.add('DND');
      lead.tags = Array.from(nextTags);
    }

    lead.lastCalledAt = nowIso;
    lead.lastCallOutcome = dto.disposition;

    const activityDesc = `Power Dialer (${outcomeLabel}${
      durationSeconds > 0 ? ` · ${durationSeconds}s` : ''
    })${scheduledFor ? ` · Next Retry: ${scheduledFor.slice(0, 16).replace('T', ' ')}` : ''}${
      cleanNotes ? `: ${cleanNotes}` : ''
    }`;

    lead.activities = [
      {
        id: randomBytes(6).toString('hex'),
        type: 'call',
        description: activityDesc,
        authorName: auth.name || auth.email.split('@')[0],
        createdAt: nowIso,
      },
      ...(lead.activities || []),
    ];
    await lead.save();

    if (
      retryType === 'retry_2_next_day_whatsapp' &&
      dto.disposition === 'rnr' &&
      dto.sendWhatsAppOnRnr !== false &&
      this.inboxService &&
      lead.phone
    ) {
      const waRes = await this.inboxService
        .dispatchAutomatedWhatsApp({
          tenantId: auth.tenantId,
          userId: auth.userId,
          actorName: auth.name || 'Dialer Auto-Retry',
          linkedEntityType: 'lead',
          linkedEntityId: lead._id.toString(),
          contactName: lead.name,
          company: lead.company || '',
          phone: lead.phone,
          city: lead.city || '',
          estimatedValue: Number(lead.estimatedValue) || 0,
          messageBody: `Hi ${lead.name}, tried calling you from ${companyLabel} regarding your inquiry. Reply here with a good time to connect!`,
          timelineMarker: 'rnr_auto_retry_2',
        })
        .catch(() => null);
      if (waRes && !waRes.skippedDnd && waRes.status !== 'failed') {
        whatsappSent = true;
        whatsappStatus = waRes.status || 'sent';
      }
    }

    let createdTaskId = '';
    if (taskTitle) {
      const task = await this.taskModel.create({
        tenantId: tenantOid,
        ownerId: new Types.ObjectId(auth.userId),
        title: taskTitle,
        description:
          cleanNotes ||
          `${outcomeLabel} logged via Power Dialer${
            scheduledFor ? ` (Scheduled for ${scheduledFor})` : ''
          }`,
        priority:
          dto.disposition === 'interested' || dto.disposition === 'callback'
            ? 'high'
            : 'medium',
        status: 'pending',
        category: 'call',
        dueDate: taskDueDate || nowIso.slice(0, 10),
        relatedName: lead.name,
        relatedCompany: lead.company || '',
        relatedPhone: lead.phone || '',
      });
      createdTaskId = task._id.toString();
    }

    const startedAt = new Date(now.getTime() - Math.max(1, durationSeconds) * 1000);
    const userOid = new Types.ObjectId(auth.userId);
    const callDoc = await this.callLogModel.create({
      tenantId: tenantOid,
      callerId: userOid,
      calleeId: userOid,
      callChannel: 'sim_mobile',
      callerType: 'agent',
      callerName: auth.name,
      callerRole: auth.role,
      callerUserCode: auth.userCode,
      customerPhone: lead.phone || '',
      calleeName: lead.name,
      calleeRole: lead.accountKind === 'consumer' ? 'B2C Consumer' : 'B2B Lead',
      calleeUserCode: '',
      status: callStatus,
      startedAt,
      answeredAt: callStatus === 'completed' ? startedAt : null,
      connectedAt: callStatus === 'completed' ? startedAt : null,
      endedAt: now,
      setupTimeMs: 0,
      durationSeconds,
      endedByUserId: auth.userId,
      endReason: `Power Dialer · ${outcomeLabel}`,
      linkedEntityType: 'lead',
      linkedEntityId: lead._id.toString(),
      linkedEntityLabel: lead.company ? `${lead.name} (${lead.company})` : lead.name,
      notes: cleanNotes,
      outcomeTag: dto.disposition,
      dispositionByUserId: auth.userId,
      dispositionAt: now,
      followUpTaskId: createdTaskId,
    });

    return {
      call: this.toDto(callDoc, auth.userId),
      lead: {
        id: lead._id.toString(),
        name: lead.name,
        status: lead.status,
        rnrRetryCount: Number(lead.rnrRetryCount) || 0,
        nextCallRetryAt: lead.nextCallRetryAt || '',
        lastCallOutcome: lead.lastCallOutcome || '',
        doNotCall: Boolean(lead.doNotCall),
      },
      retryAction: {
        type: retryType,
        scheduledFor,
        whatsappSent,
        whatsappStatus,
        taskId: createdTaskId,
      },
    };
  }

  // ─── Phase 2: Customer Click-to-Call Shareable Links ──────────────────────

  private getJwtSecret(): string {
    return (
      this.configService.get<string>('JWT_SECRET') ||
      'leadsetu_super_secret_access_key_2026'
    );
  }

  async createShareLink(auth: CallAuthContext, dto: CreateCallShareLinkDto) {
    const entityType = dto.entityType || '';
    const entityId = String(dto.entityId || '').trim();
    const snapshot = await this.resolveEntitySnapshot(
      auth.tenantId,
      entityType,
      entityId,
    );

    let agentId = auth.userId;
    if (snapshot?.ownerId && Types.ObjectId.isValid(snapshot.ownerId)) {
      const candidate = await this.userModel
        .findOne({
          _id: new Types.ObjectId(snapshot.ownerId),
          tenantId: new Types.ObjectId(auth.tenantId),
          isActive: true,
        })
        .select({ name: 1, role: 1, userCode: 1 })
        .exec();
      if (candidate) {
        agentId = candidate._id.toString();
      }
    }

    const [agent, tenant] = await Promise.all([
      this.userModel
        .findOne({
          _id: new Types.ObjectId(agentId),
          tenantId: new Types.ObjectId(auth.tenantId),
          isActive: true,
        })
        .select({ name: 1, role: 1, userCode: 1 })
        .exec(),
      this.tenantModel.findById(auth.tenantId).exec(),
    ]);

    if (!agent || !tenant) {
      throw new NotFoundException('Assigned agent or workspace not found.');
    }

    const days = Math.max(1, Math.min(30, Number(dto.expiresInDays) || 7));
    const token = await this.jwtService.signAsync(
      {
        purpose: 'customer_click_to_call',
        tenantId: auth.tenantId,
        agentId: agent._id.toString(),
        entityType: snapshot ? entityType : '',
        entityId: snapshot ? entityId : '',
        entityLabel: snapshot?.entityLabel || '',
        customerName: snapshot?.customerName || '',
        customerPhone: snapshot?.customerPhone || '',
      },
      {
        secret: this.getJwtSecret(),
        expiresIn: `${days}d`,
      },
    );

    return {
      token,
      urlPath: `/call/${token}`,
      agent: {
        userId: agent._id.toString(),
        name: agent.name,
        role: agent.role,
        userCode: agent.userCode || '',
      },
      companyName: tenant.companyName || tenant.name,
      entityType: snapshot ? entityType : '',
      entityId: snapshot ? entityId : '',
      entityLabel: snapshot?.entityLabel || '',
      customerName: snapshot?.customerName || '',
      customerPhone: snapshot?.customerPhone || '',
      expiresInDays: days,
    };
  }

  async verifyPublicCallLinkToken(token?: string) {
    const cleanToken = String(token || '').trim();
    if (!cleanToken) {
      throw new UnauthorizedException('Call link token is required.');
    }

    let payload: {
      purpose?: string;
      tenantId?: string;
      agentId?: string;
      entityType?: '' | 'lead' | 'deal' | 'ticket';
      entityId?: string;
      entityLabel?: string;
      customerName?: string;
      customerPhone?: string;
    };
    try {
      payload = await this.jwtService.verifyAsync(cleanToken, {
        secret: this.getJwtSecret(),
      });
    } catch {
      throw new UnauthorizedException('This call link is invalid or expired.');
    }

    if (
      payload.purpose !== 'customer_click_to_call' ||
      !payload.tenantId ||
      !payload.agentId ||
      !Types.ObjectId.isValid(payload.tenantId) ||
      !Types.ObjectId.isValid(payload.agentId)
    ) {
      throw new UnauthorizedException('Invalid call link payload.');
    }

    const [agent, tenant] = await Promise.all([
      this.userModel
        .findOne({
          _id: new Types.ObjectId(payload.agentId),
          tenantId: new Types.ObjectId(payload.tenantId),
          isActive: true,
        })
        .select({ name: 1, role: 1, territory: 1, userCode: 1 })
        .exec(),
      this.tenantModel.findById(payload.tenantId).exec(),
    ]);

    if (!agent || !tenant || tenant.status === 'suspended') {
      throw new NotFoundException('This voice support link is no longer active.');
    }

    const entityType: '' | 'lead' | 'deal' | 'ticket' =
      payload.entityType === 'lead' ||
      payload.entityType === 'deal' ||
      payload.entityType === 'ticket'
        ? payload.entityType
        : '';

    return {
      tenantId: tenant._id.toString(),
      companyName: tenant.companyName || tenant.name,
      companyLogoUrl: tenant.logoUrl || '',
      agent: {
        userId: agent._id.toString(),
        name: agent.name,
        role: agent.role,
        territory: agent.territory || '',
        userCode: agent.userCode || '',
      },
      entityType,
      entityId: payload.entityId || '',
      entityLabel: payload.entityLabel || '',
      customerName: payload.customerName || '',
      customerPhone: payload.customerPhone || '',
    };
  }

  async getPublicCallLinkInfo(token: string) {
    const info = await this.verifyPublicCallLinkToken(token);
    const status = this.getEffectivePresence(info.tenantId, info.agent.userId);
    const ice = await this.getIceServers({
      userId: info.agent.userId,
      tenantId: info.tenantId,
      email: '',
      role: 'agent',
      name: info.agent.name,
      userCode: info.agent.userCode,
    });

    return {
      valid: true,
      companyName: info.companyName,
      companyLogoUrl: info.companyLogoUrl,
      agent: {
        name: info.agent.name,
        role: info.agent.role,
        territory: info.agent.territory,
        status,
      },
      context: {
        entityType: info.entityType,
        entityLabel: info.entityLabel,
        customerName: info.customerName,
        customerPhone: info.customerPhone,
      },
      iceServers: ice.iceServers,
      iceTransportPolicy: ice.iceTransportPolicy,
    };
  }

  async submitPublicCallbackRequest(token: string, dto: PublicCallCallbackDto) {
    const info = await this.verifyPublicCallLinkToken(token);
    const customerName =
      String(dto.customerName || '').trim() || info.customerName || 'Customer';
    const customerPhone =
      String(dto.customerPhone || '').trim() || info.customerPhone || '';
    const preferredTime = String(dto.preferredTime || '').trim();
    const message = String(dto.message || '').trim();

    if (!customerPhone) {
      throw new BadRequestException('Please provide your phone number.');
    }

    const todayIso = new Date().toISOString().slice(0, 10);
    const descParts = [
      preferredTime ? `Preferred time: ${preferredTime}` : '',
      message ? `Customer note: ${message}` : '',
      info.entityLabel ? `Ref: ${info.entityLabel}` : '',
    ].filter(Boolean);

    const task = await this.taskModel.create({
      tenantId: new Types.ObjectId(info.tenantId),
      ownerId: new Types.ObjectId(info.agent.userId),
      title: `Customer Callback Request: ${customerName}`,
      description: descParts.join(' · ') || 'Requested via Click-to-Call link',
      priority: 'high',
      status: 'pending',
      category: 'call',
      dueDate: todayIso,
      relatedName: customerName,
      relatedCompany: '',
      relatedPhone: customerPhone,
    });

    const now = new Date();
    await this.callLogModel.create({
      tenantId: new Types.ObjectId(info.tenantId),
      callerId: new Types.ObjectId(),
      calleeId: new Types.ObjectId(info.agent.userId),
      callerType: 'customer',
      callerName: customerName,
      callerRole: 'Customer',
      callerUserCode: '',
      customerPhone,
      calleeName: info.agent.name,
      calleeRole: info.agent.role,
      calleeUserCode: info.agent.userCode,
      status: 'missed',
      startedAt: now,
      endedAt: now,
      setupTimeMs: 0,
      durationSeconds: 0,
      endReason: 'Customer callback requested (Agent busy/offline)',
      notes: descParts.join(' · '),
      outcomeTag: 'followup_requested',
      linkedEntityType: info.entityType,
      linkedEntityId: info.entityId,
      linkedEntityLabel: info.entityLabel,
      followUpTaskId: task._id.toString(),
    });

    if (info.entityType && info.entityId) {
      const timelineMsg = `Callback Requested by ${customerName} (${customerPhone})${
        preferredTime ? ` · Best time: ${preferredTime}` : ''
      }${message ? `: ${message}` : ''}`;
      await this.appendCallTimelineToEntity(
        info.tenantId,
        info.entityType,
        info.entityId,
        customerName,
        timelineMsg,
      );
    }

    return {
      ok: true,
      message: 'Callback request logged and assigned to your account manager.',
      followUpTaskId: task._id.toString(),
    };
  }

  // ─── Phase 4: Native Browser Call Recording Storage ──────────────────────

  async saveCallRecording(
    auth: CallAuthContext,
    callId: string,
    dto: UploadCallRecordingDto,
  ) {
    if (!Types.ObjectId.isValid(callId)) {
      throw new BadRequestException('Invalid call ID.');
    }
    const doc = await this.callLogModel
      .findOne({
        _id: new Types.ObjectId(callId),
        tenantId: new Types.ObjectId(auth.tenantId),
      })
      .exec();

    if (!doc) {
      throw new NotFoundException('Call record not found.');
    }

    const isAdmin = ['owner', 'admin', 'super_admin'].includes(auth.role);
    const isParticipant =
      doc.callerId.toString() === auth.userId ||
      doc.calleeId.toString() === auth.userId;
    if (!isParticipant && !isAdmin) {
      throw new ForbiddenException('You are not authorized to save this recording.');
    }

    const rawDataUrl = String(dto.audioDataUrl || '').trim();
    if (!/^(data:(audio|video)\/|https?:\/\/)/i.test(rawDataUrl)) {
      throw new BadRequestException(
        'audioDataUrl must be a valid audio data URL or HTTPS URL.',
      );
    }

    let storedUrl = rawDataUrl;
    try {
      storedUrl = await uploadToCloudinary(rawDataUrl, {
        folder: `leadsetu/tenants/${auth.tenantId}/call-recordings`,
        publicId: `call_${callId}_${Date.now()}`,
        resourceType: 'auto',
      });
    } catch {
      storedUrl = rawDataUrl;
    }

    doc.recordingUrl = storedUrl;
    doc.recordingDurationSeconds = Math.max(
      0,
      Math.round(Number(dto.durationSeconds) || doc.durationSeconds || 0),
    );
    doc.recordedByUserId = auth.userId;
    doc.recordedAt = new Date();
    await doc.save();

    return {
      call: this.toDto(doc, auth.userId),
      recordingUrl: doc.recordingUrl,
    };
  }

  // ─── Phase 5: Live Call Transfer to Another Teammate UID ──────────────────

  async transferCall(
    auth: CallAuthContext,
    params: { callId: string; targetUserCode?: string; targetUserId?: string },
  ) {
    const doc = await this.assertParticipant(auth, params.callId);
    const terminalStatuses: CallLogStatus[] = [
      'completed',
      'rejected',
      'missed',
      'cancelled',
      'timeout',
      'failed',
    ];
    if (terminalStatuses.includes(doc.status)) {
      throw new ConflictException('Call is no longer active.');
    }

    const peerIsCaller = doc.callerId.toString() !== auth.userId;
    const peerUserId = peerIsCaller
      ? doc.callerId.toString()
      : doc.calleeId.toString();
    const peerName = peerIsCaller ? doc.callerName : doc.calleeName;
    const peerRole = peerIsCaller ? doc.callerRole : doc.calleeRole;
    const peerUserCode = peerIsCaller ? doc.callerUserCode : doc.calleeUserCode;

    const cleanTargetId = String(params.targetUserId || '').trim();
    const cleanTargetCode = String(params.targetUserCode || '')
      .replace(/^#/, '')
      .trim();

    let targetAgent: UserDocument | null = null;
    if (cleanTargetId && Types.ObjectId.isValid(cleanTargetId)) {
      targetAgent = await this.userModel
        .findOne({
          _id: new Types.ObjectId(cleanTargetId),
          tenantId: new Types.ObjectId(auth.tenantId),
          isActive: true,
        })
        .select({ name: 1, role: 1, userCode: 1, territory: 1 })
        .exec();
    } else if (cleanTargetCode) {
      targetAgent = await this.userModel
        .findOne({
          userCode: cleanTargetCode,
          tenantId: new Types.ObjectId(auth.tenantId),
          isActive: true,
        })
        .select({ name: 1, role: 1, userCode: 1, territory: 1 })
        .exec();
    } else {
      throw new BadRequestException(
        'Target agent 10-digit UID # or ID is required for transfer.',
      );
    }

    if (!targetAgent) {
      throw new NotFoundException('Transfer target agent not found in workspace.');
    }

    const targetAgentId = targetAgent._id.toString();
    if (targetAgentId === auth.userId || targetAgentId === peerUserId) {
      throw new BadRequestException(
        'Cannot transfer call to yourself or the current caller.',
      );
    }

    const targetPresence = this.getEffectivePresence(
      auth.tenantId,
      targetAgentId,
    );
    if (targetPresence !== 'online') {
      throw new ConflictException(
        `${targetAgent.name} is currently ${targetPresence} and cannot receive a transfer.`,
      );
    }

    const now = new Date();
    const mediaStart = doc.connectedAt || doc.answeredAt;
    if (mediaStart) {
      doc.durationSeconds = Math.max(
        doc.durationSeconds || 0,
        Math.round((now.getTime() - new Date(mediaStart).getTime()) / 1000),
      );
    }
    doc.status = 'completed';
    doc.endedAt = now;
    doc.endedByUserId = auth.userId;
    doc.endReason = `Transferred to ${targetAgent.name}`;
    doc.transferredToUserId = targetAgentId;
    doc.transferredToName = targetAgent.name;
    await doc.save();

    this.releaseCallLocks(
      doc.tenantId.toString(),
      doc.callerId.toString(),
      doc.calleeId.toString(),
      params.callId,
    );

    const newCallObjectId = new Types.ObjectId();
    const newCallId = newCallObjectId.toString();
    const lock = this.tryAcquirePairLock(
      auth.tenantId,
      peerUserId,
      targetAgentId,
      newCallId,
    );
    if (!lock.ok) {
      throw new ConflictException(
        `${targetAgent.name} just joined another call.`,
      );
    }

    try {
      const callerType: 'agent' | 'customer' = peerIsCaller
        ? doc.callerType || 'agent'
        : 'agent';
      const newDoc = await this.callLogModel.create({
        _id: newCallObjectId,
        tenantId: doc.tenantId,
        callerId: new Types.ObjectId(peerUserId),
        calleeId: targetAgent._id,
        callerType,
        callerName: peerName,
        callerRole: peerRole,
        callerUserCode: peerUserCode,
        customerPhone: doc.customerPhone || '',
        calleeName: targetAgent.name,
        calleeRole: targetAgent.role,
        calleeUserCode: targetAgent.userCode || '',
        linkedEntityType: doc.linkedEntityType || '',
        linkedEntityId: doc.linkedEntityId || '',
        linkedEntityLabel: doc.linkedEntityLabel || '',
        notes: doc.notes || '',
        outcomeTag: doc.outcomeTag || '',
        transferredFromUserId: auth.userId,
        transferredFromName: auth.name,
        status: 'ringing',
        startedAt: now,
        setupTimeMs: 0,
        durationSeconds: 0,
      });

      return {
        oldCall: doc,
        newCall: this.toDto(newDoc, peerUserId),
        peerUserId,
        callee: {
          userId: targetAgentId,
          name: targetAgent.name,
          role: targetAgent.role,
          userCode: targetAgent.userCode || '',
          territory: targetAgent.territory || '',
        },
        caller: {
          userId: peerUserId,
          name: peerName,
          role: peerRole,
          userCode: peerUserCode,
          callerType,
          customerPhone: doc.customerPhone || '',
          linkedEntityType: doc.linkedEntityType || '',
          linkedEntityId: doc.linkedEntityId || '',
          linkedEntityLabel: doc.linkedEntityLabel || '',
          transferredFromName: auth.name,
        },
      };
    } catch (err) {
      this.releaseCallLocks(auth.tenantId, peerUserId, targetAgentId, newCallId);
      throw err;
    }
  }

  async getUserAnalytics(auth: CallAuthContext) {
    const tenantOid = new Types.ObjectId(auth.tenantId);
    const isAdminViewer = ['owner', 'admin', 'manager', 'super_admin'].includes(
      auth.role,
    );

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

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
          startedAt: 1,
          outcomeTag: 1,
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
        todayDials: number;
        todayConnected: number;
        todayTalkSeconds: number;
        dispositionBreakdown: Record<string, number>;
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
        todayDials: 0,
        todayConnected: 0,
        todayTalkSeconds: 0,
        dispositionBreakdown: {},
      });
    }

    const isAnswered = (st: string) => st === 'completed' || st === 'connected';
    const isMissed = (st: string) =>
      st === 'missed' || st === 'rejected' || st === 'timeout';

    for (const c of calls) {
      const callerId = c.callerId.toString();
      const calleeId = c.calleeId.toString();
      const dur = Math.max(0, Number(c.durationSeconds) || 0);
      const isToday = c.startedAt ? new Date(c.startedAt) >= startOfToday : false;
      const tag = String(c.outcomeTag || '').trim();

      const callerBucket = statsMap.get(callerId);
      if (callerBucket) {
        callerBucket.totalCalls += 1;
        callerBucket.outgoingCalls += 1;
        if (isToday) callerBucket.todayDials += 1;
        if (isAnswered(c.status)) {
          callerBucket.answeredCalls += 1;
          callerBucket.totalDurationSeconds += dur;
          if (isToday) {
            callerBucket.todayConnected += 1;
            callerBucket.todayTalkSeconds += dur;
          }
        } else if (isMissed(c.status)) {
          callerBucket.missedCalls += 1;
        }
        if (tag) {
          callerBucket.dispositionBreakdown[tag] =
            (callerBucket.dispositionBreakdown[tag] || 0) + 1;
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
        const todayConnectRatePct =
          s.todayDials > 0
            ? Math.round((s.todayConnected / s.todayDials) * 100)
            : 0;
        return {
          userId: uid,
          name: u.name,
          role: u.role,
          userCode: u.userCode || '',
          territory: u.territory || '',
          ...s,
          answerRatePct,
          todayConnectRatePct,
        };
      })
      .sort(
        (a, b) =>
          b.todayDials - a.todayDials ||
          b.totalCalls - a.totalCalls ||
          a.name.localeCompare(b.name),
      );

    return {
      isAdminView: isAdminViewer,
      myStats: items.find((i) => i.userId === auth.userId) || null,
      users: items,
    };
  }

  async getAnalytics(auth: CallAuthContext, scope?: string) {
    if (!['owner', 'admin', 'manager', 'super_admin'].includes(auth.role)) {
      throw new ForbiddenException(
        'Calling analytics is restricted to Workspace Admins, Managers, and Super Admins.',
      );
    }

    const isPlatformScope = auth.role === 'super_admin' && scope === 'platform';
    const filter: Record<string, unknown> = isPlatformScope
      ? {}
      : { tenantId: new Types.ObjectId(auth.tenantId) };

    if (!isPlatformScope && auth.role === 'manager') {
      const teamMembers = await this.userModel
        .find({
          tenantId: new Types.ObjectId(auth.tenantId),
          $or: [
            { _id: new Types.ObjectId(auth.userId) },
            { managerId: auth.userId },
            { role: 'agent' },
          ],
        })
        .select('_id')
        .exec();
      const ids = teamMembers.map((m) => m._id);
      filter.$or = [{ callerId: { $in: ids } }, { calleeId: { $in: ids } }];
    }

    const calls = await this.callLogModel
      .find(filter)
      .sort({ startedAt: -1 })
      .limit(1000)
      .exec();

    const totalCalls = calls.length;
    const webrtcCalls = calls.filter((c) => c.callChannel !== 'sim_mobile');
    const connectedCalls = webrtcCalls.filter(
      (c) => c.status === 'completed' || c.status === 'connected',
    );
    const failedCalls = webrtcCalls.filter((c) => c.status === 'failed');
    const attemptedMediaCount = connectedCalls.length + failedCalls.length;
    const successRatePct =
      attemptedMediaCount > 0
        ? Math.round((connectedCalls.length / attemptedMediaCount) * 100)
        : 0;

    const withSetup = webrtcCalls.filter((c) => (Number(c.setupTimeMs) || 0) > 0);
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

    if (isPlatformScope) {
      const tenantIds = Array.from(
        new Set(calls.map((c) => c.tenantId?.toString()).filter(Boolean)),
      );
      const tenantDocs =
        tenantIds.length > 0
          ? await this.tenantModel
              .find({
                _id: {
                  $in: tenantIds
                    .filter((id) => Types.ObjectId.isValid(id))
                    .map((id) => new Types.ObjectId(id)),
                },
              })
              .select('name accountId')
              .lean()
              .exec()
          : [];
      const tenantMap = new Map(
        tenantDocs.map((t) => [
          t._id.toString(),
          { name: t.name || 'Workspace', accountId: t.accountId || '' },
        ]),
      );

      const byTenant = new Map<
        string,
        {
          totalCalls: number;
          connectedCalls: number;
          failedCalls: number;
          turnRelayCalls: number;
          rttSum: number;
          rttCount: number;
          estimatedRelayBytes: number;
        }
      >();
      for (const c of webrtcCalls) {
        const tid = c.tenantId?.toString() || 'unknown';
        const cur = byTenant.get(tid) || {
          totalCalls: 0,
          connectedCalls: 0,
          failedCalls: 0,
          turnRelayCalls: 0,
          rttSum: 0,
          rttCount: 0,
          estimatedRelayBytes: 0,
        };
        cur.totalCalls += 1;
        if (c.status === 'completed' || c.status === 'connected') {
          cur.connectedCalls += 1;
          if (c.connection?.turnUsed) {
            cur.turnRelayCalls += 1;
            cur.estimatedRelayBytes +=
              Number(c.connection?.bytesSent || 0) +
              Number(c.connection?.bytesReceived || 0);
          }
          if (Number(c.connection?.rttMs || 0) > 0) {
            cur.rttSum += Number(c.connection?.rttMs || 0);
            cur.rttCount += 1;
          }
        }
        if (c.status === 'failed') cur.failedCalls += 1;
        byTenant.set(tid, cur);
      }

      const tenantAggregates = Array.from(byTenant.entries())
        .map(([tid, agg]) => {
          const meta = tenantMap.get(tid);
          return {
            tenantId: tid,
            tenantName: meta?.name || `Workspace ${tid.slice(-4)}`,
            accountId: meta?.accountId || '',
            totalCalls: agg.totalCalls,
            connectedCalls: agg.connectedCalls,
            failedCalls: agg.failedCalls,
            turnRelayCalls: agg.turnRelayCalls,
            turnUsagePct:
              agg.connectedCalls > 0
                ? Math.round((agg.turnRelayCalls / agg.connectedCalls) * 100)
                : 0,
            avgRttMs:
              agg.rttCount > 0 ? Math.round(agg.rttSum / agg.rttCount) : 0,
            estimatedRelayBytes: agg.estimatedRelayBytes,
          };
        })
        .sort((a, b) => b.totalCalls - a.totalCalls);

      // Privacy-safe anonymized technical rows ONLY (no caller/callee names, no personal timestamps)
      const anonymizedCalls = calls.slice(0, 30).map((c) => {
        const tid = c.tenantId?.toString() || '';
        const meta = tenantMap.get(tid);
        const callerIdStr = c.callerId?.toString() || '0000';
        const calleeIdStr = c.calleeId?.toString() || '0000';
        const conn = c.connection || {
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
        return {
          id: c._id.toString(),
          callRef: `call_${c._id.toString().slice(-6)}`,
          tenantId: tid,
          tenantName: meta?.name || 'Workspace',
          accountId: meta?.accountId || '',
          callerRef: `u_***${callerIdStr.slice(-2)}`,
          calleeRef: `u_***${calleeIdStr.slice(-2)}`,
          status: c.status,
          setupTimeMs: c.setupTimeMs || 0,
          endReason: c.endReason || '',
          connection: {
            icePath: conn.icePath,
            turnUsed: conn.turnUsed,
            relayProtocol: conn.relayProtocol,
            rttMs: conn.rttMs,
            maxRttMs: conn.maxRttMs,
            packetsLost: conn.packetsLost,
            iceFailureReason: conn.iceFailureReason || '',
          },
        };
      });

      return {
        scope: 'platform' as const,
        privacyRedacted: true,
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
        tenantAggregates,
        anonymizedCalls,
        recentCalls: [],
      };
    }

    const recentCalls = calls.slice(0, 50).map((c) => ({
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
      scope: 'workspace' as const,
      privacyRedacted: false,
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
      tenantAggregates: [],
      anonymizedCalls: [],
      recentCalls,
    };
  }

  async getCallTelemetry(
    auth: CallAuthContext,
    callId: string,
    supportReason?: string,
    reqMeta?: { ip?: string; userAgent?: string; requestId?: string },
  ) {
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
      !['owner', 'admin', 'manager', 'super_admin'].includes(auth.role)
    ) {
      throw new ForbiddenException('Access denied to this call telemetry.');
    }

    const cleanReason = String(supportReason || '').trim();
    if (auth.role === 'super_admin') {
      if (cleanReason.length < 5) {
        throw new ForbiddenException(
          'Super Admin access to tenant call telemetry requires a support reason or ticket reference (min 5 characters).',
        );
      }

      const targetTenant = await this.tenantModel
        .findById(call.tenantId)
        .select('name accountId securityPolicy')
        .lean()
        .exec();
      if (targetTenant?.securityPolicy?.allowImpersonation === false) {
        throw new ForbiddenException(
          'This customer workspace has disabled external Support Access in its security policy.',
        );
      }

      const callRef = `call_${call._id.toString().slice(-6)}`;
      await this.auditService?.record({
        tenantId: call.tenantId.toString(),
        actorId: auth.userId,
        actorName: auth.name,
        actorEmail: auth.email,
        actorRole: auth.role,
        action: 'support.call_telemetry_accessed',
        entityType: 'security',
        entityId: call._id.toString(),
        entityLabel: `${callRef} (Support Ticket Access)`,
        resourceType: 'call_telemetry',
        resourceId: call._id.toString(),
        summary: `Leadsetu Support (${auth.email}) inspected call telemetry ${callRef}. Reason: ${cleanReason}`,
        severity: 'warning',
        visibility: 'platform',
        ip: reqMeta?.ip || '',
        userAgent: reqMeta?.userAgent || '',
        requestId: reqMeta?.requestId || '',
        metadata: { supportReason: cleanReason, callRef },
      });
    }

    const samples = await this.telemetryModel
      .find({ callId: call._id })
      .sort({ sampledAt: 1 })
      .exec();

    return {
      call:
        auth.role === 'super_admin'
          ? {
              id: call._id.toString(),
              callRef: `call_${call._id.toString().slice(-6)}`,
              tenantId: call.tenantId.toString(),
              callerName: `u_***${call.callerId.toString().slice(-2)}`,
              calleeName: `u_***${call.calleeId.toString().slice(-2)}`,
              status: call.status,
              setupTimeMs: call.setupTimeMs || 0,
              connection: call.connection,
              supportReason: cleanReason,
            }
          : this.toDto(call, auth.userId),
      samples: samples.map((s) => ({
        id: s._id.toString(),
        sampledAt: s.sampledAt.toISOString(),
        reporterUserId:
          auth.role === 'super_admin'
            ? `u_***${s.reporterUserId.toString().slice(-2)}`
            : s.reporterUserId.toString(),
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

  async requestCallSupportReveal(
    auth: CallAuthContext,
    callId: string,
    reason: string,
    reqMeta?: { ip?: string; userAgent?: string; requestId?: string },
  ) {
    if (auth.role !== 'super_admin') {
      throw new ForbiddenException(
        'Only Super Admin operators can request audited support reveal.',
      );
    }
    const cleanReason = String(reason || '').trim();
    if (cleanReason.length < 5) {
      throw new BadRequestException(
        'A valid ticket number or support reason (min 5 characters) is required.',
      );
    }
    if (!Types.ObjectId.isValid(callId)) {
      throw new NotFoundException('Call record not found.');
    }
    const call = await this.callLogModel.findById(callId).exec();
    if (!call) {
      throw new NotFoundException('Call record not found.');
    }

    const targetTenant = await this.tenantModel
      .findById(call.tenantId)
      .select('name accountId securityPolicy')
      .lean()
      .exec();
    if (targetTenant?.securityPolicy?.allowImpersonation === false) {
      throw new ForbiddenException(
        'This customer workspace has disabled external Support Access.',
      );
    }

    const callRef = `call_${call._id.toString().slice(-6)}`;
    await this.auditService?.record({
      tenantId: call.tenantId.toString(),
      actorId: auth.userId,
      actorName: auth.name,
      actorEmail: auth.email,
      actorRole: auth.role,
      action: 'support.call_identity_revealed',
      entityType: 'security',
      entityId: call._id.toString(),
      entityLabel: `${callRef} (Audited Support Access)`,
      resourceType: 'call_log',
      resourceId: call._id.toString(),
      summary: `Support operator ${auth.email} revealed participant identities for ${callRef}. Ticket/Reason: ${cleanReason}`,
      severity: 'critical',
      visibility: 'platform',
      ip: reqMeta?.ip || '',
      userAgent: reqMeta?.userAgent || '',
      requestId: reqMeta?.requestId || '',
      metadata: { supportReason: cleanReason, callRef },
    });

    const samples = await this.telemetryModel
      .find({ callId: call._id })
      .sort({ sampledAt: 1 })
      .exec();

    return {
      callId: call._id.toString(),
      callRef,
      tenantName: targetTenant?.name || 'Workspace',
      accountId: targetTenant?.accountId || '',
      callerName: call.callerName,
      calleeName: call.calleeName,
      startedAt: call.startedAt.toISOString(),
      durationSeconds: call.durationSeconds || 0,
      status: call.status,
      setupTimeMs: call.setupTimeMs || 0,
      supportReason: cleanReason,
      connection: call.connection,
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

  private last10PhoneDigits(raw?: string): string {
    const digits = String(raw || '').replace(/\D/g, '');
    return digits.length >= 10 ? digits.slice(-10) : '';
  }

  /**
   * Returns an instant pre-call context brief (AI Next Best Action, last WhatsApp snippet,
   * and open quote / pending GST invoice balance) for incoming rings, active calls, or power-dial leads.
   */
  async getPreCallContext(
    auth: CallAuthContext,
    query: { entityType?: string; entityId?: string; phone?: string },
  ) {
    const tenantOid = new Types.ObjectId(auth.tenantId);
    const entityType = String(query.entityType || '').trim();
    const entityId = String(query.entityId || '').trim();
    const rawPhone = String(query.phone || '').trim();
    const last10 = this.last10PhoneDigits(rawPhone);
    const phoneRegex = last10
      ? new RegExp(`${last10.slice(0, 5)}\\D*${last10.slice(5)}$`)
      : null;

    let leadDoc: Record<string, unknown> | null = null;
    let dealDoc: Record<string, unknown> | null = null;

    if (entityId && Types.ObjectId.isValid(entityId)) {
      const oid = new Types.ObjectId(entityId);
      if (entityType === 'deal') {
        dealDoc = (await this.dealModel
          .findOne({ _id: oid, tenantId: tenantOid })
          .lean()
          .catch(() => null)) as Record<string, unknown> | null;
      } else if (entityType === 'lead') {
        leadDoc = (await this.leadModel
          .findOne({ _id: oid, tenantId: tenantOid })
          .lean()
          .catch(() => null)) as Record<string, unknown> | null;
      }
    }

    if (!leadDoc && !dealDoc && phoneRegex) {
      leadDoc = (await this.leadModel
        .findOne({ tenantId: tenantOid, phone: { $regex: phoneRegex } })
        .sort({ updatedAt: -1 })
        .lean()
        .catch(() => null)) as Record<string, unknown> | null;
      if (!leadDoc) {
        dealDoc = (await this.dealModel
          .findOne({
            tenantId: tenantOid,
            contactPhone: { $regex: phoneRegex },
          })
          .sort({ updatedAt: -1 })
          .lean()
          .catch(() => null)) as Record<string, unknown> | null;
      }
    }

    const db = this.callLogModel.db;
    const resolvedPhone =
      rawPhone ||
      String(leadDoc?.phone || dealDoc?.contactPhone || '').trim();
    const resolvedLast10 = this.last10PhoneDigits(resolvedPhone);
    const resolvedPhoneRegex = resolvedLast10
      ? new RegExp(`${resolvedLast10.slice(0, 5)}\\D*${resolvedLast10.slice(5)}$`)
      : phoneRegex;

    const convOr: Record<string, unknown>[] = [];
    if (entityId) {
      convOr.push({ linkedEntityId: entityId }, { linkedLeadId: entityId });
    }
    if (resolvedPhoneRegex) {
      convOr.push({ phone: { $regex: resolvedPhoneRegex } });
    }

    const invOr: Record<string, unknown>[] = [];
    if (entityId) {
      invOr.push({ linkedLeadId: entityId }, { linkedDealId: entityId });
    }
    if (leadDoc?._id) invOr.push({ linkedLeadId: String(leadDoc._id) });
    if (dealDoc?._id) invOr.push({ linkedDealId: String(dealDoc._id) });
    if (resolvedPhoneRegex) {
      invOr.push({ phone: { $regex: resolvedPhoneRegex } });
    }

    const [convDoc, invoiceDocs] = await Promise.all([
      convOr.length > 0 && db
        ? db
            .collection('conversations')
            .findOne(
              { tenantId: tenantOid, $or: convOr },
              { sort: { updatedAt: -1 } },
            )
            .catch(() => null)
        : Promise.resolve(null),
      invOr.length > 0 && db
        ? db
            .collection('invoices')
            .find({ tenantId: tenantOid, $or: invOr })
            .sort({ createdAt: -1 })
            .limit(12)
            .toArray()
            .catch(() => [])
        : Promise.resolve([]),
    ]);

    const messages = Array.isArray(convDoc?.messages) ? convDoc.messages : [];
    const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;
    const lastInbound = [...messages]
      .reverse()
      .find((m) => String(m?.direction || '') === 'inbound');
    const chosenMsg = lastInbound || lastMsg;

    let openQuotesCount = 0;
    let pendingInvoicesCount = 0;
    let pendingBalanceInr = 0;
    let latestDocNumber = '';
    for (const inv of invoiceDocs) {
      const docType = String(inv.docType || 'invoice');
      const status = String(inv.status || '');
      if (!latestDocNumber && inv.invoiceNumber) {
        latestDocNumber = String(inv.invoiceNumber);
      }
      if (docType === 'quotation' && !['rejected', 'expired'].includes(status)) {
        openQuotesCount += 1;
      } else if (
        docType !== 'quotation' &&
        ['sent', 'partial', 'overdue', 'draft'].includes(status)
      ) {
        pendingInvoicesCount += 1;
        const grand = Number(inv.grandTotal) || 0;
        const settled =
          (Number(inv.amountPaid) || 0) + (Number(inv.tdsDeducted) || 0);
        pendingBalanceInr += Math.max(0, grand - settled);
      }
    }

    const sourceDoc = dealDoc || leadDoc;
    return {
      found: Boolean(sourceDoc || convDoc || invoiceDocs.length > 0),
      entityType: dealDoc
        ? 'deal'
        : leadDoc
          ? 'lead'
          : (entityType as '' | 'lead' | 'deal' | 'ticket' | 'contact') || '',
      entityId: sourceDoc ? String(sourceDoc._id) : entityId,
      recordName: String(
        dealDoc?.title || leadDoc?.name || convDoc?.contactName || '',
      ),
      company: String(dealDoc?.company || leadDoc?.company || ''),
      stageOrStatus: String(dealDoc?.stage || leadDoc?.status || ''),
      estimatedValue: Number(dealDoc?.value ?? leadDoc?.estimatedValue ?? 0),
      aiScore: Number(sourceDoc?.aiScore || 0),
      aiLabel: String(sourceDoc?.aiLabel || ''),
      aiNextAction: String(
        sourceDoc?.aiNextAction || sourceDoc?.aiInsight || '',
      ),
      lastWhatsApp: chosenMsg
        ? {
            text: String(chosenMsg.content || chosenMsg.body || '').slice(0, 140),
            direction: String(chosenMsg.direction || 'inbound'),
            at: String(chosenMsg.createdAt || convDoc?.updatedAt || ''),
            status: String(convDoc?.status || 'open'),
          }
        : null,
      billing: {
        openQuotesCount,
        pendingInvoicesCount,
        pendingBalanceInr: Math.round(pendingBalanceInr),
        latestDocNumber,
      },
    };
  }

  /**
   * Lists currently active ringing / connecting / connected calls in the workspace for the Manager Live Call Monitor.
   */
  async getActiveCallsMonitor(auth: CallAuthContext) {
    const isManagerOrAdmin = [
      'owner',
      'admin',
      'manager',
      'super_admin',
    ].includes(auth.role);
    if (!isManagerOrAdmin) {
      return { isAdminView: false, activeCalls: [] };
    }

    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const activeDocs = await this.callLogModel
      .find({
        tenantId: new Types.ObjectId(auth.tenantId),
        status: { $in: ['ringing', 'connecting', 'connected'] },
        startedAt: { $gte: threeHoursAgo },
      })
      .sort({ startedAt: -1 })
      .limit(30)
      .exec();

    const nowMs = Date.now();
    const activeCalls = activeDocs.map((doc) => {
      const anchor = doc.connectedAt || doc.answeredAt || doc.startedAt;
      const liveDurationSeconds = Math.max(
        0,
        Math.round((nowMs - new Date(anchor).getTime()) / 1000),
      );
      return {
        id: doc._id.toString(),
        status: doc.status,
        callChannel: doc.callChannel || 'webrtc',
        callerType: doc.callerType || 'agent',
        callerName: doc.callerName || 'Agent',
        callerUserCode: doc.callerUserCode || '',
        calleeName: doc.calleeName || doc.linkedEntityLabel || 'Participant',
        calleeUserCode: doc.calleeUserCode || '',
        customerPhone: doc.customerPhone || '',
        linkedEntityType: doc.linkedEntityType || '',
        linkedEntityId: doc.linkedEntityId || '',
        linkedEntityLabel: doc.linkedEntityLabel || '',
        startedAt: doc.startedAt.toISOString(),
        connectedAt: doc.connectedAt
          ? new Date(doc.connectedAt).toISOString()
          : null,
        liveDurationSeconds,
        icePath: doc.connection?.icePath || 'direct',
        turnUsed: Boolean(doc.connection?.turnUsed),
        rttMs: Number(doc.connection?.rttMs || 0),
      };
    });

    return {
      isAdminView: true,
      activeCalls,
    };
  }

  /**
   * 1-Click AI Transcription, Objection Extraction, Sentiment & Suggested Follow-Up Task for a CallLog.
   */
  async transcribeAndAnalyzeCall(
    auth: CallAuthContext,
    callId: string,
    body?: { customTranscript?: string; forceRefresh?: boolean },
  ) {
    if (!Types.ObjectId.isValid(callId)) {
      throw new BadRequestException('Invalid call ID.');
    }

    const doc = await this.callLogModel
      .findOne({
        _id: new Types.ObjectId(callId),
        tenantId: new Types.ObjectId(auth.tenantId),
      })
      .exec();

    if (!doc) {
      throw new NotFoundException('Call record not found.');
    }

    const isAdmin = ['owner', 'admin', 'manager', 'super_admin'].includes(
      auth.role,
    );
    const isParticipant =
      doc.callerId.toString() === auth.userId ||
      doc.calleeId.toString() === auth.userId;
    if (!isParticipant && !isAdmin) {
      throw new ForbiddenException(
        'You are not authorized to analyze this call.',
      );
    }

    if (doc.aiTranscribedAt && doc.aiSummary && !body?.forceRefresh) {
      return {
        cached: true,
        call: this.toDto(doc, auth.userId),
      };
    }

    const peerLabel =
      doc.linkedEntityLabel ||
      (doc.callerType === 'customer' ? doc.callerName : doc.calleeName) ||
      'Prospect';
    const durSec = Number(
      doc.recordingDurationSeconds || doc.durationSeconds || 0,
    );
    const rawInputNotes = [
      body?.customTranscript?.trim(),
      doc.notes?.trim(),
      doc.outcomeTag ? `Outcome tag: ${doc.outcomeTag}` : '',
    ]
      .filter(Boolean)
      .join(' | ');

    let aiStructured: Record<string, unknown> | undefined;
    let aiResultText = '';

    if (this.aiBridge) {
      try {
        const aiRes = await this.aiBridge.auditCall({
          tenantId: auth.tenantId,
          userId: auth.userId,
          userRole: auth.role,
          context: {
            callId,
            peerName: peerLabel,
            recordingUrl: doc.recordingUrl || '',
            durationSeconds: durSec,
            callChannel: doc.callChannel || 'webrtc',
            outcomeTag: doc.outcomeTag || '',
            notes: rawInputNotes,
            linkedEntityType: doc.linkedEntityType || '',
            linkedEntityLabel: doc.linkedEntityLabel || '',
          },
        });
        aiStructured = aiRes?.structured;
        aiResultText = String(aiRes?.result || '').trim();
      } catch {
        // Fallback to local structured call analysis when external AI microservice is offline
      }
    }

    const rawTextForHeuristics = `${rawInputNotes} ${aiResultText}`.toLowerCase();
    const detectedObjections: string[] = [];
    if (
      Array.isArray(aiStructured?.objections) &&
      aiStructured.objections.length > 0
    ) {
      for (const obj of aiStructured.objections.slice(0, 5)) {
        const s = String(obj || '').trim();
        if (s) detectedObjections.push(s);
      }
    } else {
      if (/price|cost|discount|expensive|budget|rate/.test(rawTextForHeuristics)) {
        detectedObjections.push('Pricing / bulk discount confirmation requested');
      }
      if (/gst|invoice|proforma|tax|bill|credit|payment/.test(rawTextForHeuristics)) {
        detectedObjections.push('Needs GST proforma / payment terms clarification');
      }
      if (/time|delivery|dispatch|later|callback|busy/.test(rawTextForHeuristics)) {
        detectedObjections.push('Requested follow-up / delivery timeline confirmation');
      }
      if (/competitor|other|compare|quote/.test(rawTextForHeuristics)) {
        detectedObjections.push('Comparing vendor quotes before final approval');
      }
      if (doc.outcomeTag === 'rnr' || doc.outcomeTag === 'busy') {
        detectedObjections.push('Prospect unreachable — needs multi-channel WhatsApp nudge');
      }
      if (detectedObjections.length === 0) {
        detectedObjections.push('No major blockers raised — ready for next step');
      }
    }

    const rawSent = String(aiStructured?.sentiment || '').toLowerCase();
    let sentiment: 'positive' | 'neutral' | 'negative' | 'mixed' = 'neutral';
    if (
      rawSent === 'positive' ||
      rawSent === 'neutral' ||
      rawSent === 'negative' ||
      rawSent === 'mixed'
    ) {
      sentiment = rawSent;
    } else if (
      doc.outcomeTag === 'interested' ||
      /interested|confirm|deal|send quote|order/.test(rawTextForHeuristics)
    ) {
      sentiment = detectedObjections.some((o) => o.includes('Pricing') || o.includes('Comparing'))
        ? 'mixed'
        : 'positive';
    } else if (
      doc.outcomeTag === 'not_interested' ||
      doc.outcomeTag === 'dnd' ||
      /not interested|cancel|stop|dnd/.test(rawTextForHeuristics)
    ) {
      sentiment = 'negative';
    } else if (detectedObjections.length > 0 && durSec > 20) {
      sentiment = 'mixed';
    }

    const transcriptText =
      String(aiStructured?.transcript || '').trim() ||
      (body?.customTranscript?.trim()
        ? body.customTranscript.trim()
        : [
            `[00:00] ${doc.callerName || 'Agent'}: Connected with ${peerLabel} (${doc.callChannel === 'sim_mobile' ? 'SIM Mobile' : 'CRM WebRTC Audio'}, ${durSec}s).`,
            doc.notes?.trim()
              ? `[00:${String(Math.min(59, Math.max(8, Math.floor(durSec / 2)))).padStart(2, '0')}] Discussion Notes: ${doc.notes.trim()}`
              : `[00:12] Customer Inquiry: Reviewed requirement specs, pricing & GST delivery schedule for ${peerLabel}.`,
            `[End] Disposition: ${doc.outcomeTag ? doc.outcomeTag.toUpperCase() : doc.status.toUpperCase()} · Audio Source: ${doc.recordingUrl ? 'Verified Recording' : 'Call Metadata Log'}.`,
          ].join('\n'));

    const summaryText =
      String(aiStructured?.summary || '').trim() ||
      aiResultText ||
      `${durSec}s ${doc.callChannel === 'sim_mobile' ? 'mobile' : 'WebRTC'} call with ${peerLabel}. ${
        doc.notes?.trim()
          ? `Key notes: ${doc.notes.trim()}. `
          : ''
      }Sentiment assessed as ${sentiment.toUpperCase()} with ${detectedObjections.length} tracked talking point(s).`;

    const suggestedTaskTitle =
      String(aiStructured?.nextAction || aiStructured?.suggestedTask || '').trim() ||
      (sentiment === 'positive' || sentiment === 'mixed'
        ? `Send GST Proforma & Follow Up — ${peerLabel}`
        : `Follow-up check-in call with ${peerLabel}`);

    const suggestedPriority: 'high' | 'medium' | 'low' =
      sentiment === 'positive' || sentiment === 'mixed'
        ? 'high'
        : sentiment === 'negative'
          ? 'low'
          : 'medium';

    doc.aiTranscript = transcriptText;
    doc.aiSummary = summaryText;
    doc.aiObjections = detectedObjections.slice(0, 5);
    doc.aiSentiment = sentiment;
    doc.aiSuggestedTaskTitle = suggestedTaskTitle;
    doc.aiSuggestedTaskPriority = suggestedPriority;
    doc.aiTranscribedAt = new Date();
    await doc.save();

    await this.auditService?.record({
      tenantId: auth.tenantId,
      actorId: auth.userId,
      actorEmail: auth.email,
      action: 'call.ai_transcribed',
      entityType: 'security',
      entityId: doc._id.toString(),
      entityLabel: peerLabel,
      summary: `AI transcribed & summarized call with ${peerLabel} (${sentiment})`,
    });

    return {
      cached: false,
      call: this.toDto(doc, auth.userId),
    };
  }

  /**
   * 1-Click converts a CallLog's AI-suggested follow-up into a real TaskItem linked to the CRM record.
   */
  async createSuggestedTaskFromCall(
    auth: CallAuthContext,
    callId: string,
    overrideTitle?: string,
  ) {
    if (!Types.ObjectId.isValid(callId)) {
      throw new BadRequestException('Invalid call ID.');
    }
    const doc = await this.callLogModel
      .findOne({
        _id: new Types.ObjectId(callId),
        tenantId: new Types.ObjectId(auth.tenantId),
      })
      .exec();

    if (!doc) {
      throw new NotFoundException('Call record not found.');
    }

    const title =
      overrideTitle?.trim() ||
      doc.aiSuggestedTaskTitle?.trim() ||
      `Follow up after call with ${doc.linkedEntityLabel || doc.calleeName}`;

    const due = new Date(Date.now() + 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);

    const taskDoc = await this.taskModel.create({
      tenantId: new Types.ObjectId(auth.tenantId),
      ownerId: new Types.ObjectId(auth.userId),
      title,
      priority: doc.aiSuggestedTaskPriority || 'medium',
      category: 'call',
      dueDate: due,
      status: 'pending',
      relatedName: doc.linkedEntityLabel || doc.calleeName || '',
      relatedPhone: doc.customerPhone || '',
      relatedEntityType: doc.linkedEntityType || '',
      relatedEntityId: doc.linkedEntityId || '',
      notes: doc.aiSummary || doc.notes || '',
    });

    doc.followUpTaskId = taskDoc._id.toString();
    await doc.save();

    return {
      call: this.toDto(doc, auth.userId),
      taskId: taskDoc._id.toString(),
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
      callChannel: doc.callChannel || 'webrtc',
      callerType: doc.callerType || 'agent',
      customerPhone: doc.customerPhone || '',
      linkedEntityType: doc.linkedEntityType || '',
      linkedEntityId: doc.linkedEntityId || '',
      linkedEntityLabel: doc.linkedEntityLabel || '',
      notes: doc.notes || '',
      outcomeTag: doc.outcomeTag || '',
      followUpTaskId: doc.followUpTaskId || '',
      dispositionAt: doc.dispositionAt
        ? new Date(doc.dispositionAt).toISOString()
        : null,
      callbackResolved: Boolean(doc.callbackResolved),
      callbackResolvedAt: doc.callbackResolvedAt
        ? new Date(doc.callbackResolvedAt).toISOString()
        : null,
      recordingUrl: doc.recordingUrl || '',
      recordingDurationSeconds: doc.recordingDurationSeconds || 0,
      recordedAt: doc.recordedAt ? new Date(doc.recordedAt).toISOString() : null,
      transferredFromName: doc.transferredFromName || '',
      transferredToName: doc.transferredToName || '',
      aiTranscript: doc.aiTranscript || '',
      aiSummary: doc.aiSummary || '',
      aiObjections: Array.isArray(doc.aiObjections) ? doc.aiObjections : [],
      aiSentiment: doc.aiSentiment || '',
      aiSuggestedTaskTitle: doc.aiSuggestedTaskTitle || '',
      aiSuggestedTaskPriority: doc.aiSuggestedTaskPriority || 'medium',
      aiTranscribedAt: doc.aiTranscribedAt
        ? new Date(doc.aiTranscribedAt).toISOString()
        : null,
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
