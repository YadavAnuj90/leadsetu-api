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
  AddTicketCommentDto,
  CreateTicketDto,
  UpdateTicketDto,
} from './dto/tickets.dto';
import { TicketsService } from './tickets.service';

@ApiTags('13. Support & SLA Tickets')
@ApiBearerAuth('access-token')
@Controller('tickets')
export class TicketsController {
  constructor(private readonly ticketsService: TicketsService) {}

  @Get()
  @ApiOperation({
    summary: 'List customer support, warranty & dispatch SLA tickets',
  })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'priority', required: false })
  @ApiQuery({ name: 'category', required: false })
  @ApiQuery({ name: 'slaBreached', required: false })
  @ApiQuery({ name: 'assignedOnly', required: false })
  @ApiQuery({ name: 'search', required: false })
  @ApiResponse({
    status: 200,
    description: 'Returns `{ data: Ticket[], stats }`.',
  })
  async list(
    @Headers('authorization') authorization: string | undefined,
    @Query()
    query: {
      status?: string;
      priority?: string;
      category?: string;
      slaBreached?: string;
      assignedOnly?: string;
      search?: string;
    },
  ) {
    const auth = await this.ticketsService.verifyAuth(authorization);
    return this.ticketsService.findAll(auth, query);
  }

  @Get('assignees')
  @ApiOperation({
    summary: 'List active Support Engineers & workspace team assignees for ticket routing',
  })
  async listAssignees(
    @Headers('authorization') authorization: string | undefined,
  ) {
    const auth = await this.ticketsService.verifyAuth(authorization);
    return this.ticketsService.listAssignees(auth);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get a single SLA ticket with full comment & resolution timeline',
  })
  @ApiParam({ name: 'id', description: 'Unique ticket record ID' })
  async findOne(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
  ) {
    const auth = await this.ticketsService.verifyAuth(authorization);
    return this.ticketsService.findOne(auth, id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a customer support / SLA ticket' })
  @ApiBody({ type: CreateTicketDto })
  async create(
    @Headers('authorization') authorization: string | undefined,
    @Body() dto: CreateTicketDto,
  ) {
    const auth = await this.ticketsService.verifyAuth(authorization);
    return this.ticketsService.create(auth, dto);
  }

  @Patch(':id')
  @ApiOperation({
    summary:
      'Update ticket status, priority, engineer assignment, resolution summary, or CSAT',
  })
  @ApiParam({ name: 'id', description: 'Unique ticket record ID' })
  async update(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
    @Body() dto: UpdateTicketDto,
  ) {
    const auth = await this.ticketsService.verifyAuth(authorization);
    return this.ticketsService.update(auth, id, dto);
  }

  @Post(':id/comments')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Add a customer reply or internal engineer note to a ticket (optionally updating status)',
  })
  @ApiParam({ name: 'id', description: 'Unique ticket record ID' })
  @ApiBody({ type: AddTicketCommentDto })
  async addComment(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
    @Body() dto: AddTicketCommentDto,
  ) {
    const auth = await this.ticketsService.verifyAuth(authorization);
    return this.ticketsService.addComment(auth, id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a support ticket' })
  @ApiParam({ name: 'id', description: 'Unique ticket record ID' })
  async remove(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
  ) {
    const auth = await this.ticketsService.verifyAuth(authorization);
    return this.ticketsService.remove(auth, id);
  }
}
