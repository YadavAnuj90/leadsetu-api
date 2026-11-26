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
import {
  CreateLeadDto,
  LeadsQuery,
  LeadsService,
  MergeLeadsDto,
  UpdateLeadDto,
} from './leads.service';
import { LeadActivity, LeadSource, LeadStatus } from './schemas/lead.schema';

export class CreateLeadSwaggerDto implements CreateLeadDto {
  @ApiProperty({
    description: 'Full name of the buyer / lead',
    example: 'Rajesh Sharma',
  })
  name!: string;

  @ApiPropertyOptional({
    description: 'Record classification: B2B company account vs B2C individual consumer',
    enum: ['business', 'consumer'],
    default: 'business',
    example: 'business',
  })
  accountKind?: 'business' | 'consumer';

  @ApiPropertyOptional({
    description: 'Company or organization name',
    example: 'RS Electricals Pvt. Ltd.',
  })
  company?: string;

  @ApiPropertyOptional({
    description: 'WhatsApp or mobile phone number (+91)',
    example: '+91 98112 45678',
  })
  phone?: string;

  @ApiPropertyOptional({
    description: 'Buyer email address',
    example: 'rajesh@rselectricals.in',
  })
  email?: string;

  @ApiPropertyOptional({
    description: 'Buyer city / industrial hub',
    example: 'Noida Electronic City',
    default: 'New Delhi',
  })
  city?: string;

  @ApiPropertyOptional({
    description: 'Lead acquisition source channel',
    enum: [
      'whatsapp',
      'indiamart',
      'justdial',
      'meta_ads',
      'google_ads',
      'website',
      'referral',
      'manual',
    ],
    default: 'whatsapp',
    example: 'whatsapp',
  })
  source?: LeadSource;

  @ApiPropertyOptional({
    description: 'Current lead qualification stage',
    enum: ['new', 'contacted', 'qualified', 'proposal', 'converted', 'lost'],
    default: 'new',
    example: 'qualified',
  })
  status?: LeadStatus;

  @ApiPropertyOptional({
    description: 'Estimated deal value in INR (₹)',
    example: 450000,
    default: 0,
  })
  estimatedValue?: number;

  @ApiPropertyOptional({
    description: 'Custom tags for segmentation',
    type: [String],
    example: ['Bulk Order', '18% GST Quote'],
  })
  tags?: string[];

  @ApiPropertyOptional({
    description:
      'Buyer requirement notes (analyzed by SetuAI Lead Scorer for urgency & budget keywords)',
    example:
      'Urgent requirement for 500 industrial switchgear units with GST proforma invoice.',
  })
  notes?: string;

  @ApiPropertyOptional({
    description: 'Tenant-defined custom field key/value pairs (e.g. MOQ, Plant Location)',
    type: Object,
    example: { moq: 500, plant_location: 'Noida Phase-II' },
  })
  customFields?: Record<string, unknown>;
}

export class UpdateLeadSwaggerDto
  extends CreateLeadSwaggerDto
  implements UpdateLeadDto
{
  @ApiPropertyOptional({
    description: 'Force re-calculation of SetuAI Lead Score (1–100)',
    example: true,
  })
  rescoreAi?: boolean;
}

export class AddLeadActivitySwaggerDto {
  @ApiPropertyOptional({
    description: 'Activity log category',
    enum: ['note', 'call', 'whatsapp', 'status_change'],
    default: 'note',
    example: 'whatsapp',
  })
  type?: LeadActivity['type'];

  @ApiProperty({
    description: 'Detailed summary of the call, WhatsApp reply, or internal note',
    example: 'Shared 18% GST proforma quotation on WhatsApp. Follow-up call at 4 PM.',
  })
  description!: string;
}

@ApiTags('2. Leads & SetuAI Scoring')
@ApiBearerAuth('access-token')
@Controller('leads')
export class LeadsController {
  constructor(private readonly leadsService: LeadsService) {}

