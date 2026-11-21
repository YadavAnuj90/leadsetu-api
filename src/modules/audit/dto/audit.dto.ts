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

export type AuditSeverity = 'info' | 'warning' | 'critical';
export type AuditVisibility = 'tenant' | 'platform';

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
  resourceType?: string;
  resourceId?: string;
  summary: string;
  severity?: AuditSeverity;
  visibility?: AuditVisibility;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
  requestId?: string;
  metadata?: Record<string, unknown>;
}

export interface AuditAuthContext {
  userId: string;
  tenantId: string;
  email: string;
  role: string;
}
