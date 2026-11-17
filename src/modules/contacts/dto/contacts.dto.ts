import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateContactDto {
  @ApiProperty({
    description: 'Full name of the B2B contact / decision-maker',
    example: 'Rajesh Sharma',
  })
  name!: string;

  @ApiPropertyOptional({
    description: 'Registered company / business name',
    example: 'RS Electricals Pvt. Ltd.',
  })
  company?: string;

  @ApiPropertyOptional({
    description: 'Job title / designation',
    example: 'Managing Director',
  })
  designation?: string;

  @ApiPropertyOptional({
    description: 'WhatsApp / mobile phone number (+91)',
    example: '+91 98112 45678',
  })
  phone?: string;

  @ApiPropertyOptional({
    description: 'Work email address',
    example: 'rajesh@rselectricals.in',
  })
  email?: string;

  @ApiPropertyOptional({
    description: 'City / industrial hub',
    example: 'Noida Electronic City',
    default: 'New Delhi',
  })
  city?: string;

  @ApiPropertyOptional({
    description: '15-digit Indian GSTIN tax identification number',
    example: '09AABCR1234F1Z5',
  })
  gstin?: string;

  @ApiPropertyOptional({
    description: 'B2B account relationship type',
    enum: ['customer', 'prospect', 'partner', 'vendor'],
    default: 'customer',
    example: 'customer',
  })
  type?: 'customer' | 'prospect' | 'partner' | 'vendor';

  @ApiPropertyOptional({
    description: 'Cumulative Lifetime Value (LTV) in INR (₹)',
    example: 1250000,
    default: 0,
  })
  lifetimeValue?: number;

  @ApiPropertyOptional({
    description: 'Account classification tags',
    type: [String],
    example: ['VIP Buyer', 'GST Registered'],
  })
  tags?: string[];

  @ApiPropertyOptional({
    description: 'Account notes & billing preferences',
    example: 'Prefers WhatsApp proforma invoices before dispatch.',
  })
  notes?: string;

  @ApiPropertyOptional({
    description: 'Approved B2B credit limit in INR (0 = uncapped unless Credit Hold enabled)',
    example: 500000,
    default: 0,
  })
  creditLimitInr?: number;

  @ApiPropertyOptional({
    description: 'Approved payment credit cycle in days (e.g. 0, 7, 15, 30, 45, 60)',
    example: 30,
    default: 15,
  })
  creditTermDays?: number;

  @ApiPropertyOptional({
    description: 'Place buyer on Credit Hold (blocks new quotes/invoices without Admin override)',
    default: false,
  })
  creditHold?: boolean;

  @ApiPropertyOptional({
    description: 'Reason for placing buyer on Credit Hold',
    example: 'Invoices overdue > 30 days',
  })
  creditHoldReason?: string;
}

export class UpdateContactDto extends CreateContactDto {}
