import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { PipelineStage, StageCategory } from '../schemas/pipeline.schema';

export class PipelineStageDto implements PipelineStage {
  @ApiProperty({
    description: 'Stable slug identifier for the stage (e.g. "qualified", "site_visit", "won")',
    example: 'site_visit',
  })
  id!: string;

  @ApiProperty({
    description: 'Human-readable stage column header shown on the Kanban board',
    example: 'Factory Site Visit',
  })
  name!: string;

  @ApiProperty({
    description: 'Default win probability percentage assigned to deals entering this stage (0–100)',
    example: 50,
    minimum: 0,
    maximum: 100,
  })
  probability!: number;

  @ApiProperty({
    description: 'Hex accent color for Kanban header badge',
    example: '#8B5CF6',
  })
  color!: string;

  @ApiProperty({
    description: 'Outcome bucket used for weighted pipeline forecasts and won/lost KPIs',
    enum: ['open', 'won', 'lost'],
    example: 'open',
  })
  category!: StageCategory;

  @ApiPropertyOptional({
    description: 'Highlight deals idle in this stage beyond N days (0 disables)',
    example: 7,
  })
  rottenAfterDays?: number;

  @ApiPropertyOptional({
    description: 'Prompt reps to capture negotiation notes when entering this stage',
    example: false,
  })
  requireNoteOnEnter?: boolean;
}

export type PipelineTemplateKey =
  | 'b2b_sales'
  | 'msme_sales'
  | 'b2c_orders'
  | 'education_admissions'
  | 'bpo_callbacks'
  | 'dealer_onboarding'
  | 'amc_renewals'
  | 'blank';

export class ApplyModePresetDto {
  @ApiPropertyOptional({
    description: 'Workspace business mode to apply stages for (defaults to current tenant businessMode)',
    enum: ['b2b', 'msme', 'b2c', 'hybrid', 'bpo', 'education'],
    example: 'b2c',
  })
  businessMode?: 'b2b' | 'msme' | 'b2c' | 'hybrid' | 'bpo' | 'education';
}

export class CreatePipelineDto {
  @ApiProperty({
    description: 'Pipeline display name',
    example: 'Dealer Onboarding Pipeline',
  })
  name!: string;

  @ApiPropertyOptional({
    description: 'Optional purpose summary for this sales pipeline',
    example: 'Tracks KYC, sample dispatch, and initial stocking order for B2B distributors.',
  })
  description?: string;

  @ApiPropertyOptional({
    description: 'Starter template preset used if custom stages array is omitted',
    enum: [
      'b2b_sales',
      'msme_sales',
      'b2c_orders',
      'education_admissions',
      'bpo_callbacks',
      'dealer_onboarding',
      'amc_renewals',
      'blank',
    ],
    example: 'b2c_orders',
  })
  template?: PipelineTemplateKey;

  @ApiPropertyOptional({
    description: 'Set newly created pipeline as the workspace default',
    example: false,
  })
  isDefault?: boolean;

  @ApiPropertyOptional({
    description: 'Ordered list of stages for this pipeline',
    type: [PipelineStageDto],
  })
  stages?: PipelineStageDto[];
}

export class UpdatePipelineDto {
  @ApiPropertyOptional({
    description: 'Updated pipeline display name',
    example: 'Enterprise GST Accounts',
  })
  name?: string;

  @ApiPropertyOptional({
    description: 'Updated description',
  })
  description?: string;

  @ApiPropertyOptional({
    description: 'Promote this pipeline to workspace default',
  })
  isDefault?: boolean;

  @ApiPropertyOptional({
    description: 'Complete ordered list of pipeline stages',
    type: [PipelineStageDto],
  })
  stages?: PipelineStageDto[];

  @ApiPropertyOptional({
    description: 'Map removed stage IDs -> replacement stage IDs to migrate existing deals safely',
    type: Object,
    example: { old_stage: 'qualified' },
  })
  stageMigrations?: Record<string, string>;
}
