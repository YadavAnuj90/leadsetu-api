import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export type CampaignSegment =
  | 'all_leads'
  | 'hot_leads'
  | 'noida_delhi_ncr'
  | 'indiamart_buyers'
  | 'gst_customers'
  | 'b2b_accounts'
  | 'b2c_consumers'
  | 'delivered_customers';

export type CampaignStatus = 'completed' | 'running' | 'scheduled' | 'draft';

export class CampaignSegmentFiltersDto {
  @ApiPropertyOptional({
    enum: ['all', 'business', 'consumer'],
    default: 'all',
    description: 'Filter audience by B2B business vs B2C consumer classification',
  })
  accountKind?: 'all' | 'business' | 'consumer';

  @ApiPropertyOptional({
    description: 'Filter audience by City / Hub substring (e.g. Mumbai, Noida)',
    example: 'Noida',
  })
  city?: string;

  @ApiPropertyOptional({
    enum: ['all', 'new', 'contacted', 'qualified', 'proposal', 'converted', 'lost'],
    default: 'all',
    description: 'Filter Leads by current pipeline status',
  })
  leadStatus?: string;

  @ApiPropertyOptional({
    description: 'Minimum SetuAI score filter (0-100)',
    example: 75,
  })
  minAiScore?: number;

  @ApiPropertyOptional({
    description: 'Automatically exclude DND / Opt-out contacts & leads (doNotCall / whatsappOptOut)',
    default: true,
  })
  excludeDnd?: boolean;
}

export class PreviewAudienceDto {
  @ApiPropertyOptional({
    enum: [
      'all_leads',
      'hot_leads',
      'noida_delhi_ncr',
      'indiamart_buyers',
      'gst_customers',
      'b2b_accounts',
      'b2c_consumers',
      'delivered_customers',
    ],
    default: 'all_leads',
  })
  targetSegment?: CampaignSegment;

  @ApiPropertyOptional({ type: CampaignSegmentFiltersDto })
  segmentFilters?: CampaignSegmentFiltersDto;
}

export class RetargetCampaignDto {
  @ApiPropertyOptional({
    description: 'Custom campaign name for this follow-up drip blast',
  })
  name?: string;

  @ApiPropertyOptional({
    description: 'Follow-up WhatsApp message body for non-responders',
  })
  messageBody?: string;

  @ApiPropertyOptional({
    description: 'CTA label for the follow-up message',
  })
  ctaLabel?: string;

  @ApiPropertyOptional({
    description: 'Dispatch immediately (true) or save as draft (false)',
    default: true,
  })
  sendNow?: boolean;
}

export class CreateCampaignDto {
  @ApiProperty({
    description: 'Campaign title for internal tracking',
    example: 'Noida & Delhi-NCR Q4 Industrial Catalogue Blast',
  })
  name!: string;

  @ApiPropertyOptional({
    description: 'Delivery mode: free-form personalized text or official Meta template',
    enum: ['text', 'meta_template'],
    default: 'text',
  })
  sendMode?: 'text' | 'meta_template';

  @ApiPropertyOptional({
    description: 'Meta WhatsApp Cloud API approved template name',
    example: 'b2b_catalogue_hinglish_v2',
    default: 'b2b_catalogue_hinglish_v2',
  })
  templateName?: string;

  @ApiPropertyOptional({
    description: 'Template language',
    enum: ['hinglish', 'english', 'hindi'],
    default: 'hinglish',
  })
  language?: 'hinglish' | 'english' | 'hindi';

  @ApiPropertyOptional({
    description: 'Delivery channel',
    enum: ['whatsapp_cloud', 'whatsapp_ai_drip'],
    default: 'whatsapp_cloud',
  })
  channel?: 'whatsapp_cloud' | 'whatsapp_ai_drip';

  @ApiPropertyOptional({
    description: 'Target audience segment from CRM Leads & Contacts',
    enum: [
      'all_leads',
      'hot_leads',
      'noida_delhi_ncr',
      'indiamart_buyers',
      'gst_customers',
      'b2b_accounts',
      'b2c_consumers',
      'delivered_customers',
    ],
    default: 'all_leads',
  })
  targetSegment?: CampaignSegment;

  @ApiPropertyOptional({
    description: 'Granular B2B/B2C, City, Lead Status, AI Score & DND exclusion filters',
    type: CampaignSegmentFiltersDto,
  })
  segmentFilters?: CampaignSegmentFiltersDto;

  @ApiPropertyOptional({
    description: 'Parent campaign ID when created as a non-responder retarget drip',
  })
  parentCampaignId?: string;

  @ApiProperty({
    description:
      'WhatsApp message body supporting {{name}} and {{company}} variables',
    example:
      'Namaste {{name}} ji 👋, {{company}} ke liye humara 2026 Factory Price List & 18% GST Catalogue ready hai from Noida Electronic City. Reply QUOTE for instant proforma!',
  })
  messageBody!: string;

  @ApiPropertyOptional({
    description: 'Interactive quick-reply button label',
    example: 'Get Instant Quote',
    default: 'Get Instant Quote',
  })
  ctaLabel?: string;

  @ApiPropertyOptional({
    description: 'Custom recipient count override (auto-calculated if omitted)',
    example: 185,
  })
  audienceCount?: number;

  @ApiPropertyOptional({
    description:
      'Campaign status: completed (immediate blast), running, scheduled, or draft',
    enum: ['completed', 'running', 'scheduled', 'draft'],
    default: 'completed',
  })
  status?: CampaignStatus;

  @ApiPropertyOptional({
    description: 'Scheduled date/time if status is scheduled',
    example: '2026-11-15 10:30 AM IST',
  })
  scheduledFor?: string;

  @ApiPropertyOptional({
    description: 'Pipeline / revenue attributed to this campaign in INR (₹)',
    example: 420000,
  })
  attributedRevenue?: number;
}

export class UpdateCampaignDto extends CreateCampaignDto {}