  @Get()
  @ApiOperation({
    summary: 'List all workspace leads with search, filters & real-time KPI stats',
    description:
      'Returns tenant-scoped leads sorted by AI Score, Deal Value, or Created Date along with workspace KPI totals.',
  })
  @ApiQuery({
    name: 'search',
    required: false,
    description: 'Search by buyer name, company, phone, email, or city',
    example: 'Rajesh',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['all', 'new', 'contacted', 'qualified', 'proposal', 'converted', 'lost'],
    description: 'Filter by lead stage',
  })
  @ApiQuery({
    name: 'source',
    required: false,
    enum: [
      'all',
      'whatsapp',
      'indiamart',
      'justdial',
      'meta_ads',
      'google_ads',
      'website',
      'referral',
      'manual',
    ],
    description: 'Filter by lead source channel',
  })
  @ApiQuery({
    name: 'aiLabel',
    required: false,
    enum: ['all', 'Hot', 'Warm', 'Cold'],
    description: 'Filter by SetuAI heat label',
  })
  @ApiQuery({
    name: 'accountKind',
    required: false,
    enum: ['all', 'business', 'consumer'],
    description: 'Filter by B2B business account vs B2C individual consumer',
  })
  @ApiQuery({
    name: 'adPlatform',
    required: false,
    enum: ['all', 'meta_ctwa'],
    description: 'Filter by Meta Click-to-WhatsApp Ad attribution',
  })
  @ApiQuery({
    name: 'sortBy',
    required: false,
    enum: ['aiScore', 'estimatedValue', 'createdAt'],
    description: 'Sort order for leads list',
  })
  @ApiResponse({
    status: 200,
    description: 'Returns `{ data: Lead[], stats: LeadsStats }`.',
  })
  async findAll(
    @Headers('authorization') authorization: string | undefined,
    @Query() query: LeadsQuery,
  ) {
    const auth = await this.leadsService.verifyAuth(authorization);
    return this.leadsService.findAll(auth, query);
  }

