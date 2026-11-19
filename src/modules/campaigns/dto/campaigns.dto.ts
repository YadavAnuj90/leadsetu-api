import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export type CampaignSegment =
  | 'all_leads'
  | 'hot_leads'
  | 'noida_delhi_ncr'
  | 'indiamart_buyers'
  | 'gst_customers';

export type CampaignStatus = 'completed' | 'running' | 'scheduled' | 'draft';

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
    ],
    default: 'all_leads',
  })
  targetSegment?: CampaignSegment;

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
