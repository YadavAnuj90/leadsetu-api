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
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CallsService } from './calls.service';
import { CallTelemetrySnapshotDto } from './dto/calls.dto';

@ApiTags('16. Native CRM Voice Calling')
@ApiBearerAuth('access-token')
@Controller('calls')
export class CallsController {
  constructor(private readonly callsService: CallsService) {}

  @Get('ice-servers')
  @ApiOperation({
    summary:
      'Get STUN & short-lived TURN ICE server configuration for WebRTC audio sessions',
  })
  @ApiResponse({ status: 200 })
  async getIceServers(@Headers('authorization') authorization?: string) {
    const auth = await this.callsService.verifyAuthHeader(authorization);
    return this.callsService.getIceServers(auth);
  }

  @Get('presence')
  @ApiOperation({
    summary:
      'List same-workspace active agents with live Online / Busy / Offline availability',
  })
  async getPresence(@Headers('authorization') authorization?: string) {
    const auth = await this.callsService.verifyAuthHeader(authorization);
    const snapshot = await this.callsService.getTenantPresenceSnapshot(
      auth.tenantId,
    );
    const scoped = this.callsService.filterPresenceForViewer(snapshot, auth);
    return {
      data: scoped.filter((item) => item.userId !== auth.userId),
      selfStatus:
        scoped.find((item) => item.userId === auth.userId)?.status ||
        'online',
    };
  }

  @Get('history')
  @ApiOperation({
    summary:
      'Get participant-scoped CRM call history (or workspace scope for Owners/Admins)',
  })
  @ApiQuery({
    name: 'filter',
    required: false,
    enum: ['all', 'outgoing', 'incoming', 'missed'],
  })
  @ApiQuery({ name: 'limit', required: false, example: 40 })
  @ApiQuery({ name: 'scope', required: false, enum: ['self', 'workspace'] })
  async getHistory(
    @Headers('authorization') authorization: string | undefined,
    @Query() query: { filter?: string; limit?: string; scope?: string },
  ) {
    const auth = await this.callsService.verifyAuthHeader(authorization);
    return this.callsService.getHistory(auth, query);
  }

  @Get('user-analytics')
  @ApiOperation({
    summary:
      'Get per-user Total, Answered, Missed & Talk Time call analytics (scoped to self for reps, full workspace for Owners/Admins/Managers)',
  })
  async getUserAnalytics(
    @Headers('authorization') authorization: string | undefined,
  ) {
    const auth = await this.callsService.verifyAuthHeader(authorization);
    return this.callsService.getUserAnalytics(auth);
  }

  @Get('analytics')
  @ApiOperation({
    summary:
      'Get call connection success rate, average setup time, TURN relay usage %, RTT & bandwidth telemetry',
  })
  @ApiQuery({ name: 'scope', required: false, enum: ['workspace', 'platform'] })
  async getAnalytics(
    @Headers('authorization') authorization: string | undefined,
    @Query('scope') scope?: string,
  ) {
    const auth = await this.callsService.verifyAuthHeader(authorization);
    return this.callsService.getAnalytics(auth, scope);
  }

  @Get(':id/telemetry')
  @ApiOperation({
    summary:
      'Get aggregated connection summary and ordered WebRTC telemetry snapshots for a call',
  })
  @ApiParam({ name: 'id', description: 'Call log record ID' })
  async getCallTelemetry(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
  ) {
    const auth = await this.callsService.verifyAuthHeader(authorization);
    return this.callsService.getCallTelemetry(auth, id);
  }

  @Post(':id/telemetry')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Record a periodic or final WebRTC candidate-pair telemetry snapshot for a call',
  })
  @ApiParam({ name: 'id', description: 'Call log record ID' })
  @ApiBody({ type: CallTelemetrySnapshotDto })
  async recordTelemetry(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
    @Body() dto: CallTelemetrySnapshotDto,
  ) {
    const auth = await this.callsService.verifyAuthHeader(authorization);
    return this.callsService.recordTelemetrySample(auth, id, dto);
  }
}
