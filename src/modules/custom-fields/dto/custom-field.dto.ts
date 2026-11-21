import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type {
  CustomFieldEntity,
  CustomFieldType,
} from '../schemas/custom-field.schema';

export class CreateCustomFieldDto {
  @ApiProperty({
    description: 'CRM module where this custom field appears',
    enum: ['lead', 'contact', 'deal'],
    example: 'lead',
  })
  entity!: CustomFieldEntity;

  @ApiProperty({
    description: 'Display label shown inside forms and detail views',
    example: 'Minimum Order Qty (MOQ)',
  })
  label!: string;

  @ApiPropertyOptional({
    description: 'Optional snake_case field key (auto-generated from label if omitted)',
    example: 'moq',
  })
  key?: string;

  @ApiProperty({
    description: 'Input data type',
    enum: ['text', 'number', 'dropdown', 'date', 'checkbox'],
    example: 'number',
  })
  type!: CustomFieldType;

  @ApiPropertyOptional({
    description: 'Allowed choice labels when type is `dropdown`',
    type: [String],
    example: ['Net 15 Days', 'Net 30 Days', '50% Advance'],
  })
  options?: string[];

  @ApiPropertyOptional({
    description: 'Whether this field is marked required inside CRM UI forms',
    default: false,
  })
  required?: boolean;

  @ApiPropertyOptional({
    description: 'Input placeholder hint',
    example: 'e.g. 500 units',
  })
  placeholder?: string;

  @ApiPropertyOptional({
    description: 'Optional default value pre-filled in forms',
  })
  defaultValue?: string | number | boolean | null;

  @ApiPropertyOptional({
    description: 'Display this field badge inside summary/list cards',
    default: true,
  })
  showInCard?: boolean;
}

export class UpdateCustomFieldDto {
  @ApiPropertyOptional({ example: 'Updated Field Label' })
  label?: string;

  @ApiPropertyOptional({
    enum: ['text', 'number', 'dropdown', 'date', 'checkbox'],
  })
  type?: CustomFieldType;

  @ApiPropertyOptional({ type: [String] })
  options?: string[];

  @ApiPropertyOptional()
  required?: boolean;

  @ApiPropertyOptional()
  placeholder?: string;

  @ApiPropertyOptional()
  defaultValue?: string | number | boolean | null;

  @ApiPropertyOptional()
  showInCard?: boolean;

  @ApiPropertyOptional()
  isActive?: boolean;

  @ApiPropertyOptional()
  order?: number;
}

export class ReorderCustomFieldsDto {
  @ApiProperty({ enum: ['lead', 'contact', 'deal'] })
  entity!: CustomFieldEntity;

  @ApiProperty({ type: [String], description: 'Ordered array of CustomField IDs' })
  orderedIds!: string[];
}

export class ApplyCustomFieldPresetDto {
  @ApiProperty({
    enum: [
      'manufacturing_b2b',
      'pharma_medical',
      'wholesale_distribution',
      'real_estate',
    ],
    example: 'manufacturing_b2b',
  })
  preset!:
    | 'manufacturing_b2b'
    | 'pharma_medical'
    | 'wholesale_distribution'
    | 'real_estate';
}
