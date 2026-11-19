import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export type WorkflowTriggerType =
  | 'lead.created'
  | 'lead.hot_scored'
  | 'lead.stale_followup'
  | 'deal.stage_changed'
  | 'invoice.overdue'
  | 'whatsapp.inbound';

export type WorkflowActionType =
  | 'send_whatsapp_create_task'
  | 'assign_senior_closer'
  | 'generate_gst_invoice'
  | 'send_payment_reminder';

export class CreateWorkflowDto {
  @ApiProperty({
    description: 'Automation workflow name',
    example: 'IndiaMART Inquiry -> 15-Sec WhatsApp Greeting & Call Task',
  })
  name!: string;

  @ApiPropertyOptional({
    description: 'Short description of what this automation achieves',
    example:
      'Captures new IndiaMART & Meta leads, sends instant Hinglish brochure on WhatsApp, and schedules a 15-min call reminder.',
  })
  description?: string;

  @ApiPropertyOptional({
    description: 'Event trigger that starts the workflow',
    enum: [
      'lead.created',
      'lead.hot_scored',
      'deal.stage_changed',
      'invoice.overdue',
      'whatsapp.inbound',
    ],
    default: 'lead.created',
  })
  triggerType?: WorkflowTriggerType;

  @ApiProperty({
    description: 'Human-readable condition filter (IF condition)',
    example: 'Lead Source IN [IndiaMART, Meta Ads] AND City = Delhi-NCR',
  })
  conditionSummary!: string;

  @ApiPropertyOptional({
    description: 'Automated action type',
    enum: [
      'send_whatsapp_create_task',
      'assign_senior_closer',
      'generate_gst_invoice',
      'send_payment_reminder',
    ],
    default: 'send_whatsapp_create_task',
  })
  actionType?: WorkflowActionType;

  @ApiProperty({
    description: 'Human-readable action description (THEN action)',
    example:
      'Send WhatsApp Catalogue PDF + Score with SetuAI + Create High-Priority Call Task',
  })
  actionSummary!: string;

  @ApiPropertyOptional({
    description: 'Whether the workflow is immediately active',
    default: true,
  })
  active?: boolean;

  @ApiPropertyOptional({
    description: 'Initial historical run count (optional)',
    example: 142,
  })
  runsCount?: number;

  @ApiPropertyOptional({
    description: 'Lead source filter for lead.created/hot_scored triggers',
    example: 'indiamart',
    default: 'all',
  })
  sourceFilter?: string;

  @ApiPropertyOptional({
    description: 'Target stage for lead.stale_followup trigger (new, proposal, contacted, qualified, or any)',
    example: 'proposal',
    default: 'new',
  })
  staleStage?: string;

  @ApiPropertyOptional({
    description: 'Hours a lead remains in staleStage before auto WhatsApp follow-up fires',
    example: 24,
    default: 24,
  })
  staleHours?: number;

  @ApiPropertyOptional({
    description: 'Custom WhatsApp template message sent when this workflow fires',
    example: 'Namaste {{buyer_name}} ji 👋, thank you for your inquiry for {{company}}!',
  })
  whatsappTemplateBody?: string;
}
