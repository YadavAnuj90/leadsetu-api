import {
  Body,
  Controller,
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
  ApiTags,
} from '@nestjs/swagger';
import {
  CreatePlatformTicketDto,
  PlatformTicketReplyDto,
  SuperAdminUpdatePlatformTicketDto,
} from './dto/platform-tickets.dto';
import { PlatformTicketsService } from './platform-tickets.service';

@ApiTags('14. HQ Platform Support Tickets')
@ApiBearerAuth('access-token')
@Controller('platform-tickets')
export class PlatformTicketsController {
  constructor(private readonly service: PlatformTicketsService) {}

  // ─── Super Admin Cross-Tenant Queue (declared before :id routes) ──────────

  @Get('hq')
  @ApiOperation({
    summary: 'Super Admin: list all customer workspace platform tickets across B2B/B2C/all modes',
  })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'priority', required: false })
  @ApiQuery({ name: 'category', required: false })
  @ApiQuery({ name: 'search', required: false })
  async listHq(
    @Headers('authorization') authorization: string | undefined,
    @Query()
    query: {
      status?: string;
      priority?: string;
      category?: string;
      search?: string;
    },
  ) {
    await this.service.verifySuperAdmin(authorization);
    return this.service.listForSuperAdmin(query);
  }

  @Patch('hq/:id')
  @ApiOperation({
    summary: 'Super Admin: update status, resolution summary or reply & notify raising Admin',
  })
  @ApiParam({ name: 'id', description: 'Platform ticket ID' })
  @ApiBody({ type: SuperAdminUpdatePlatformTicketDto })
  async updateHq(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
    @Body() dto: SuperAdminUpdatePlatformTicketDto,
  ) {
    const actor = await this.service.verifySuperAdmin(authorization);
    return this.service.updateForSuperAdmin(actor, id, dto);
  }

  // ─── Tenant Owner / Admin Routes ───────────────────────────────────────────

  @Get()
  @ApiOperation({
    summary: 'Workspace Owner/Admin: list own platform support tickets',
  })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'search', required: false })
  async listMine(
    @Headers('authorization') authorization: string | undefined,
    @Query() query: { status?: string; search?: string },
  ) {
    const actor = await this.service.verifyTenantAdmin(authorization);
    return this.service.listForTenantAdmin(actor, query);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Workspace Owner/Admin: raise platform glitch/service ticket (auto-attaches tenant identity)',
  })
  @ApiBody({ type: CreatePlatformTicketDto })
  async create(
    @Headers('authorization') authorization: string | undefined,
    @Body() dto: CreatePlatformTicketDto,
  ) {
    const actor = await this.service.verifyTenantAdmin(authorization);
    return this.service.createForTenantAdmin(actor, dto);
  }

  @Post(':id/reply')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Workspace Owner/Admin: post follow-up reply on own platform ticket',
  })
  @ApiParam({ name: 'id', description: 'Platform ticket ID' })
  @ApiBody({ type: PlatformTicketReplyDto })
  async reply(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
    @Body() dto: PlatformTicketReplyDto,
  ) {
    const actor = await this.service.verifyTenantAdmin(authorization);
    return this.service.replyForTenantAdmin(actor, id, dto);
  }

  @Patch(':id/reopen')
  @ApiOperation({
    summary: 'Workspace Owner/Admin: reopen a resolved/closed platform ticket',
  })
  @ApiParam({ name: 'id', description: 'Platform ticket ID' })
  async reopen(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
  ) {
    const actor = await this.service.verifyTenantAdmin(authorization);
    return this.service.reopenForTenantAdmin(actor, id);
  }
}
