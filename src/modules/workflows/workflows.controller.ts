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
import { CreateWorkflowDto, UpdateWorkflowDto } from './dto/workflows.dto';
import { WorkflowsService } from './workflows.service';

@ApiTags('9. AI Workflows & Automation')
@ApiBearerAuth('access-token')
@Controller('workflows')
export class WorkflowsController {
  constructor(private readonly workflowsService: WorkflowsService) {}

  @Get()
  @ApiOperation({
    summary:
      'List all Visual AI Workflows & WhatsApp Drip Sequences with execution stats',
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
  })
  @ApiQuery({
    name: 'active',
    required: false,
    enum: ['all', 'true', 'false'],
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
    summary: 'Create a new Visual Trigger -> Condition -> Delay -> Action Workflow',
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

  @Patch(':id')
  @ApiOperation({
    summary: 'Update a Visual Workflow & its ordered Trigger/Condition/Delay/Action nodes',
  })
  @ApiBody({ type: UpdateWorkflowDto })
  async update(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
    @Body() dto: UpdateWorkflowDto,
  ) {
    const auth = await this.workflowsService.verifyAuth(authorization);
    return this.workflowsService.updateWorkflow(auth, id, dto);
  }

  @Post('ai-draft')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Convert natural-language English/Hinglish instruction into structured visual workflow nodes & WhatsApp drip template',
  })
  async draftWithAi(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: { prompt: string; language?: string },
  ) {
    const auth = await this.workflowsService.verifyAuth(authorization);
    return this.workflowsService.draftWithAi(auth, body || {});
  }

  @Get(':id/enrollments')
  @ApiOperation({
    summary: 'List live lead drip enrollments & step-by-step execution status for a workflow',
  })
  async listEnrollments(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
  ) {
    const auth = await this.workflowsService.verifyAuth(authorization);
    return this.workflowsService.listWorkflowEnrollments(auth, id);
  }

  @Post(':id/simulate-lead')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Simulate a lead entering the Visual Workflow (optionally fast-forwarding Delay nodes to test all steps immediately)',
  })
  async simulateLead(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
    @Body() body?: { forceAdvance?: boolean; forceSkipDelays?: boolean },
  ) {
    const auth = await this.workflowsService.verifyAuth(authorization);
    return this.workflowsService.simulateLeadThroughWorkflow(auth, id, {
      forceSkipDelays: body?.forceAdvance ?? body?.forceSkipDelays ?? true,
    });
  }

  @Post('process-due-drips')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Process all due multi-step WhatsApp drip & SLA escalation enrollments for the current workspace',
  })
  async processDueDrips(
    @Headers('authorization') authorization: string | undefined,
    @Body() body?: { workflowId?: string; forceAdvance?: boolean; forceSkipDelays?: boolean },
  ) {
    const auth = await this.workflowsService.verifyAuth(authorization);
    return this.workflowsService.processDueEnrollments({
      tenantId: auth.tenantId,
      workflowId: body?.workflowId,
      forceSkipDelays: body?.forceAdvance ?? body?.forceSkipDelays,
    });
  }

  @Patch(':id/toggle')
  @ApiOperation({
    summary: 'Toggle a workflow between Active and Paused',
  })
  @ApiParam({ name: 'id', description: 'Unique workflow record ID' })
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
      'Execute / Test a workflow immediately (runs visual steps or creates a follow-up task & logs execution)',
  })
  @ApiParam({ name: 'id', description: 'Unique workflow record ID' })
  async execute(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
  ) {
    const auth = await this.workflowsService.verifyAuth(authorization);
    return this.workflowsService.executeNow(auth, id);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Delete an automation workflow and its drip enrollments',
  })
  @ApiParam({ name: 'id', description: 'Unique workflow record ID' })
  async remove(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
  ) {
    const auth = await this.workflowsService.verifyAuth(authorization);
    return this.workflowsService.remove(auth, id);
  }
}
