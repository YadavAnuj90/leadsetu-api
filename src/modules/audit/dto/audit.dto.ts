import { ApiPropertyOptional } from '@nestjs/swagger';

export type AuditEntityType =
  | 'security'
  | 'team'
  | 'lead'
  | 'deal'
  | 'contact'
  | 'invoice'
  | 'ticket'
  | 'document';

export class UpdateSecuritySettingsDto {
  @ApiPropertyOptional({
    description:
      'Hide full client mobile numbers (e.g. "+91 98*** **678") from Agent role users.',
    example: true,
  })
  maskPhoneForAgents?: boolean;

  @ApiPropertyOptional({
    description: 'Disable CSV/Excel bulk exports for Agent role users.',
    example: true,
  })
  blockAgentExport?: boolean;
}

export interface RecordAuditInput {
  tenantId: string;
  actorId: string;
  actorEmail?: string;
  actorName?: string;
  actorUserCode?: string;
  actorRole?: string;
  action: string;
  entityType: AuditEntityType;
  entityId?: string;
  entityLabel?: string;
  summary: string;
  metadata?: Record<string, unknown>;
}

export interface AuditAuthContext {
  userId: string;
  tenantId: string;
  email: string;
  role: string;
}
