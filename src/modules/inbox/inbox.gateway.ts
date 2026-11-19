import { Logger, OnModuleInit } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { InboxService } from './inbox.service';

export type InboxRealtimeEventType =
  | 'message.inbound'
  | 'message.outbound'
  | 'message.status'
  | 'conversation.updated';

function tenantRoom(tenantId: string): string {
  return `tenant:${tenantId}`;
}

@WebSocketGateway({
  namespace: '/inbox',
  cors: {
    origin: true,
    credentials: true,
  },
})
export class InboxGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnModuleInit
{
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(InboxGateway.name);

  constructor(private readonly inboxService: InboxService) {}

  onModuleInit() {
    this.inboxService.registerRealtimeEmitter(
      (tenantId, conversation, eventType) => {
        this.broadcastConversationUpdate(tenantId, conversation, eventType);
      },
    );
  }

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

  async handleConnection(client: Socket) {
    try {
      const token = this.extractHandshakeToken(client);
      if (!token) {
        client.disconnect(true);
        return;
      }
      const auth = await this.inboxService.verifyAuth(`Bearer ${token}`);
      (client.data as { tenantId?: string; userId?: string }).tenantId =
        auth.tenantId;
      (client.data as { tenantId?: string; userId?: string }).userId =
        auth.userId;

      await client.join(tenantRoom(auth.tenantId));
      client.emit('inbox:connected', {
        tenantId: auth.tenantId,
        userId: auth.userId,
        timestamp: new Date().toISOString(),
      });
    } catch {
      client.disconnect(true);
    }
  }

  handleDisconnect(_client: Socket) {
    // Room cleanup is handled automatically by Socket.IO
  }

  broadcastConversationUpdate(
    tenantId: string,
    conversation: Record<string, unknown>,
    eventType: InboxRealtimeEventType,
  ) {
    try {
      if (!this.server || !tenantId) return;
      this.server.to(tenantRoom(tenantId)).emit('inbox:conversation_updated', {
        eventType,
        conversation,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      this.logger.warn(
        `Failed to broadcast inbox update (${tenantId}): ${
          err instanceof Error ? err.message : 'unknown'
        }`,
      );
    }
  }
}
