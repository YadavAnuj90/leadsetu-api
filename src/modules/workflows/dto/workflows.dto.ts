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
  | 'send_payment_reminder'
  | 'reassign_rep_sla_alert'
  | 'multi_step_whatsapp_drip';

export type WorkflowNodeKind = 'trigger' | 'condition' | 'delay' | 'action';

export type WorkflowDelayUnit = 'minutes' | 'hours' | 'days';

export type WorkflowConditionGuard =
  | 'always'
  | 'if_uncontacted'
  | 'if_no_whatsapp_reply'
  | 'if_ai_score_gte'
  | 'if_deal_value_gte'
  | 'if_source_matches'
  | 'if_city_matches';

export type WorkflowNodeActionKind =
  | 'send_whatsapp'
  | 'reassign_rep'
  | 'create_sla_alert'
  | 'create_task'
  | 'generate_gst_invoice'
  | 'send_payment_reminder';

export class WorkflowStepNodeDto {
  @ApiProperty({ example: 'node-1' })
  id!: string;

  @ApiProperty({
    enum: ['trigger', 'condition', 'delay', 'action'],
    example: 'delay',
  })
  kind!: WorkflowNodeKind;

  @ApiProperty({ example: 'Wait 10 Mins (Speed-to-Lead SLA)' })
  title!: string;

  @ApiPropertyOptional({
    example: 'Waits 10 minutes before checking if sales rep contacted the buyer',
  })
  subtitle?: string;

  @ApiPropertyOptional({ example: 10 })
  delayValue?: number;

  @ApiPropertyOptional({ enum: ['minutes', 'hours', 'days'], example: 'minutes' })
  delayUnit?: WorkflowDelayUnit;

  @ApiPropertyOptional({
    enum: [
      'always',
      'if_uncontacted',
      'if_no_whatsapp_reply',
      'if_ai_score_gte',
      'if_deal_value_gte',
      'if_source_matches',
      'if_city_matches',
    ],
    example: 'if_uncontacted',
  })
  conditionGuard?: WorkflowConditionGuard;

  @ApiPropertyOptional({ example: 'indiamart,meta_ads,website' })
  conditionValue?: string;

  @ApiPropertyOptional({
    enum: [
      'send_whatsapp',
      'reassign_rep',
      'create_sla_alert',
      'create_task',
      'generate_gst_invoice',
      'send_payment_reminder',
    ],
    example: 'send_whatsapp',
  })
  actionKind?: WorkflowNodeActionKind;

  @ApiPropertyOptional({
    example:
      'Namaste {{buyer_name}} ji 👋, humne aapki {{company}} inquiry dekhi. Sharing GST brochure & price list right away!',
  })
  whatsappTemplateBody?: string;

  @ApiPropertyOptional({ enum: ['hinglish', 'english', 'hindi'], example: 'hinglish' })
  language?: 'hinglish' | 'english' | 'hindi';

  @ApiPropertyOptional({
    enum: ['round_robin_backup', 'senior_closer', 'territory_owner'],
    example: 'round_robin_backup',
  })
  reassignStrategy?: 'round_robin_backup' | 'senior_closer' | 'territory_owner';

  @ApiPropertyOptional({ enum: ['high', 'urgent'], example: 'urgent' })
  slaPriority?: 'high' | 'urgent';

  @ApiPropertyOptional({
    example: 'SLA Breach: Lead uncontacted after 10 mins — reassigned to backup rep',
  })
  taskOrAlertTitle?: string;

  @ApiPropertyOptional({ example: true })
  stopOnBuyerReply?: boolean;
}

export class CreateWorkflowDto {
  @ApiProperty({
    description: 'Automation workflow name',
    example:
      'IndiaMART / Meta / Webhook Lead -> 10m Uncontacted Check -> Hinglish WhatsApp + Backup Rep & SLA Alert',
  })
  name!: string;

  @ApiPropertyOptional({
    description: 'Short description of what this automation achieves',
  })
  description?: string;

  @ApiPropertyOptional({
    description: 'Event trigger that starts the workflow',
    enum: [
      'lead.created',
      'lead.hot_scored',
      'lead.stale_followup',
      'deal.stage_changed',
      'invoice.overdue',
      'whatsapp.inbound',
    ],
    default: 'lead.created',
  })
  triggerType?: WorkflowTriggerType;

  @ApiProperty({
    description: 'Human-readable condition filter (IF condition)',
    example: 'Lead Source IN [IndiaMART, Meta Ads, Website] AND Uncontacted after 10m',
  })
  conditionSummary!: string;

  @ApiPropertyOptional({
    description: 'Automated action type',
    enum: [
      'send_whatsapp_create_task',
      'assign_senior_closer',
      'generate_gst_invoice',
      'send_payment_reminder',
      'reassign_rep_sla_alert',
      'multi_step_whatsapp_drip',
    ],
    default: 'send_whatsapp_create_task',
  })
  actionType?: WorkflowActionType;

  @ApiProperty({
    description: 'Human-readable action description (THEN action)',
    example:
      'Send Hinglish WhatsApp Follow-Up + Reassign Backup Rep + Create High-Priority SLA Alert',
  })
  actionSummary!: string;

  @ApiPropertyOptional({ default: true })
  active?: boolean;

  @ApiPropertyOptional({ example: 142 })
  runsCount?: number;

  @ApiPropertyOptional({ example: 'indiamart', default: 'all' })
  sourceFilter?: string;

  @ApiPropertyOptional({ example: 'new', default: 'new' })
  staleStage?: string;

  @ApiPropertyOptional({ example: 24, default: 24 })
  staleHours?: number;

  @ApiPropertyOptional({ example: 10, default: 10 })
  staleMinutes?: number;

  @ApiPropertyOptional({
    example: 'Namaste {{buyer_name}} ji 👋, thank you for your inquiry for {{company}}!',
  })
  whatsappTemplateBody?: string;

  @ApiPropertyOptional({
    description: 'Ordered visual pipeline nodes (Trigger -> Condition -> Delay -> Action steps)',
    type: [WorkflowStepNodeDto],
  })
  nodes?: WorkflowStepNodeDto[];

  @ApiPropertyOptional({
    description: 'Whether any buyer reply automatically stops subsequent drip steps',
    default: true,
  })
  stopOnReply?: boolean;
}

export class UpdateWorkflowDto {
  @ApiPropertyOptional()
  name?: string;

  @ApiPropertyOptional()
  description?: string;

  @ApiPropertyOptional()
  triggerType?: WorkflowTriggerType;

  @ApiPropertyOptional()
  sourceFilter?: string;

  @ApiPropertyOptional()
  staleStage?: string;

  @ApiPropertyOptional()
  staleHours?: number;

  @ApiPropertyOptional()
  staleMinutes?: number;

  @ApiPropertyOptional()
  whatsappTemplateBody?: string;

  @ApiPropertyOptional()
  conditionSummary?: string;

  @ApiPropertyOptional()
  actionType?: WorkflowActionType;

  @ApiPropertyOptional()
  actionSummary?: string;

  @ApiPropertyOptional()
  active?: boolean;

  @ApiPropertyOptional({ type: [WorkflowStepNodeDto] })
  nodes?: WorkflowStepNodeDto[];

  @ApiPropertyOptional()
  stopOnReply?: boolean;
}
