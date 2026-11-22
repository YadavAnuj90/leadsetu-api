import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateIndiaMartConfigDto {
  @ApiPropertyOptional({
    description: 'Enable automated scheduled IndiaMART CRM Pull v2 polling',
    example: true,
  })
  enabled?: boolean;

  @ApiPropertyOptional({
    description: 'IndiaMART glusr_crm_key API v2 credential (AES-256 encrypted at rest)',
    example: 'mR0Z7xK2pL9qN4vW8yB...',
  })
  glusrCrmKey?: string;

  @ApiPropertyOptional({
    description: 'Registered IndiaMART Seller mobile number',
    example: '+91 98112 45678',
  })
  registeredMobile?: string;

  @ApiPropertyOptional({
    description: 'Polling frequency in minutes (5–60)',
    default: 5,
    example: 5,
  })
  pollIntervalMinutes?: number;

  @ApiPropertyOptional({
    description: 'Automatically send instant WhatsApp greeting within <10s of inquiry ingest',
    default: true,
  })
  autoWhatsAppSpeedToLead?: boolean;

  @ApiPropertyOptional({
    description: 'Template supporting {{buyer_name}}, {{product}}, {{company}}, {{rep_name}}',
    example:
      'Namaste {{buyer_name}} ji! Thanks for your inquiry for {{product}}. Our specialist {{rep_name}} from {{company}} is sharing quotation & availability right away.',
  })
  greetingTemplate?: string;

  @ApiPropertyOptional({
    description: 'SLA alert threshold in minutes before flagging unattended leads',
    default: 10,
    example: 10,
  })
  slaThresholdMinutes?: number;
}

export class SyncIndiaMartNowDto {
  @ApiPropertyOptional({
    description: 'Optional IndiaMART start_time window (DD-MMM-YYYYHH:MM:SS or ISO)',
  })
  startTime?: string;

  @ApiPropertyOptional({
    description: 'Optional IndiaMART end_time window',
  })
  endTime?: string;

  @ApiPropertyOptional({
    description: 'Force sandbox simulation inquiry pull even when live CRM key is absent',
    default: false,
  })
  simulateIfNoKey?: boolean;

  @ApiPropertyOptional({
    description: 'Number of simulated inquiries when running sandbox pull (1-5)',
    default: 2,
  })
  sampleCount?: number;
}

export class MarketplaceRawLeadItemDto {
  @ApiPropertyOptional({ example: 'IMQ-2026-998812' })
  externalQueryId?: string;

  @ApiProperty({ example: 'Suresh Jindal' })
  name!: string;

  @ApiPropertyOptional({ example: 'Jindal Transformers Pvt Ltd' })
  company?: string;

  @ApiProperty({ example: '+91 98118 22334' })
  phone!: string;

  @ApiPropertyOptional({ example: 'suresh@jindaltransformers.in' })
  email?: string;

  @ApiPropertyOptional({ example: 'Ghaziabad' })
  city?: string;

  @ApiPropertyOptional({ example: '300 KVA Three-Phase Oil-Cooled Servo Stabilizer' })
  product?: string;

  @ApiPropertyOptional({ example: 'Need urgent factory price for 4 units GST billing.' })
  message?: string;

  @ApiPropertyOptional({ example: 340000 })
  estimatedValue?: number;
}

export class IngestMarketplaceBatchDto {
  @ApiPropertyOptional({
    enum: ['indiamart_pull', 'justdial_feed', 'tradeindia_feed', 'meta_lead_ads'],
    default: 'justdial_feed',
  })
  channel?: 'indiamart_pull' | 'justdial_feed' | 'tradeindia_feed' | 'meta_lead_ads';

  @ApiProperty({ type: [MarketplaceRawLeadItemDto] })
  records!: MarketplaceRawLeadItemDto[];
}

export class UpdateLeadConnectorsDto {
  @ApiPropertyOptional({
    description: 'Meta Lead Ads Instant Form webhook configuration',
  })
  metaLeadAds?: {
    enabled?: boolean;
    verifyToken?: string;
    appSecret?: string;
    pageAccessToken?: string;
    pageId?: string;
    pageName?: string;
    formId?: string;
    autoWhatsAppWelcome?: boolean;
    clearAppSecret?: boolean;
    clearPageAccessToken?: boolean;
  };

  @ApiPropertyOptional({
    description: 'Justdial inbound webhook push configuration',
  })
  justdialWebhook?: {
    enabled?: boolean;
    secretToken?: string;
    categoryFilter?: string;
    autoWhatsAppWelcome?: boolean;
  };

  @ApiPropertyOptional({
    description: 'TradeIndia webhook push / CRM credentials configuration',
  })
  tradeindiaWebhook?: {
    enabled?: boolean;
    secretToken?: string;
    apiUserId?: string;
    profileId?: string;
    apiKey?: string;
    autoWhatsAppWelcome?: boolean;
    clearApiKey?: boolean;
  };

  @ApiPropertyOptional({
    description: 'Embeddable public appointment/demo booking scheduler configuration',
  })
  bookingScheduler?: {
    enabled?: boolean;
    slug?: string;
    title?: string;
    subtitle?: string;
    durationMinutes?: number;
    bufferMinutes?: number;
    workingDays?: number[];
    startHour?: string;
    endHour?: string;
    meetingType?: 'video_call' | 'phone_call' | 'in_person';
    confirmationWhatsappEnabled?: boolean;
    reminder1HrEnabled?: boolean;
  };
}

export class SimulateConnectorWebhookDto {
  @ApiProperty({
    enum: ['meta_lead_ads', 'justdial_feed', 'tradeindia_feed'],
    example: 'meta_lead_ads',
  })
  channel!: 'meta_lead_ads' | 'justdial_feed' | 'tradeindia_feed';

  @ApiPropertyOptional({ example: 'Rohan Malhotra' })
  name?: string;

  @ApiPropertyOptional({ example: '+91 98114 55221' })
  phone?: string;

  @ApiPropertyOptional({ example: 'Delhi' })
  city?: string;

  @ApiPropertyOptional({ example: '300 KVA Servo Stabilizer Inquiry' })
  product?: string;
}

export class CreatePublicBookingDto {
  @ApiProperty({ example: 'Ananya Verma' })
  guestName!: string;

  @ApiProperty({ example: '+91 98112 77889' })
  guestPhone!: string;

  @ApiPropertyOptional({ example: 'ananya@vermaengineering.in' })
  guestEmail?: string;

  @ApiPropertyOptional({ example: 'Verma Engineering Works' })
  guestCompany?: string;

  @ApiPropertyOptional({ example: 'Need bulk dealer quotation for 50 units.' })
  topic?: string;

  @ApiProperty({ example: '2026-11-24' })
  dateYmd!: string;

  @ApiProperty({ example: '11:00' })
  slotTime24!: string;
}

export class UpdateBookingStatusDto {
  @ApiProperty({ enum: ['confirmed', 'completed', 'cancelled', 'no_show'] })
  status!: 'confirmed' | 'completed' | 'cancelled' | 'no_show';

  @ApiPropertyOptional({
    description: 'Send polite WhatsApp reschedule nudge when marking no_show',
    default: true,
  })
  sendRecoveryWhatsApp?: boolean;
}
