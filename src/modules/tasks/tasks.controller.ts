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
import { CreateTaskDto, UpdateTaskDto } from './dto/tasks.dto';
import { TasksService } from './tasks.service';

@ApiTags('5. Tasks & Call Reminders')
@ApiBearerAuth('access-token')
@Controller('tasks')
export class TasksController {
  constructor(private readonly tasksService: TasksService) {}

  @Get()
  @ApiOperation({
    summary: 'List all follow-up tasks & call reminders with completion KPIs',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['all', 'pending', 'in_progress', 'done'],
    description: 'Filter tasks by completion status',
  })
  @ApiQuery({
    name: 'priority',
    required: false,
    enum: ['all', 'high', 'medium', 'low'],
    description: 'Filter tasks by priority',
  })
  @ApiQuery({
    name: 'search',
    required: false,
    description: 'Search by task title, buyer name, or company',
  })
  @ApiResponse({
    status: 200,
    description: 'Returns `{ data: Task[], stats: TasksStats }`.',
  })
  async findAll(
    @Headers('authorization') authorization: string | undefined,
    @Query() query: { status?: string; priority?: string; search?: string },
  ) {
    const auth = await this.tasksService.verifyAuth(authorization);
    return this.tasksService.findAll(auth, query);
  }

  @Post('seed')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Seed 4 sample sales follow-up & site visit tasks',
  })
  @ApiResponse({ status: 201, description: '4 sample tasks created.' })
  async seed(@Headers('authorization') authorization: string | undefined) {
    const auth = await this.tasksService.verifyAuth(authorization);
    return this.tasksService.seedSamples(auth);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a new sales follow-up or call reminder task',
  })
  @ApiBody({ type: CreateTaskDto })
  @ApiResponse({ status: 201, description: 'Task created.' })
  async create(
    @Headers('authorization') authorization: string | undefined,
    @Body() dto: CreateTaskDto,
  ) {
    const auth = await this.tasksService.verifyAuth(authorization);
    return this.tasksService.create(auth, dto);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update task details or toggle completion status (`pending` / `done`)',
  })
  @ApiParam({
    name: 'id',
    description: 'MongoDB ObjectId of the task',
    example: '672e1a2b3c4d5e6f7a8b9c0d',
  })
  @ApiBody({ type: UpdateTaskDto })
  @ApiResponse({ status: 200, description: 'Task updated.' })
  async update(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
    @Body() dto: UpdateTaskDto,
  ) {
    const auth = await this.tasksService.verifyAuth(authorization);
    return this.tasksService.update(auth, id, dto);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Delete a follow-up task by ID',
  })
  @ApiParam({
    name: 'id',
    description: 'MongoDB ObjectId of the task',
    example: '672e1a2b3c4d5e6f7a8b9c0d',
  })
  @ApiResponse({ status: 200, description: 'Task deleted.' })
  async remove(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
  ) {
    const auth = await this.tasksService.verifyAuth(authorization);
    return this.tasksService.remove(auth, id);
  }
}