  @Post('bulk-import')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Bulk import & de-duplicate CSV/Excel lead rows with AI scoring',
    description:
      'Imports up to 500 CSV/Excel rows, normalizes +91 Indian mobile numbers, supports skip/update duplicate strategies, custom fields, and optional lead routing.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['rows'],
      properties: {
        duplicateMode: {
          type: 'string',
          enum: ['update', 'skip'],
          default: 'update',
        },
        autoRoute: {
          type: 'boolean',
          default: false,
        },
        rows: {
          type: 'array',
          description: 'Array of parsed CSV/Excel lead objects',
          items: { type: 'object' },
          example: [{ name: 'Rajesh Sharma', company: 'RS Electricals', phone: '+91 9811001122', city: 'Noida', source: 'indiamart', estimatedValue: 250000 }],
        },
      },
    },
  })
  @ApiResponse({ status: 201, description: 'Bulk import completed.' })
  async bulkImport(
    @Headers('authorization') authorization: string | undefined,
    @Body()
    body: {
      rows: CreateLeadSwaggerDto[];
      duplicateMode?: 'update' | 'skip';
      autoRoute?: boolean;
    },
  ) {
    const auth = await this.leadsService.verifyAuth(authorization);
    return this.leadsService.bulkImport(auth, body?.rows ?? [], {
      duplicateMode: body?.duplicateMode,
      autoRoute: body?.autoRoute,
    });
  }

  @Get('duplicates')
  @ApiOperation({
    summary: 'Detect duplicate lead clusters matching normalized phone (+91) or email',
  })
  @ApiResponse({ status: 200, description: 'Returns grouped duplicate lead clusters.' })
  async findDuplicates(
    @Headers('authorization') authorization: string | undefined,
  ) {
    const auth = await this.leadsService.verifyAuth(authorization);
    return this.leadsService.findDuplicates(auth);
  }

  @Post('merge')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Merge duplicate leads into a single master record preserving history & relations',
  })
  @ApiResponse({ status: 200, description: 'Duplicate leads merged into master record.' })
  async mergeLeads(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: MergeLeadsDto,
  ) {
    const auth = await this.leadsService.verifyAuth(authorization);
    return this.leadsService.mergeLeads(auth, body);
  }

  @Get('webhook/config')
  @ApiOperation({
    summary: 'Get tenant inbound webhook capture URL, key, and recent captures',
  })
  @ApiResponse({ status: 200, description: 'Webhook configuration returned.' })
  async getWebhookConfig(
    @Headers('authorization') authorization: string | undefined,
  ) {
    const auth = await this.leadsService.verifyAuth(authorization);
    return this.leadsService.getWebhookConfig(auth);
  }

  @Post('webhook/rotate-key')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Rotate workspace inbound lead capture webhook key (Owner/Admin)',
  })
  @ApiResponse({ status: 200, description: 'Webhook key rotated.' })
  async rotateWebhookKey(
    @Headers('authorization') authorization: string | undefined,
  ) {
    const auth = await this.leadsService.verifyAuth(authorization);
    return this.leadsService.rotateWebhookKey(auth);
  }

  @Post('webhook/:webhookKey')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Public inbound webhook lead capture (IndiaMART, Justdial, Meta Ads, Website)',
    description:
      'Captures inbound inquiry JSON, normalizes +91 phones, de-duplicates existing leads, and assigns new leads round-robin across active workspace reps.',
  })
  @ApiParam({ name: 'webhookKey', description: 'Tenant unique inbound capture key' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string', example: 'Vikram Singh' },
        company: { type: 'string', example: 'Apex Gears Pvt. Ltd.' },
        phone: { type: 'string', example: '+91 9876543210' },
        email: { type: 'string', example: 'vikram@apexgears.in' },
        city: { type: 'string', example: 'Gurugram' },
        source: { type: 'string', example: 'indiamart' },
        notes: { type: 'string', example: 'Looking for 100 units 3-phase starter panels' },
      },
    },
  })
  @ApiResponse({ status: 201, description: 'Inbound webhook inquiry processed.' })
  async captureWebhook(
    @Param('webhookKey') webhookKey: string,
    @Body() payload: Record<string, unknown>,
  ) {
    return this.leadsService.captureWebhook(webhookKey, payload ?? {});
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get 360° details and activity timeline for a single lead',
  })
  @ApiParam({
    name: 'id',
    description: 'Unique lead record ID',
    example: 'ld_01a2b3c4d5e6',
  })
  @ApiResponse({ status: 200, description: 'Lead object with activities timeline.' })
  @ApiResponse({ status: 404, description: 'Lead not found.' })
  async findOne(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
  ) {
    const auth = await this.leadsService.verifyAuth(authorization);
    return this.leadsService.findOne(auth, id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a new lead (auto-scored 1–100 by SetuAI engine)',
    description:
      'Automatically computes `aiScore` (1–100), `aiLabel` (`Hot`/`Warm`/`Cold`), and `aiInsight` based on source, value, and requirement notes.',
  })
  @ApiBody({ type: CreateLeadSwaggerDto })
  @ApiResponse({ status: 201, description: 'Lead created and scored.' })
  async create(
    @Headers('authorization') authorization: string | undefined,
    @Body() dto: CreateLeadSwaggerDto,
  ) {
    const auth = await this.leadsService.verifyAuth(authorization);
    return this.leadsService.create(auth, dto);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update lead fields or pipeline stage (re-computes AI score)',
  })
  @ApiParam({
    name: 'id',
    description: 'Unique lead record ID',
    example: 'ld_01a2b3c4d5e6',
  })
  @ApiBody({ type: UpdateLeadSwaggerDto })
  @ApiResponse({ status: 200, description: 'Updated lead returned.' })
  async update(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
    @Body() dto: UpdateLeadSwaggerDto,
  ) {
    const auth = await this.leadsService.verifyAuth(authorization);
    return this.leadsService.update(auth, id, dto);
  }

  @Post(':id/activities')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Append a call log, WhatsApp follow-up, or internal note to lead timeline',
  })
  @ApiParam({
    name: 'id',
    description: 'Unique lead record ID',
    example: 'ld_01a2b3c4d5e6',
  })
  @ApiBody({ type: AddLeadActivitySwaggerDto })
  @ApiResponse({ status: 201, description: 'Updated lead with new timeline event.' })
  async addActivity(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
    @Body() body: AddLeadActivitySwaggerDto,
  ) {
    const auth = await this.leadsService.verifyAuth(authorization);
    return this.leadsService.addActivity(auth, id, body);
  }

  @Post(':id/ai-analyze')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Run SetuAI 360° Lead Intent Scoring, Summary & Next Best Action recommendation',
  })
  @ApiParam({
    name: 'id',
    description: 'Unique lead record ID',
    example: 'ld_01a2b3c4d5e6',
  })
  @ApiResponse({
    status: 200,
    description:
      'Returns updated lead with live LLM `aiScore`, `aiLabel`, `aiSummary`, `aiNextAction`, and `aiReasons`.',
  })
  async analyzeWithAi(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
  ) {
    const auth = await this.leadsService.verifyAuth(authorization);
    return this.leadsService.analyzeWithAi(auth, id);
  }

  @Post(':id/auto-assign')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Auto-assign or re-route a lead using Smart Lead Routing rules',
    description:
      'Evaluates workspace Territory, Round-Robin, or Load-Balanced daily cap rules to assign the lead to an eligible sales rep and logs the routing reason.',
  })
  @ApiParam({
    name: 'id',
    description: 'Unique lead record ID',
    example: 'ld_01a2b3c4d5e6',
  })
  @ApiResponse({
    status: 200,
    description: 'Returns updated lead plus `routing` resolution trace.',
  })
  async autoAssign(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
  ) {
    const auth = await this.leadsService.verifyAuth(authorization);
    return this.leadsService.autoAssignLead(auth, id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Delete a lead by ID',
  })
  @ApiParam({
    name: 'id',
    description: 'Unique lead record ID',
    example: 'ld_01a2b3c4d5e6',
  })
  @ApiResponse({ status: 200, description: 'Lead deleted.' })
  async remove(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
  ) {
    const auth = await this.leadsService.verifyAuth(authorization);
    return this.leadsService.remove(auth, id);
  }
}
