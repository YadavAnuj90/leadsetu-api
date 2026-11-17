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
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  CreateCampaignDto,
  UpdateCampaignDto,
} from './dto/campaigns.dto';
import { CampaignsService } from './campaigns.service';

@ApiTags('8. WhatsApp Broadcast Campaigns')
@ApiBearerAuth('access-token')
@Controller('campaigns')
export class CampaignsController {
  constructor(private readonly campaignsService: CampaignsService) {}

  @Get()
  @ApiOperation({
    summary:
      'List all WhatsApp Broadcast Campaigns with delivery/read/reply rates & live CRM segment counts',
  })
  @ApiQuery({
    name: 'search',
    required: false,
    description: 'Search by campaign name, Meta template slug, or message body',
    example: 'Noida',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['all', 'completed', 'running', 'scheduled', 'draft'],
    description: 'Filter by campaign status',
  })
  @ApiQuery({
    name: 'targetSegment',
    required: false,
    enum: [
      'all',
      'all_leads',
      'hot_leads',
      'noida_delhi_ncr',
      'indiamart_buyers',
      'gst_customers',
    ],
    description: 'Filter by target audience segment',
  })
  @ApiResponse({
    status: 200,
    description: 'Returns `{ data: Campaign[], stats: CampaignStats }`.',
  })
  async findAll(
    @Headers('authorization') authorization: string | undefined,
    @Query()
    query: { search?: string; status?: string; targetSegment?: string },
  ) {
    const auth = await this.campaignsService.verifyAuth(authorization);
    return this.campaignsService.findAll(auth, query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get a single WhatsApp Broadcast Campaign by ID',
  })
  @ApiParam({
    name: 'id',
    description: 'Unique campaign record ID',
    example: 'cmp_01a2b3c4d5e6',
  })
  @ApiResponse({ status: 200, description: 'Campaign returned.' })
  async findOne(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
  ) {
    const auth = await this.campaignsService.verifyAuth(authorization);
    return this.campaignsService.findOne(auth, id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Create & launch (or schedule) a new Official WhatsApp Cloud Broadcast Campaign',
  })
  @ApiBody({ type: CreateCampaignDto })
  @ApiResponse({ status: 201, description: 'Campaign created and launched.' })
  async create(
    @Headers('authorization') authorization: string | undefined,
    @Body() dto: CreateCampaignDto,
  ) {
    const auth = await this.campaignsService.verifyAuth(authorization);
    return this.campaignsService.create(auth, dto);
  }

  @Post(':id/launch')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Trigger immediate WhatsApp Cloud API dispatch for a draft or scheduled campaign',
  })
  @ApiParam({
    name: 'id',
    description: 'Unique campaign record ID',
    example: 'cmp_01a2b3c4d5e6',
  })
  @ApiResponse({ status: 200, description: 'Campaign dispatched.' })
  async launch(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
  ) {
    const auth = await this.campaignsService.verifyAuth(authorization);
    return this.campaignsService.launchCampaign(auth, id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update a WhatsApp Broadcast Campaign',
  })
  @ApiParam({
    name: 'id',
    description: 'Unique campaign record ID',
    example: 'cmp_01a2b3c4d5e6',
  })
  @ApiBody({ type: UpdateCampaignDto })
  @ApiResponse({ status: 200, description: 'Campaign updated.' })
  async update(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
    @Body() dto: UpdateCampaignDto,
  ) {
    const auth = await this.campaignsService.verifyAuth(authorization);
    return this.campaignsService.update(auth, id, dto);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Delete a WhatsApp Broadcast Campaign',
  })
  @ApiParam({
    name: 'id',
    description: 'Unique campaign record ID',
    example: 'cmp_01a2b3c4d5e6',
  })
  @ApiResponse({ status: 200, description: 'Campaign deleted.' })
  async remove(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
  ) {
    const auth = await this.campaignsService.verifyAuth(authorization);
    return this.campaignsService.remove(auth, id);
  }
}
