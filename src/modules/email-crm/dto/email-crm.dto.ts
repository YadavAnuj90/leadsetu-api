import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { EmailProviderPreset } from '../schemas/email-account.schema';
import type { EmailTemplateCategory } from '../schemas/email-template.schema';

export class SaveEmailAccountDto {
  @ApiProperty({
    enum: ['gmail', 'zoho', 'outlook', 'custom'],
    example: 'gmail',
  })
  providerPreset!: EmailProviderPreset;

  @ApiProperty({ example: 'sales@rselectricals.in' })
  emailAddress!: string;

  @ApiPropertyOptional({ example: 'Rajesh Sharma · RS Electricals' })
  displayName?: string;

  @ApiProperty({ example: 'smtp.gmail.com' })
  smtpHost!: string;

  @ApiProperty({ example: 465 })
  smtpPort!: number;

  @ApiPropertyOptional({ default: true })
  smtpSecure?: boolean;

  @ApiPropertyOptional({ example: 'imap.gmail.com' })
  imapHost?: string;

  @ApiPropertyOptional({ example: 993 })
  imapPort?: number;

  @ApiPropertyOptional({ default: true })
  imapSecure?: boolean;

  @ApiPropertyOptional({ example: 'sales@rselectricals.in' })
  username?: string;

  @ApiPropertyOptional({
    description: 'SMTP/IMAP password or Gmail/Zoho App Password (leave empty while editing to keep stored encrypted secret)',
  })
  appPassword?: string;

  @ApiPropertyOptional({ example: '<p>Regards,<br/>RS Electricals Sales Desk</p>' })
  signatureHtml?: string;

  @ApiPropertyOptional({ default: true })
  isActive?: boolean;
}

export class CreateEmailTemplateDto {
  @ApiProperty({ example: '18% GST Proforma Quotation' })
  name!: string;

  @ApiPropertyOptional({
    enum: ['proforma', 'quotation', 'followup', 'udhaar', 'welcome', 'custom'],
    default: 'custom',
  })
  category?: EmailTemplateCategory;

  @ApiProperty({ example: 'Proforma Quotation for {{companyName}} — Leadsetu CRM' })
  subject!: string;

  @ApiProperty({
    example: '<p>Dear {{contactName}},</p><p>Please find attached your commercial quotation.</p>',
  })
  bodyHtml!: string;
}

export class UpdateEmailTemplateDto {
  @ApiPropertyOptional()
  name?: string;

  @ApiPropertyOptional({
    enum: ['proforma', 'quotation', 'followup', 'udhaar', 'welcome', 'custom'],
  })
  category?: EmailTemplateCategory;

  @ApiPropertyOptional()
  subject?: string;

  @ApiPropertyOptional()
  bodyHtml?: string;
}

export class SendEmailDto {
  @ApiProperty({ example: 'buyer@clientcompany.in' })
  toEmail!: string;

  @ApiProperty({ example: 'Proforma Quotation — Industrial Switchgear Order' })
  subject!: string;

  @ApiProperty({
    example: '<p>Dear Rajesh ji,</p><p>Sharing commercial pricing with 18% GST details.</p>',
  })
  bodyHtml!: string;

  @ApiPropertyOptional({
    enum: ['lead', 'contact', 'deal', ''],
    example: 'lead',
  })
  entityType?: 'lead' | 'contact' | 'deal' | '';

  @ApiPropertyOptional({ example: '67401a2f8c1b9e0012ab3456' })
  entityId?: string;

  @ApiPropertyOptional({ example: 'RS Electricals Pvt. Ltd.' })
  entityLabel?: string;

  @ApiPropertyOptional({ description: 'Optional template ID used for analytics' })
  templateId?: string;
}
