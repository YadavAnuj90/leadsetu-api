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
      'Buyer requirement notes (analyzed by Gemini AI Lead Scorer for urgency & budget keywords)',
    example:
      'Urgent requirement for 500 industrial switchgear units with GST proforma invoice.',
  })
  notes?: string;
}

export class UpdateLeadSwaggerDto
  extends CreateLeadSwaggerDto
  implements UpdateLeadDto
{
  @ApiPropertyOptional({
    description: 'Force re-calculation of Gemini AI Lead Score (1–100)',
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

@ApiTags('2. Leads & Gemini AI Scoring')
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
    description: 'Filter by Gemini AI heat label',
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

  @Post('seed')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Seed 5 realistic Delhi-NCR sample leads into MongoDB Atlas',
    description:
      'Populates 5 pre-scored B2B leads (WhatsApp, IndiaMART, Meta Ads, Website, Referral) for testing.',
  })
  @ApiResponse({ status: 201, description: '5 sample leads created.' })
  async seed(@Headers('authorization') authorization: string | undefined) {
    const auth = await this.leadsService.verifyAuth(authorization);
    return this.leadsService.seedSampleLeads(auth);
  }

  @Post('bulk-import')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Bulk import & de-duplicate CSV lead rows with AI scoring',
    description:
      'Imports up to 500 CSV rows, normalizes +91 Indian mobile numbers, de-duplicates matching phones/emails into timeline notes, and AI-scores new leads.',
  })
  @ApiResponse({ status: 201, description: 'Bulk import completed.' })
  async bulkImport(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: { rows: CreateLeadSwaggerDto[] },
  ) {
    const auth = await this.leadsService.verifyAuth(authorization);
    return this.leadsService.bulkImport(auth, body?.rows ?? []);
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
    description: 'MongoDB ObjectId of the lead',
    example: '672e1a2b3c4d5e6f7a8b9c0d',
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
    summary: 'Create a new lead (auto-scored 1–100 by Gemini AI engine)',
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
    description: 'MongoDB ObjectId of the lead',
    example: '672e1a2b3c4d5e6f7a8b9c0d',
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
    description: 'MongoDB ObjectId of the lead',
    example: '672e1a2b3c4d5e6f7a8b9c0d',
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

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Delete a lead by ID',
  })
  @ApiParam({
    name: 'id',
    description: 'MongoDB ObjectId of the lead',
    example: '672e1a2b3c4d5e6f7a8b9c0d',
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
