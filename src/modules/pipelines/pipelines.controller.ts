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
import { CreatePipelineDto, UpdatePipelineDto } from './dto/pipeline.dto';
import { PipelinesService } from './pipelines.service';

@ApiTags('3. Deals & Kanban Pipeline')
@ApiBearerAuth('access-token')
@Controller('pipelines')
export class PipelinesController {
  constructor(private readonly pipelinesService: PipelinesService) {}

  @Get()
  @ApiOperation({
    summary: 'List all sales pipelines & custom stage schemas for the workspace',
    description:
      'Returns ordered sales pipelines with per-stage win probabilities, colors, outcome categories (`open`/`won`/`lost`), and live deal counts.',
  })
  @ApiResponse({ status: 200, description: 'Returns `{ data: Pipeline[], defaultPipelineId }`.' })
  async list(@Headers('authorization') authorization: string | undefined) {
    const auth = await this.pipelinesService.verifyAuth(authorization);
    return this.pipelinesService.listPipelines(auth);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a custom multi-stage sales pipeline (Owner/Admin)',
    description:
      'Creates a new pipeline from custom stages or an industry template (`b2b_sales`, `dealer_onboarding`, `amc_renewals`, `blank`).',
  })
  @ApiBody({ type: CreatePipelineDto })
  @ApiResponse({ status: 201, description: 'Pipeline created successfully.' })
  async create(
    @Headers('authorization') authorization: string | undefined,
    @Body() dto: CreatePipelineDto,
  ) {
    const auth = await this.pipelinesService.verifyAuth(authorization);
    return this.pipelinesService.createPipeline(auth, dto);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update pipeline metadata, stage order, probabilities, or migrate removed stages (Owner/Admin)',
    description:
      'Updates pipeline name/stages and safely migrates existing deals if any stage ID was removed.',
  })
  @ApiParam({ name: 'id', description: 'Pipeline ID' })
  @ApiBody({ type: UpdatePipelineDto })
  async update(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
    @Body() dto: UpdatePipelineDto,
  ) {
    const auth = await this.pipelinesService.verifyAuth(authorization);
    return this.pipelinesService.updatePipeline(auth, id, dto);
  }

  @Post(':id/set-default')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Set a pipeline as the workspace default (Owner/Admin)',
    description: 'Marks the specified pipeline as default for new deals and the primary Kanban board.',
  })
  @ApiParam({ name: 'id', description: 'Pipeline ID' })
  async setDefault(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
  ) {
    const auth = await this.pipelinesService.verifyAuth(authorization);
    return this.pipelinesService.setDefaultPipeline(auth, id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Delete a custom pipeline and reassign its deals (Owner/Admin)',
    description:
      'Deletes a non-default pipeline and safely moves any deals inside it to `reassignToPipelineId` or the default pipeline.',
  })
  @ApiParam({ name: 'id', description: 'Pipeline ID to remove' })
  @ApiQuery({
    name: 'reassignToPipelineId',
    required: false,
    description: 'Optional destination pipeline ID for existing deals (defaults to workspace default pipeline)',
  })
  async remove(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
    @Query('reassignToPipelineId') reassignToPipelineId?: string,
  ) {
    const auth = await this.pipelinesService.verifyAuth(authorization);
    return this.pipelinesService.deletePipeline(auth, id, reassignToPipelineId);
  }
}
