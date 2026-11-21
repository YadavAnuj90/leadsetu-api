import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiProperty,
  ApiPropertyOptional,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CreateDealDto, DealsService, UpdateDealDto } from './deals.service';
import { DealActivity, DealStage } from './schemas/deal.schema';

export class CreateDealSwaggerDto implements CreateDealDto {
  @ApiProperty({
    description: 'Title of the commercial deal / order',
    example: '500 Industrial Switchgear Units',
  })
  title!: string;

  @ApiPropertyOptional({
    description: 'Buyer company / organization name',
    example: 'RS Electricals Pvt. Ltd.',
  })
  company?: string;

  @ApiPropertyOptional({
    description: 'Primary decision-maker contact name',
    example: 'Rajesh Sharma',
  })
  contactName?: string;

  @ApiPropertyOptional({
    description: 'Buyer WhatsApp / mobile phone (+91)',
    example: '+91 98112 45678',
  })
  contactPhone?: string;

  @ApiPropertyOptional({
    description: 'Buyer email address',
    example: 'rajesh@rselectricals.in',
  })
  contactEmail?: string;

  @ApiPropertyOptional({
    description: 'Buyer city / industrial hub',
    example: 'Noida Electronic City',
    default: 'New Delhi',
  })
  city?: string;

  @ApiPropertyOptional({
    description: 'Base deal value in INR (₹) before GST',
    example: 450000,
    default: 0,
  })
  value?: number;

  @ApiPropertyOptional({
    description: 'Kanban pipeline stage',
    enum: ['qualified', 'discovery', 'proposal', 'negotiation', 'won', 'lost'],
    default: 'qualified',
    example: 'proposal',
  })
  stage?: DealStage;

  @ApiPropertyOptional({
    description: 'Win probability percentage (0–100)',
    example: 65,
    minimum: 0,
    maximum: 100,
  })
  probability?: number;

  @ApiPropertyOptional({
    description: 'Expected closing date (YYYY-MM-DD)',
    example: '2026-11-25',
  })
  expectedCloseDate?: string;

  @ApiPropertyOptional({
    description: 'Acquisition channel source',
    example: 'whatsapp',
    default: 'whatsapp',
  })
  source?: string;

  @ApiPropertyOptional({
    description: 'Whether 18% GST tax invoicing applies',
    example: true,
    default: true,
  })
  gstApplicable?: boolean;

  @ApiPropertyOptional({
    description: 'Commercial proposal & payment terms notes',
    example: '50% advance via Razorpay, balance against dispatch.',
  })
  notes?: string;

  @ApiPropertyOptional({
    description: 'Deal tags',
    type: [String],
    example: ['18% GST Quote', 'Bulk Order'],
  })
  tags?: string[];
}

export class UpdateDealSwaggerDto
  extends CreateDealSwaggerDto
  implements UpdateDealDto {}

export class AddDealActivitySwaggerDto {
  @ApiPropertyOptional({
    description: 'Deal activity type',
    enum: ['note', 'quote', 'stage_change'],
    default: 'note',
    example: 'note',
  })
  type?: DealActivity['type'];

  @ApiProperty({
    description: 'Activity note or negotiation update',
    example: 'Approved 12% bulk discount. Proforma invoice #LS-204 sent.',
  })
  description!: string;
}

@ApiTags('3. Deals & Kanban Pipeline')
@ApiBearerAuth('access-token')
@Controller('deals')
export class DealsController {
  constructor(private readonly dealsService: DealsService) {}

  @Get()
  @ApiOperation({
    summary: 'List all pipeline deals + weighted AI revenue forecast',
    description:
      'Returns all deals for the Kanban board along with `openPipelineValue`, `weightedForecast`, and `wonRevenue`.',
  })
  @ApiQuery({
    name: 'search',
    required: false,
    description: 'Search by deal title, company, contact name, or city',
    example: 'Switchgear',
  })
  @ApiQuery({
    name: 'stage',
    required: false,
    enum: ['all', 'qualified', 'discovery', 'proposal', 'negotiation', 'won', 'lost'],
    description: 'Filter deals by Kanban stage',
  })
  @ApiResponse({
    status: 200,
    description: 'Returns `{ data: Deal[], stats: DealsStats }`.',
  })
  async findAll(
    @Headers('authorization') authorization: string | undefined,
    @Query() query: { search?: string; stage?: string },
  ) {
    const auth = await this.dealsService.verifyAuth(authorization);
    return this.dealsService.findAll(auth, query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get single deal details, 18% GST breakdown & negotiation log',
  })
  @ApiParam({
    name: 'id',
    description: 'Unique deal record ID',
    example: 'del_01a2b3c4d5e6',
  })
  @ApiResponse({ status: 200, description: 'Deal object returned.' })
  async findOne(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
  ) {
    const auth = await this.dealsService.verifyAuth(authorization);
    return this.dealsService.findOne(auth, id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a new deal card in the Kanban pipeline',
  })
  @ApiBody({ type: CreateDealSwaggerDto })
  @ApiResponse({ status: 201, description: 'Deal created.' })
  async create(
    @Headers('authorization') authorization: string | undefined,
    @Body() dto: CreateDealSwaggerDto,
  ) {
    const auth = await this.dealsService.verifyAuth(authorization);
    return this.dealsService.create(auth, dto);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update deal details or move deal card to a new Kanban stage',
    description:
      'Automatically updates win probability when `stage` changes and records a stage-change event in the deal timeline.',
  })
  @ApiParam({
    name: 'id',
    description: 'Unique deal record ID',
    example: 'del_01a2b3c4d5e6',
  })
  @ApiBody({ type: UpdateDealSwaggerDto })
  @ApiResponse({ status: 200, description: 'Deal updated.' })
  async update(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
    @Body() dto: UpdateDealSwaggerDto,
  ) {
    const auth = await this.dealsService.verifyAuth(authorization);
    return this.dealsService.update(auth, id, dto);
  }

  @Post(':id/activities')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Add a negotiation note or quotation log to a deal',
  })
  @ApiParam({
    name: 'id',
    description: 'Unique deal record ID',
    example: 'del_01a2b3c4d5e6',
  })
  @ApiBody({ type: AddDealActivitySwaggerDto })
  @ApiResponse({ status: 201, description: 'Activity added to deal.' })
  async addActivity(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
    @Body() body: AddDealActivitySwaggerDto,
  ) {
    const auth = await this.dealsService.verifyAuth(authorization);
    return this.dealsService.addActivity(auth, id, body);
  }

  @Post(':id/ai-analyze')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Run SetuAI 360° Deal Intent Scoring, Summary & Next Best Action recommendation',
  })
  @ApiParam({
    name: 'id',
    description: 'Unique deal record ID',
    example: 'del_01a2b3c4d5e6',
  })
  @ApiResponse({
    status: 200,
    description:
      'Returns updated deal with live LLM `aiScore`, `aiLabel`, `aiSummary`, `aiNextAction`, and `aiReasons`.',
  })
  async analyzeWithAi(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
  ) {
    const auth = await this.dealsService.verifyAuth(authorization);
    return this.dealsService.analyzeWithAi(auth, id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Delete a deal from the pipeline',
  })
  @ApiParam({
    name: 'id',
    description: 'Unique deal record ID',
    example: 'del_01a2b3c4d5e6',
  })
  @ApiResponse({ status: 200, description: 'Deal deleted.' })
  async remove(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
  ) {
    const auth = await this.dealsService.verifyAuth(authorization);
    return this.dealsService.remove(auth, id);
  }
}
