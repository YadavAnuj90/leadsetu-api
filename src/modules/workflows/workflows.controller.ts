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
import { CreateWorkflowDto } from './dto/workflows.dto';
import { WorkflowsService } from './workflows.service';

@ApiTags('9. AI Workflows & Automation')
@ApiBearerAuth('access-token')
@Controller('workflows')
export class WorkflowsController {
  constructor(private readonly workflowsService: WorkflowsService) {}

  @Get()
  @ApiOperation({
    summary:
      'List all AI Workflows & IF-THIS-THEN-THAT automation rules with execution stats',
  })
  @ApiQuery({
    name: 'search',
    required: false,
    description: 'Search by workflow name, trigger condition, or action',
    example: 'IndiaMART',
  })
  @ApiQuery({
    name: 'triggerType',
    required: false,
    enum: [
      'all',
      'lead.created',
      'lead.hot_scored',
      'lead.stale_followup',
      'deal.stage_changed',
      'invoice.overdue',
      'whatsapp.inbound',
    ],
    description: 'Filter by event trigger type',
  })
  @ApiQuery({
    name: 'active',
    required: false,
    enum: ['all', 'true', 'false'],
    description: 'Filter by active/paused status',
  })
  @ApiResponse({
    status: 200,
    description: 'Returns `{ data: Workflow[], stats: WorkflowStats }`.',
  })
  async findAll(
    @Headers('authorization') authorization: string | undefined,
    @Query()
    query: { search?: string; triggerType?: string; active?: string },
  ) {
    const auth = await this.workflowsService.verifyAuth(authorization);
    return this.workflowsService.findAll(auth, query);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a new Zero-Code AI Sales Automation Workflow',
  })
  @ApiBody({ type: CreateWorkflowDto })
  @ApiResponse({ status: 201, description: 'Workflow created.' })
  async create(
    @Headers('authorization') authorization: string | undefined,
    @Body() dto: CreateWorkflowDto,
  ) {
    const auth = await this.workflowsService.verifyAuth(authorization);
    return this.workflowsService.create(auth, dto);
  }

  @Patch(':id/toggle')
  @ApiOperation({
    summary: 'Toggle a workflow between Active and Paused',
  })
  @ApiParam({
    name: 'id',
    description: 'Unique workflow record ID',
    example: 'wf_01a2b3c4d5e6',
  })
  @ApiResponse({ status: 200, description: 'Workflow status toggled.' })
  async toggle(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
  ) {
    const auth = await this.workflowsService.verifyAuth(authorization);
    return this.workflowsService.toggleActive(auth, id);
  }

  @Post('run-stale-followups')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Run automated WhatsApp follow-up sweep for leads sitting in New / Proposal Sent past delay threshold',
  })
  async runStaleFollowUps(
    @Headers('authorization') authorization: string | undefined,
    @Body() body?: { workflowId?: string; forceImmediate?: boolean },
  ) {
    const auth = await this.workflowsService.verifyAuth(authorization);
    return this.workflowsService.runStaleLeadFollowUps(auth, body);
  }

  @Post(':id/execute')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Execute / Test a workflow immediately (creates a real follow-up task & logs execution)',
  })
  @ApiParam({
    name: 'id',
    description: 'Unique workflow record ID',
    example: 'wf_01a2b3c4d5e6',
  })
  @ApiResponse({ status: 200, description: 'Workflow executed.' })
  async execute(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
  ) {
    const auth = await this.workflowsService.verifyAuth(authorization);
    return this.workflowsService.executeNow(auth, id);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Delete an automation workflow',
  })
  @ApiParam({
    name: 'id',
    description: 'Unique workflow record ID',
    example: 'wf_01a2b3c4d5e6',
  })
  @ApiResponse({ status: 200, description: 'Workflow deleted.' })
  async remove(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
  ) {
    const auth = await this.workflowsService.verifyAuth(authorization);
    return this.workflowsService.remove(auth, id);
  }
}
