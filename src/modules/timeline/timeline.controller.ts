import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import {
  TimelineEntityType,
  TimelineService,
} from './timeline.service';

@ApiTags('Customer 360 Unified Timeline')
@ApiBearerAuth('access-token')
@Controller('timeline')
export class TimelineController {
  constructor(private readonly timelineService: TimelineService) {}

  @Get(':entityType/:id')
  @ApiOperation({
    summary:
      'Get Customer 360 Unified Timeline aggregating Leads, Contacts, Deals, WhatsApp Messages, Calls, Tasks, Tickets & GST Invoices',
  })
  @ApiParam({
    name: 'entityType',
    enum: ['lead', 'contact', 'deal'],
    example: 'contact',
  })
  @ApiParam({ name: 'id', description: 'MongoDB ObjectId of the record' })
  @ApiQuery({
    name: 'category',
    required: false,
    enum: ['all', 'whatsapp', 'calls', 'invoices', 'tasks', 'tickets', 'notes'],
  })
  async getEntityTimeline(
    @Headers('authorization') authorization: string | undefined,
    @Param('entityType') entityType: TimelineEntityType,
    @Param('id') id: string,
    @Query('category') category?: string,
  ) {
    const auth = await this.timelineService.verifyAuth(authorization);
    const safeType: TimelineEntityType =
      entityType === 'contact' || entityType === 'deal' ? entityType : 'lead';
    return this.timelineService.getCustomer360Timeline(
      auth,
      safeType,
      id,
      category,
    );
  }

  @Post(':entityType/:id/note')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Log a new Note, Call, or WhatsApp interaction directly into the Customer 360 Timeline',
  })
  async addNote(
    @Headers('authorization') authorization: string | undefined,
    @Param('entityType') entityType: TimelineEntityType,
    @Param('id') id: string,
    @Body() body: { type?: 'note' | 'call' | 'whatsapp'; description: string },
  ) {
    const auth = await this.timelineService.verifyAuth(authorization);
    const safeType: TimelineEntityType =
      entityType === 'contact' || entityType === 'deal' ? entityType : 'lead';
    return this.timelineService.addTimelineNote(auth, safeType, id, body);
  }
}
