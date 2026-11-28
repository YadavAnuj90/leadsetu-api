import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type {
  PlatformTicketCategory,
  PlatformTicketPriority,
  PlatformTicketStatus,
} from '../schemas/platform-ticket.schema';

export class CreatePlatformTicketDto {
  @ApiProperty({ example: 'WhatsApp webhook status stays disconnected after WABA login' })
  subject!: string;

  @ApiPropertyOptional({
    enum: [
      'ui_glitch',
      'whatsapp_api',
      'indiamart_sync',
      'gst_invoicing',
      'calling_webrtc',
      'billing_plan',
      'feature_help',
      'other',
    ],
    default: 'ui_glitch',
  })
  category?: PlatformTicketCategory;

  @ApiPropertyOptional({
    enum: ['low', 'medium', 'high', 'urgent'],
    default: 'high',
  })
  priority?: PlatformTicketPriority;

  @ApiProperty({
    example: 'When clicking Connect Meta Cloud, spinner finishes but inbox badge still shows disconnected.',
  })
  description!: string;

  @ApiPropertyOptional({
    description: 'Silent diagnostic route where issue occurred (captured automatically by UI)',
    example: '/settings/integrations',
  })
  pageUrl?: string;
}

export class PlatformTicketReplyDto {
  @ApiProperty({ example: 'We verified the webhook token and re-synced the WABA channel.' })
  message!: string;

  @ApiPropertyOptional({
    enum: ['open', 'in_progress', 'waiting_admin', 'resolved', 'closed'],
  })
  nextStatus?: PlatformTicketStatus;

  @ApiPropertyOptional()
  resolutionSummary?: string;
}

export class SuperAdminUpdatePlatformTicketDto {
  @ApiPropertyOptional({
    enum: ['open', 'in_progress', 'waiting_admin', 'resolved', 'closed'],
  })
  status?: PlatformTicketStatus;

  @ApiPropertyOptional({ enum: ['low', 'medium', 'high', 'urgent'] })
  priority?: PlatformTicketPriority;

  @ApiPropertyOptional()
  resolutionSummary?: string;

  @ApiPropertyOptional()
  replyMessage?: string;
}
