import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type {
  RepRoutingConfig,
  RoutingMode,
  TerritoryRoutingRule,
} from '../schemas/lead-routing.schema';

export class RepRoutingConfigDto implements RepRoutingConfig {
  @ApiProperty({ example: '67401a2f8c1b9e0012ab3456' })
  userId!: string;

  @ApiProperty({ example: true })
  eligible!: boolean;

  @ApiProperty({ example: 25, description: 'Max inbound leads/day (0 = unlimited)' })
  dailyCap!: number;

  @ApiProperty({ type: [String], example: ['Noida', 'Greater Noida', 'Ghaziabad'] })
  territories!: string[];
}

export class TerritoryRoutingRuleDto implements TerritoryRoutingRule {
  @ApiProperty({ example: 'rule_delhi_indiamart' })
  id!: string;

  @ApiProperty({ example: 'Delhi-NCR IndiaMART Priority' })
  name!: string;

  @ApiProperty({ example: true })
  active!: boolean;

  @ApiProperty({ type: [String], example: ['Delhi', 'New Delhi', 'Noida', 'Gurugram'] })
  matchCities!: string[];

  @ApiProperty({ type: [String], example: ['indiamart', 'justdial'] })
  matchSources!: string[];

  @ApiProperty({ example: 0 })
  minEstimatedValue!: number;

  @ApiProperty({ type: [String] })
  targetUserIds!: string[];

  @ApiProperty({ enum: ['round_robin', 'load_balanced'], example: 'round_robin' })
  strategy!: 'round_robin' | 'load_balanced';
}

export class UpdateLeadRoutingDto {
  @ApiPropertyOptional({ example: true })
  enabled?: boolean;

  @ApiPropertyOptional({
    enum: ['round_robin', 'territory_first', 'load_balanced'],
    example: 'territory_first',
  })
  mode?: RoutingMode;

  @ApiPropertyOptional({
    type: [String],
    example: ['indiamart', 'justdial', 'meta_ads', 'website'],
  })
  applyToSources?: string[];

  @ApiPropertyOptional({ example: false })
  applyOnManualCreate?: boolean;

  @ApiPropertyOptional({ example: true })
  respectDailyCap?: boolean;

  @ApiPropertyOptional({ example: 25 })
  defaultDailyCap?: number;

  @ApiPropertyOptional({ type: [RepRoutingConfigDto] })
  repConfigs?: RepRoutingConfigDto[];

  @ApiPropertyOptional({ type: [TerritoryRoutingRuleDto] })
  rules?: TerritoryRoutingRuleDto[];
}

export class SimulateLeadRoutingDto {
  @ApiPropertyOptional({ example: 'Noida Electronic City' })
  city?: string;

  @ApiPropertyOptional({ example: 'indiamart' })
  source?: string;

  @ApiPropertyOptional({ example: 350000 })
  estimatedValue?: number;
}
