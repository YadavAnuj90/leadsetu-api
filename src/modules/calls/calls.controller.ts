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
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
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
import {
  CallTelemetrySnapshotDto,
  CreateCallShareLinkDto,
  LogSimCallDto,
  PublicCallCallbackDto,
  SaveCallDispositionDto,
  UploadCallRecordingDto,
} from './dto/calls.dto';

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
    enum: ['all', 'outgoing', 'incoming', 'missed', 'callbacks'],
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

  @Get('crm-entities')
  @ApiOperation({
    summary:
      'Search linkable Leads, Deals, and Tickets for call disposition or Click-to-Call links',
  })
  @ApiQuery({ name: 'q', required: false })
  async getCrmEntities(
    @Headers('authorization') authorization: string | undefined,
    @Query('q') q?: string,
  ) {
    const auth = await this.callsService.verifyAuthHeader(authorization);
    return this.callsService.listLinkableCrmEntities(auth, q);
  }

  @Post('share-link')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Generate a signed Customer Click-to-Call share link optionally linked to a Lead, Deal, or Ticket',
  })
  @ApiBody({ type: CreateCallShareLinkDto })
  async createShareLink(
    @Headers('authorization') authorization: string | undefined,
    @Body() dto: CreateCallShareLinkDto,
  ) {
    const auth = await this.callsService.verifyAuthHeader(authorization);
    return this.callsService.createShareLink(auth, dto);
  }

  @Post('sim-log')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Log an outbound Mobile SIM (tel:) call with disposition, CRM timeline activity, and optional follow-up task',
  })
  @ApiBody({ type: LogSimCallDto })
  async logSimCall(
    @Headers('authorization') authorization: string | undefined,
    @Body() dto: LogSimCallDto,
  ) {
    const auth = await this.callsService.verifyAuthHeader(authorization);
    return this.callsService.logSimCall(auth, dto);
  }

  @Get('public/link/:token')
  @ApiOperation({
    summary:
      'Public endpoint: verify Customer Click-to-Call token and inspect assigned agent availability',
  })
  async getPublicCallLink(@Param('token') token: string) {
    return this.callsService.getPublicCallLinkInfo(token);
  }

  @Post('public/link/:token/callback')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Public endpoint: log a customer callback request & high-priority task when agent is offline/busy',
  })
  @ApiBody({ type: PublicCallCallbackDto })
  async submitPublicCallback(
    @Param('token') token: string,
    @Body() dto: PublicCallCallbackDto,
  ) {
    return this.callsService.submitPublicCallbackRequest(token, dto);
  }

  @Get(':id/telemetry')
  @ApiOperation({
    summary:
      'Get aggregated connection summary and ordered WebRTC telemetry snapshots for a call (Super Admin requires ?supportReason=)',
  })
  @ApiParam({ name: 'id', description: 'Call log record ID' })
  @ApiQuery({ name: 'supportReason', required: false })
  async getCallTelemetry(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
    @Query('supportReason') supportReason?: string,
    @Req() req?: Request,
  ) {
    const auth = await this.callsService.verifyAuthHeader(authorization);
    return this.callsService.getCallTelemetry(auth, id, supportReason, {
      ip: req?.ip || '',
      userAgent: String(req?.headers?.['user-agent'] || ''),
      requestId: String(req?.headers?.['x-request-id'] || ''),
    });
  }

  @Post(':id/support-access')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Audited Super Admin Support Access: reveal participant identities & telemetry samples for a call given a mandatory ticket/reason (writes immutable audit log)',
  })
  @ApiParam({ name: 'id', description: 'Call log record ID' })
  async requestSupportReveal(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
    @Body() body: { reason?: string },
    @Req() req?: Request,
  ) {
    const auth = await this.callsService.verifyAuthHeader(authorization);
    return this.callsService.requestCallSupportReveal(
      auth,
      id,
      body?.reason || '',
      {
        ip: req?.ip || '',
        userAgent: String(req?.headers?.['user-agent'] || ''),
        requestId: String(req?.headers?.['x-request-id'] || ''),
      },
    );
  }

  @Post(':id/disposition')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Save call notes, outcome tag, CRM record link + timeline activity, and optional follow-up task',
  })
  @ApiParam({ name: 'id', description: 'Call log record ID' })
  @ApiBody({ type: SaveCallDispositionDto })
  async saveDisposition(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
    @Body() dto: SaveCallDispositionDto,
  ) {
    const auth = await this.callsService.verifyAuthHeader(authorization);
    return this.callsService.saveCallDisposition(auth, id, dto);
  }

  @Post(':id/resolve-callback')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Mark a missed call or customer callback request as Called Back / Resolved (or reopen it)',
  })
  @ApiParam({ name: 'id', description: 'Call log record ID' })
  async resolveCallback(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
    @Body() body: { resolved?: boolean },
  ) {
    const auth = await this.callsService.verifyAuthHeader(authorization);
    return this.callsService.toggleCallbackResolved(auth, id, body?.resolved);
  }

  @Post(':id/recording')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Upload or attach a Web Audio / MediaRecorder call recording (Cloudinary + history playback)',
  })
  @ApiParam({ name: 'id', description: 'Call log record ID' })
  @ApiBody({ type: UploadCallRecordingDto })
  async uploadRecording(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
    @Body() dto: UploadCallRecordingDto,
  ) {
    const auth = await this.callsService.verifyAuthHeader(authorization);
    return this.callsService.saveCallRecording(auth, id, dto);
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
