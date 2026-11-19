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
  isGuestCustomer?: boolean;
  targetAgentId?: string;
  linkedEntityType?: '' | 'lead' | 'deal' | 'ticket' | 'contact';
  linkedEntityId?: string;
  linkedEntityLabel?: string;
  customerPhone?: string;
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

export class SaveCallDispositionDto {
  @ApiPropertyOptional({ enum: ['', 'lead', 'deal', 'ticket', 'contact'] })
  linkedEntityType?: '' | 'lead' | 'deal' | 'ticket' | 'contact';

  @ApiPropertyOptional()
  linkedEntityId?: string;

  @ApiPropertyOptional({ example: 'interested' })
  outcomeTag?: string;

  @ApiPropertyOptional()
  notes?: string;

  @ApiPropertyOptional()
  createFollowUpTask?: boolean;

  @ApiPropertyOptional()
  taskTitle?: string;

  @ApiPropertyOptional()
  taskDueDate?: string;

  @ApiPropertyOptional({ enum: ['high', 'medium', 'low'] })
  taskPriority?: 'high' | 'medium' | 'low';

  @ApiPropertyOptional({ enum: ['call', 'whatsapp', 'meeting', 'quote', 'followup'] })
  taskCategory?: 'call' | 'whatsapp' | 'meeting' | 'quote' | 'followup';
}

export class LogSimCallDto extends SaveCallDispositionDto {
  @ApiPropertyOptional({ example: 'Rajesh Sharma' })
  contactName?: string;

  @ApiPropertyOptional({ example: '+91 98112 45678' })
  customerPhone?: string;

  @ApiPropertyOptional({ enum: ['completed', 'missed', 'rejected'] })
  status?: 'completed' | 'missed' | 'rejected';

  @ApiPropertyOptional({ example: 95 })
  durationSeconds?: number;
}

export class CreateCallShareLinkDto {
  @ApiPropertyOptional({ enum: ['', 'lead', 'deal', 'ticket'] })
  entityType?: '' | 'lead' | 'deal' | 'ticket';

  @ApiPropertyOptional()
  entityId?: string;

  @ApiPropertyOptional({ example: 7 })
  expiresInDays?: number;
}

export class PublicCallCallbackDto {
  @ApiPropertyOptional()
  customerName?: string;

  @ApiPropertyOptional()
  customerPhone?: string;

  @ApiPropertyOptional()
  preferredTime?: string;

  @ApiPropertyOptional()
  message?: string;
}

export class UploadCallRecordingDto {
  @ApiPropertyOptional({
    description: 'Base64 audio data URL (audio/webm, audio/ogg, audio/mp4) or HTTPS URL',
  })
  audioDataUrl?: string;

  @ApiPropertyOptional({ example: 45 })
  durationSeconds?: number;
}
