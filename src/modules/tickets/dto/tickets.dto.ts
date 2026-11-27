import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export type TicketCategory =
  | 'dispatch_delay'
  | 'warranty'
  | 'gst_correction'
  | 'installation'
  | 'amc_service'
  | 'general';
export type TicketPriority = 'low' | 'medium' | 'high' | 'urgent';
export type TicketStatus =
  | 'open'
  | 'in_progress'
  | 'waiting_client'
  | 'resolved'
  | 'closed';

export interface TicketAuthContext {
  userId: string;
  tenantId: string;
  email: string;
  name?: string;
}

export class CreateTicketDto {
  @ApiProperty({ example: 'GSTIN State Code Update for INV-2026-1002' })
  subject!: string;

  @ApiPropertyOptional({
    enum: [
      'dispatch_delay',
      'warranty',
      'gst_correction',
      'installation',
      'amc_service',
      'general',
    ],
    default: 'general',
  })
  category?: TicketCategory;

  @ApiPropertyOptional({
    enum: ['low', 'medium', 'high', 'urgent'],
    default: 'medium',
  })
  priority?: TicketPriority;

  @ApiPropertyOptional({
    enum: ['open', 'in_progress', 'waiting_client', 'resolved', 'closed'],
    default: 'open',
  })
  status?: TicketStatus;

  @ApiPropertyOptional({ example: 'Rajesh Sharma' })
  customerName?: string;

  @ApiPropertyOptional({ example: 'RS Electricals Pvt. Ltd.' })
  company?: string;

  @ApiPropertyOptional({ example: '+91 98112 45678' })
  phone?: string;

  @ApiPropertyOptional({ example: 'rajesh@rselectricals.in' })
  email?: string;

  @ApiPropertyOptional({
    example: 'Plot 14, Industrial Area, Karol Bagh, New Delhi',
  })
  siteAddress?: string;

  @ApiPropertyOptional({ example: 'cnt_01a2b3c4d5e6' })
  linkedContactId?: string;

  @ApiPropertyOptional({ example: 'INV-2026-1002' })
  linkedInvoiceNumber?: string;

  @ApiPropertyOptional({ example: 'IND-STAB-150 · SN#260489' })
  productSerialOrSku?: string;

  @ApiPropertyOptional({ example: '660f1a...' })
  assignedToUserId?: string;

  @ApiPropertyOptional({ example: 'Er. Pradeep Verma (NCR Field Lead)' })
  assignedToName?: string;

  @ApiPropertyOptional({ example: '+91 98109 44120' })
  assignedToPhone?: string;

  @ApiPropertyOptional({ example: '2026-11-16' })
  slaDueAt?: string;

  @ApiPropertyOptional({
    example: 'Replaced contactor relay & verified output voltage.',
  })
  resolutionSummary?: string;

  @ApiPropertyOptional({ example: 5 })
  csatRating?: number;

  @ApiPropertyOptional({ example: 'Client requested billing state correction.' })
  notes?: string;
}

export type UpdateTicketDto = Partial<CreateTicketDto>;

export class AddTicketCommentDto {
  @ApiProperty({
    example:
      'Dispatched replacement control card via Porter from Noida Sector 62.',
  })
  message!: string;

  @ApiPropertyOptional({ default: false })
  isInternal?: boolean;

  @ApiPropertyOptional({
    enum: ['agent', 'engineer', 'customer', 'system'],
    default: 'agent',
  })
  authorRole?: 'agent' | 'engineer' | 'customer' | 'system';

  @ApiPropertyOptional({ example: 'Er. Pradeep Verma' })
  authorName?: string;

  @ApiPropertyOptional({
    enum: ['open', 'in_progress', 'waiting_client', 'resolved', 'closed'],
  })
  nextStatus?: TicketStatus;

  @ApiPropertyOptional({
    example: 'Issue resolved and verified with buyer on call.',
  })
  resolutionSummary?: string;
}
