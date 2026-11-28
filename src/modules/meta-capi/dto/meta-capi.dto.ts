import { ApiPropertyOptional } from '@nestjs/swagger';
import type { MetaCapiEventName } from '../schemas/meta-capi-event.schema';

export class UpdateMetaCapiConfigDto {
  @ApiPropertyOptional({
    description: 'Enable automatic Conversions API dispatch to Meta Graph API',
    example: true,
  })
  enabled?: boolean;

  @ApiPropertyOptional({
    description: 'Meta Pixel / Dataset ID from Meta Events Manager',
    example: '104928374615283',
  })
  pixelId?: string;

  @ApiPropertyOptional({
    description: 'Meta Conversions API System User Access Token (encrypted at rest)',
    example: 'EAAGm0PX4ZCpsBA...',
  })
  accessToken?: string;

  @ApiPropertyOptional({
    description: 'Optional Test Event Code from Events Manager Test Events tab',
    example: 'TEST48291',
  })
  testEventCode?: string;

  @ApiPropertyOptional({ default: true })
  autoFireOnCtwaInbound?: boolean;

  @ApiPropertyOptional({ default: true })
  autoFireOnLeadQualified?: boolean;

  @ApiPropertyOptional({ default: true })
  autoFireOnDealWon?: boolean;

  @ApiPropertyOptional({ default: true })
  autoFireOnInvoicePaid?: boolean;

  @ApiPropertyOptional({
    description: 'Monthly Meta Ad Spend in INR for real-time ROAS & Cost-Per-Lead calculation',
    example: 50000,
  })
  monthlyAdSpendInr?: number;
}

export class SimulateCtwaInboundDto {
  @ApiPropertyOptional({ example: 'Rohan Malhotra' })
  contactName?: string;

  @ApiPropertyOptional({ example: '+91 98112 88991' })
  phone?: string;

  @ApiPropertyOptional({
    example: 'Hi, saw your Meta Ad for 500 Industrial Stabilizers — share rate for Noida?',
  })
  message?: string;

  @ApiPropertyOptional({ example: '12021489201948102' })
  adId?: string;

  @ApiPropertyOptional({ example: 'Diwali Wholesale Servo Offer - NCR' })
  adHeadline?: string;

  @ApiPropertyOptional({ example: 'Get 18% GST Factory Rate & 30-Day Credit' })
  adBody?: string;

  @ApiPropertyOptional({ example: 'https://fb.me/ad/diwali-wholesale-ncr' })
  sourceUrl?: string;

  @ApiPropertyOptional({ example: 'ARAk92zPqM12ctwa_sample_clid_01' })
  ctwaClid?: string;

  @ApiPropertyOptional({ example: 150000 })
  estimatedValue?: number;
}

export class TriggerManualCapiEventDto {
  @ApiPropertyOptional({
    enum: ['lead', 'deal', 'invoice', 'conversation'],
    default: 'lead',
  })
  entityType?: 'lead' | 'deal' | 'invoice' | 'conversation';

  @ApiPropertyOptional({ description: 'CRM entity ID to fire CAPI signal for' })
  entityId?: string;

  @ApiPropertyOptional({
    enum: ['LeadSubmitted', 'QualifiedLead', 'Purchase', 'Contact'],
    default: 'QualifiedLead',
  })
  eventName?: MetaCapiEventName;

  @ApiPropertyOptional({ example: 85000 })
  valueInr?: number;
}
