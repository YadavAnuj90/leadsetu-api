import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export type PortalTicketCategory =
  | 'dispatch_delay'
  | 'warranty'
  | 'gst_correction'
  | 'installation'
  | 'amc_service'
  | 'general';

export type PortalTicketPriority = 'low' | 'medium' | 'high' | 'urgent';

export class ManagePortalLinkDto {
  @ApiPropertyOptional({
    description: 'Set true to rotate/regenerate a brand-new magic portal token (invalidates old link)',
    example: false,
  })
  regenerate?: boolean;

  @ApiPropertyOptional({
    description: 'Enable or temporarily disable buyer access to this portal link',
    example: true,
  })
  enabled?: boolean;
}

export class PortalQuoteRespondDto {
  @ApiProperty({
    enum: ['approved', 'changes_requested'],
    example: 'approved',
  })
  decision!: 'approved' | 'changes_requested';

  @ApiPropertyOptional({ example: 'Vikramjit Singh (Apex Auto Components)' })
  buyerName?: string;

  @ApiPropertyOptional({ example: 'Approved, kindly share final Tax Invoice.' })
  remark?: string;
}

export class PortalPaymentIntentDto {
  @ApiProperty({
    enum: ['UPI', 'NEFT', 'RTGS', 'Razorpay'],
    example: 'UPI',
  })
  paymentMode!: 'UPI' | 'NEFT' | 'RTGS' | 'Razorpay';

  @ApiProperty({ example: 50000 })
  amountInr!: number;

  @ApiPropertyOptional({
    description: 'Optional UTR / UPI Reference if buyer already remitted the payment',
    example: 'UPI432198765432',
  })
  utrOrReference?: string;

  @ApiPropertyOptional({
    description: 'Optional Promise-To-Pay date (YYYY-MM-DD)',
    example: '2026-11-28',
  })
  promisedDate?: string;

  @ApiPropertyOptional({ example: 'Rajesh Sharma' })
  buyerName?: string;

  @ApiPropertyOptional({ example: 'Paid first tranche via HDFC UPI' })
  note?: string;
}

export class PortalCreateTicketDto {
  @ApiProperty({ example: 'Dispatch LR tracking request for GST Invoice INV-2026-014' })
  subject!: string;

  @ApiProperty({
    enum: [
      'dispatch_delay',
      'warranty',
      'gst_correction',
      'installation',
      'amc_service',
      'general',
    ],
    example: 'dispatch_delay',
  })
  category!: PortalTicketCategory;

  @ApiPropertyOptional({
    enum: ['low', 'medium', 'high', 'urgent'],
    default: 'medium',
  })
  priority?: PortalTicketPriority;

  @ApiPropertyOptional({ example: 'INV-2026-014' })
  linkedInvoiceNumber?: string;

  @ApiProperty({
    example: 'Please share transporter bilty / LR copy for Friday dispatch.',
  })
  message!: string;

  @ApiPropertyOptional({ example: 'Vikramjit Singh' })
  buyerName?: string;
}

export class PortalTicketReplyDto {
  @ApiProperty({ example: 'Thanks, received the docket number.' })
  message!: string;

  @ApiPropertyOptional({ example: 'Vikramjit Singh' })
  buyerName?: string;
}
