import { Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Types } from 'mongoose';
import type { Server, Socket } from 'socket.io';
import {
  CALL_RING_TIMEOUT_MS,
  CallsService,
} from './calls.service';
import type {
  AgentPresenceStatus,
  CallAuthContext,
  CallTelemetrySnapshotDto,
} from './dto/calls.dto';

function tenantRoom(tenantId: string): string {
  return `tenant:${tenantId}`;
}

function userRoom(tenantId: string, userId: string): string {
  return `user:${tenantId}:${userId}`;
}

@WebSocketGateway({
  namespace: '/calls',
  cors: {
    origin: true,
    credentials: true,
  },
})
export class CallsGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(CallsGateway.name);

  constructor(private readonly callsService: CallsService) {}

  private extractHandshakeToken(client: Socket): string {
    const authToken = client.handshake?.auth?.token;
    if (typeof authToken === 'string' && authToken.trim()) {
      return authToken.replace(/^Bearer\s+/i, '').trim();
    }
    const authHeader = client.handshake?.headers?.authorization;
    if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      return authHeader.slice(7).trim();
    }
    const queryToken = client.handshake?.query?.token;
    if (typeof queryToken === 'string' && queryToken.trim()) {
      return queryToken.replace(/^Bearer\s+/i, '').trim();
    }
    return '';
  }

  private extractHandshakeCallToken(client: Socket): string {
    const callToken = client.handshake?.auth?.callToken;
    if (typeof callToken === 'string' && callToken.trim()) {
      return callToken.trim();
    }
    const queryCallToken = client.handshake?.query?.callToken;
    if (typeof queryCallToken === 'string' && queryCallToken.trim()) {
      return queryCallToken.trim();
    }
    return '';
  }

  private getSocketAuth(client: Socket): CallAuthContext | null {
    return (client.data as { auth?: CallAuthContext })?.auth || null;
  }

  private async broadcastTenantPresence(tenantId: string) {
    try {
      const snapshot =
        await this.callsService.getTenantPresenceSnapshot(tenantId);
      const roomSockets = await this.server
        .in(tenantRoom(tenantId))
        .fetchSockets();

      for (const sock of roomSockets) {
        const sockAuth = (sock.data as { auth?: CallAuthContext })?.auth;
        if (!sockAuth) continue;
        const scoped = this.callsService.filterPresenceForViewer(
          snapshot,
          sockAuth,
        );
        sock.emit('presence:update', scoped);
      }
    } catch {
      // Ignore transient broadcast failures
    }
  }

  async handleConnection(client: Socket) {
    try {
      const token = this.extractHandshakeToken(client);
      if (token) {
        const auth = await this.callsService.verifyRawToken(token);
        (client.data as { auth: CallAuthContext }).auth = auth;

        await client.join(tenantRoom(auth.tenantId));
        await client.join(userRoom(auth.tenantId, auth.userId));

        this.callsService.registerSocket(auth.tenantId, auth.userId, client.id);

        const snapshot = await this.callsService.getTenantPresenceSnapshot(
          auth.tenantId,
        );
        client.emit(
          'presence:snapshot',
          this.callsService.filterPresenceForViewer(snapshot, auth),
        );
        await this.broadcastTenantPresence(auth.tenantId);
        return;
      }

      const callToken = this.extractHandshakeCallToken(client);
      if (!callToken) {
        throw new Error('Authentication token is required.');
      }

      const info = await this.callsService.verifyPublicCallLinkToken(callToken);
      const guestUserId = new Types.ObjectId().toString();
      const guestAuth: CallAuthContext = {
        userId: guestUserId,
        tenantId: info.tenantId,
        email: '',
        role: 'customer',
        name: info.customerName || 'Customer',
        userCode: '',
        isGuestCustomer: true,
        targetAgentId: info.agent.userId,
        linkedEntityType: info.entityType,
        linkedEntityId: info.entityId,
        linkedEntityLabel: info.entityLabel,
        customerPhone: info.customerPhone,
      };
      (client.data as { auth: CallAuthContext }).auth = guestAuth;

      await client.join(userRoom(guestAuth.tenantId, guestAuth.userId));
      this.callsService.registerSocket(
        guestAuth.tenantId,
        guestAuth.userId,
        client.id,
      );

      client.emit('agent:presence', {
        status: this.callsService.getEffectivePresence(
          info.tenantId,
          info.agent.userId,
        ),
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Unauthorized WebSocket session.';
      this.logger.warn(`Rejected /calls socket ${client.id}: ${message}`);
      client.emit('call:error', { message, code: 'UNAUTHORIZED' });
      client.disconnect(true);
    }
  }

  async handleDisconnect(client: Socket) {
    const auth = this.getSocketAuth(client);
    if (!auth) return;

    const { remainingSockets, activeCallId } =
      this.callsService.unregisterSocket(
        auth.tenantId,
        auth.userId,
        client.id,
      );

    if (remainingSockets === 0 && activeCallId) {
      const ended = await this.callsService.endActiveCallOnDisconnect(
        auth.tenantId,
        auth.userId,
        activeCallId,
      );
      if (ended) {
        const payload = {
          callId: ended._id.toString(),
          status: ended.status,
          durationSeconds: ended.durationSeconds,
          reason:
            ended.endReason ||
            (auth.isGuestCustomer
              ? 'Customer disconnected'
              : 'Agent disconnected'),
          endedAt: ended.endedAt ? ended.endedAt.toISOString() : null,
        };
        this.server
          .to(userRoom(auth.tenantId, ended.callerId.toString()))
          .emit('call:ended', payload);
        this.server
          .to(userRoom(auth.tenantId, ended.calleeId.toString()))
          .emit('call:ended', payload);
      }
      await this.broadcastTenantPresence(auth.tenantId);
      return;
    }

    if (!auth.isGuestCustomer) {
      await this.broadcastTenantPresence(auth.tenantId);
    }
  }

  @SubscribeMessage('presence:set')
  async handlePresenceSet(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { status?: AgentPresenceStatus },
  ) {
    const auth = this.getSocketAuth(client);
    if (!auth || auth.isGuestCustomer) {
      return { ok: false, error: 'Unauthorized' };
    }

    const requested = body?.status;
    if (
      requested !== 'online' &&
      requested !== 'busy' &&
      requested !== 'offline'
    ) {
      return { ok: false, error: 'Invalid presence status.' };
    }

    const effective = this.callsService.setManualPresence(
      auth.tenantId,
      auth.userId,
      requested,
    );
    await this.broadcastTenantPresence(auth.tenantId);
    return { ok: true, status: effective };
  }

  @SubscribeMessage('call:initiate')
  async handleCallInitiate(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    body: {
      calleeId?: string;
      calleeUserCode?: string;
      customerName?: string;
      customerPhone?: string;
      linkedEntityType?: '' | 'lead' | 'deal' | 'ticket';
      linkedEntityId?: string;
      linkedEntityLabel?: string;
    },
  ) {
    const auth = this.getSocketAuth(client);
    if (!auth) return { ok: false, error: 'Unauthorized' };

    try {
      const res = await this.callsService.initiateCall(auth, {
        calleeId: body?.calleeId,
        calleeUserCode: body?.calleeUserCode,
        customerName: body?.customerName,
        customerPhone: body?.customerPhone,
        linkedEntityType: body?.linkedEntityType,
        linkedEntityId: body?.linkedEntityId,
        linkedEntityLabel: body?.linkedEntityLabel,
      });
      const callId = res.call.id;

      // Server-enforced 30s ring timeout
      this.callsService.setRingTimer(callId, () => {
        void (async () => {
          const timedOut = await this.callsService.markRingTimeout(callId);
          if (!timedOut) return;
          const payload = {
            callId,
            status: 'timeout',
            reason: 'No answer within 30 seconds',
          };
          this.server
            .to(userRoom(auth.tenantId, timedOut.callerId.toString()))
            .emit('call:timeout', payload);
          this.server
            .to(userRoom(auth.tenantId, timedOut.calleeId.toString()))
            .emit('call:timeout', payload);
          await this.broadcastTenantPresence(auth.tenantId);
        })();
      });

      this.server
        .to(userRoom(auth.tenantId, auth.userId))
        .emit('call:ringing', {
          callId,
          callee: res.callee,
          startedAt: res.call.startedAt,
          timeoutSec: Math.round(CALL_RING_TIMEOUT_MS / 1000),
          initiatorSocketId: client.id,
        });

      this.server
        .to(userRoom(auth.tenantId, res.callee.userId))
        .emit('call:incoming', {
          callId,
          caller: res.caller,
          startedAt: res.call.startedAt,
          timeoutSec: Math.round(CALL_RING_TIMEOUT_MS / 1000),
        });

      await this.broadcastTenantPresence(auth.tenantId);
      return { ok: true, call: res.call, callee: res.callee };
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Unable to initiate call.';
      client.emit('call:error', { message });
      return { ok: false, error: message };
    }
  }

  @SubscribeMessage('call:accept')
  async handleCallAccept(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { callId?: string },
  ) {
    const auth = this.getSocketAuth(client);
    if (!auth) return { ok: false, error: 'Unauthorized' };

    try {
      const doc = await this.callsService.acceptCall(
        auth,
        String(body?.callId || ''),
      );
      const callId = doc._id.toString();

      this.server
        .to(userRoom(auth.tenantId, doc.callerId.toString()))
        .emit('call:accepted', {
          callId,
          calleeId: auth.userId,
          answeredAt: doc.answeredAt?.toISOString() || new Date().toISOString(),
        });

      // Dismiss incoming popup on any other open tabs of the callee
      this.server
        .to(userRoom(auth.tenantId, auth.userId))
        .except(client.id)
        .emit('call:accepted_elsewhere', { callId });

      return { ok: true, callId };
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Unable to accept call.';
      client.emit('call:error', { message });
      return { ok: false, error: message };
    }
  }

  @SubscribeMessage('call:reject')
  async handleCallReject(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { callId?: string },
  ) {
    const auth = this.getSocketAuth(client);
    if (!auth) return { ok: false, error: 'Unauthorized' };

    try {
      const doc = await this.callsService.rejectCall(
        auth,
        String(body?.callId || ''),
      );
      const callId = doc._id.toString();
      const payload = {
        callId,
        status: 'rejected',
        reason: 'Declined by recipient',
      };

      this.server
        .to(userRoom(auth.tenantId, doc.callerId.toString()))
        .emit('call:rejected', payload);
      this.server
        .to(userRoom(auth.tenantId, doc.calleeId.toString()))
        .emit('call:rejected', payload);

      await this.broadcastTenantPresence(auth.tenantId);
      return { ok: true };
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Unable to reject call.';
      client.emit('call:error', { message });
      return { ok: false, error: message };
    }
  }

  @SubscribeMessage('call:offer')
  async handleOffer(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { callId?: string; sdp?: unknown },
  ) {
    const auth = this.getSocketAuth(client);
    if (!auth) return { ok: false, error: 'Unauthorized' };

    try {
      const doc = await this.callsService.assertParticipant(
        auth,
        String(body?.callId || ''),
      );
      const peerId =
        doc.callerId.toString() === auth.userId
          ? doc.calleeId.toString()
          : doc.callerId.toString();

      this.server.to(userRoom(auth.tenantId, peerId)).emit('call:offer', {
        callId: doc._id.toString(),
        fromUserId: auth.userId,
        sdp: body?.sdp,
      });
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Offer relay failed.',
      };
    }
  }

  @SubscribeMessage('call:answer')
  async handleAnswer(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { callId?: string; sdp?: unknown },
  ) {
    const auth = this.getSocketAuth(client);
    if (!auth) return { ok: false, error: 'Unauthorized' };

    try {
      const doc = await this.callsService.assertParticipant(
        auth,
        String(body?.callId || ''),
      );
      const peerId =
        doc.callerId.toString() === auth.userId
          ? doc.calleeId.toString()
          : doc.callerId.toString();

      this.server.to(userRoom(auth.tenantId, peerId)).emit('call:answer', {
        callId: doc._id.toString(),
        fromUserId: auth.userId,
        sdp: body?.sdp,
      });
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Answer relay failed.',
      };
    }
  }

  @SubscribeMessage('call:ice')
  async handleIceCandidate(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { callId?: string; candidate?: unknown },
  ) {
    const auth = this.getSocketAuth(client);
    if (!auth) return { ok: false, error: 'Unauthorized' };

    try {
      const doc = await this.callsService.assertParticipant(
        auth,
        String(body?.callId || ''),
      );
      const peerId =
        doc.callerId.toString() === auth.userId
          ? doc.calleeId.toString()
          : doc.callerId.toString();

      this.server.to(userRoom(auth.tenantId, peerId)).emit('call:ice', {
        callId: doc._id.toString(),
        fromUserId: auth.userId,
        candidate: body?.candidate,
      });
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'ICE relay failed.',
      };
    }
  }

  @SubscribeMessage('call:ice_restart_request')
  async handleIceRestartRequest(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { callId?: string; reason?: string },
  ) {
    const auth = this.getSocketAuth(client);
    if (!auth) return { ok: false, error: 'Unauthorized' };

    try {
      const doc = await this.callsService.assertParticipant(
        auth,
        String(body?.callId || ''),
      );
      const callerRoom = userRoom(auth.tenantId, doc.callerId.toString());
      this.server.to(callerRoom).emit('call:ice_restart_request', {
        callId: doc._id.toString(),
        fromUserId: auth.userId,
        reason: body?.reason || 'network_change',
      });
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  @SubscribeMessage('call:media_connected')
  async handleMediaConnected(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { callId?: string },
  ) {
    const auth = this.getSocketAuth(client);
    if (!auth) return { ok: false, error: 'Unauthorized' };

    try {
      const doc = await this.callsService.markMediaConnected(
        auth,
        String(body?.callId || ''),
      );
      const payload = {
        callId: doc._id.toString(),
        connectedAt: doc.connectedAt?.toISOString() || new Date().toISOString(),
        setupTimeMs: doc.setupTimeMs || 0,
      };
      this.server
        .to(userRoom(auth.tenantId, doc.callerId.toString()))
        .emit('call:connected', payload);
      this.server
        .to(userRoom(auth.tenantId, doc.calleeId.toString()))
        .emit('call:connected', payload);
      return { ok: true, ...payload };
    } catch (err) {
      return {
        ok: false,
        error:
          err instanceof Error ? err.message : 'Failed to mark media connected.',
      };
    }
  }

  @SubscribeMessage('call:mute_state')
  async handleMuteState(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { callId?: string; isMuted?: boolean },
  ) {
    const auth = this.getSocketAuth(client);
    if (!auth) return { ok: false, error: 'Unauthorized' };

    try {
      const doc = await this.callsService.assertParticipant(
        auth,
        String(body?.callId || ''),
      );
      const peerId =
        doc.callerId.toString() === auth.userId
          ? doc.calleeId.toString()
          : doc.callerId.toString();

      this.server.to(userRoom(auth.tenantId, peerId)).emit('call:mute_state', {
        callId: doc._id.toString(),
        fromUserId: auth.userId,
        isMuted: Boolean(body?.isMuted),
      });
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  @SubscribeMessage('call:telemetry')
  async handleTelemetry(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    body: { callId?: string; sample?: CallTelemetrySnapshotDto },
  ) {
    const auth = this.getSocketAuth(client);
    if (!auth || !body?.callId || !body?.sample) {
      return { ok: false };
    }
    try {
      await this.callsService.recordTelemetrySample(
        auth,
        body.callId,
        body.sample,
      );
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  @SubscribeMessage('call:hold_state')
  async handleHoldState(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { callId?: string; isOnHold?: boolean },
  ) {
    const auth = this.getSocketAuth(client);
    if (!auth) return { ok: false, error: 'Unauthorized' };

    try {
      const doc = await this.callsService.assertParticipant(
        auth,
        String(body?.callId || ''),
      );
      const peerId =
        doc.callerId.toString() === auth.userId
          ? doc.calleeId.toString()
          : doc.callerId.toString();

      this.server.to(userRoom(auth.tenantId, peerId)).emit('call:hold_state', {
        callId: doc._id.toString(),
        fromUserId: auth.userId,
        isOnHold: Boolean(body?.isOnHold),
      });
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  @SubscribeMessage('call:transfer')
  async handleCallTransfer(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    body: { callId?: string; targetUserCode?: string; targetUserId?: string },
  ) {
    const auth = this.getSocketAuth(client);
    if (!auth) return { ok: false, error: 'Unauthorized' };

    try {
      const res = await this.callsService.transferCall(auth, {
        callId: String(body?.callId || ''),
        targetUserCode: body?.targetUserCode,
        targetUserId: body?.targetUserId,
      });

      const newCallId = res.newCall.id;
      this.callsService.setRingTimer(newCallId, () => {
        void (async () => {
          const timedOut = await this.callsService.markRingTimeout(newCallId);
          if (!timedOut) return;
          const timeoutPayload = {
            callId: newCallId,
            status: 'timeout',
            reason: 'No answer within 30 seconds',
          };
          this.server
            .to(userRoom(auth.tenantId, timedOut.callerId.toString()))
            .emit('call:timeout', timeoutPayload);
          this.server
            .to(userRoom(auth.tenantId, timedOut.calleeId.toString()))
            .emit('call:timeout', timeoutPayload);
          await this.broadcastTenantPresence(auth.tenantId);
        })();
      });

      this.server
        .to(userRoom(auth.tenantId, res.peerUserId))
        .emit('call:transferred_outgoing', {
          oldCallId: res.oldCall._id.toString(),
          newCallId,
          startedAt: res.newCall.startedAt,
          callee: res.callee,
          transferredFromName: auth.name,
          timeoutSec: Math.round(CALL_RING_TIMEOUT_MS / 1000),
        });

      this.server
        .to(userRoom(auth.tenantId, res.callee.userId))
        .emit('call:incoming', {
          callId: newCallId,
          caller: res.caller,
          startedAt: res.newCall.startedAt,
          timeoutSec: Math.round(CALL_RING_TIMEOUT_MS / 1000),
        });

      await this.broadcastTenantPresence(auth.tenantId);
      return { ok: true, newCallId, callee: res.callee };
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Unable to transfer call.';
      return { ok: false, error: message };
    }
  }

  @SubscribeMessage('call:end')
  async handleCallEnd(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    body: {
      callId?: string;
      reason?: string;
      failed?: boolean;
      finalTelemetry?: CallTelemetrySnapshotDto;
    },
  ) {
    const auth = this.getSocketAuth(client);
    if (!auth) return { ok: false, error: 'Unauthorized' };

    try {
      const doc = await this.callsService.endCall(
        auth,
        String(body?.callId || ''),
        {
          reason: body?.reason,
          failed: body?.failed,
          finalTelemetry: body?.finalTelemetry,
        },
      );
      const payload = {
        callId: doc._id.toString(),
        status: doc.status,
        durationSeconds: doc.durationSeconds || 0,
        reason: doc.endReason || 'Call ended',
        endedAt: doc.endedAt ? doc.endedAt.toISOString() : null,
      };
      this.server
        .to(userRoom(auth.tenantId, doc.callerId.toString()))
        .emit('call:ended', payload);
      this.server
        .to(userRoom(auth.tenantId, doc.calleeId.toString()))
        .emit('call:ended', payload);

      await this.broadcastTenantPresence(auth.tenantId);
      return { ok: true, ...payload };
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Unable to end call.';
      return { ok: false, error: message };
    }
  }
}
