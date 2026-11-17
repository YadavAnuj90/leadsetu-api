import { ApiPropertyOptional } from '@nestjs/swagger';
import type { IcePathType } from '../schemas/call-log.schema';

export type AgentPresenceStatus = 'online' | 'busy' | 'offline';

export interface CallAuthContext {
  userId: string;
  tenantId: string;
  email: string;
  role: string;
  name: string;
  userCode: string;
}

export class CallTelemetrySnapshotDto {
  @ApiPropertyOptional({ enum: ['direct', 'turn_relay', 'failed'] })
  icePath?: IcePathType;

  @ApiPropertyOptional()
  turnUsed?: boolean;

  @ApiPropertyOptional({ example: 'srflx' })
  localCandidateType?: string;

  @ApiPropertyOptional({ example: 'host' })
  remoteCandidateType?: string;

  @ApiPropertyOptional({ example: 'udp' })
  relayProtocol?: string;

  @ApiPropertyOptional({ example: 38 })
  rttMs?: number;

  @ApiPropertyOptional({ example: 4 })
  jitterMs?: number;

  @ApiPropertyOptional({ example: 0 })
  packetsLost?: number;

  @ApiPropertyOptional({ example: 48200 })
  bytesSent?: number;

  @ApiPropertyOptional({ example: 49510 })
  bytesReceived?: number;

  @ApiPropertyOptional({ example: 'connected' })
  iceConnectionState?: string;

  @ApiPropertyOptional({ example: '' })
  iceFailureReason?: string;
}
