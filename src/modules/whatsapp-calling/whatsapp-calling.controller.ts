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
import { InboxService } from '../inbox/inbox.service';
import {
  AcceptInboundWhatsappCallDto,
  EnableWhatsappCallingSettingsDto,
  RequestWhatsappCallPermissionDto,
  StartOutboundWhatsappCallDto,
  TerminateWhatsappCallDto,
  TopupCallingWalletDto,
  UploadWhatsappCallRecordingDto,
} from './dto/whatsapp-calling.dto';
import { WhatsappCallingService } from './whatsapp-calling.service';

@ApiTags('16B. WhatsApp Business Calling API (WebRTC)')
@ApiBearerAuth('access-token')
@Controller('whatsapp/calling')
export class WhatsappCallingController {
  constructor(
    private readonly callingService: WhatsappCallingService,
    private readonly inboxService: InboxService,
  ) {}

  @Get('settings')
  @ApiOperation({
    summary:
      'Get tenant WABA Calling configuration, 6-second pulse INR rate card, IST window status, and WebRTC ICE servers',
  })
  @ApiResponse({ status: 200 })
  async getSettings(@Headers('authorization') authorization?: string) {
    const auth = await this.inboxService.verifyAuth(authorization);
    return this.callingService.getCallingSettings(auth);
  }

  @Get('wallet')
  @ApiOperation({
    summary:
      'Get prepaid INR WhatsApp Calling wallet balance, starter trial credit state, and recent 6-second pulse ledger transactions',
  })
  @ApiResponse({ status: 200 })
  async getWallet(@Headers('authorization') authorization?: string) {
    const auth = await this.inboxService.verifyAuth(authorization);
    return this.callingService.getWalletSummary(auth);
  }

  @Post('wallet/topup')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Admin/Owner instant manual INR credit top-up to workspace WhatsApp Calling wallet',
  })
  @ApiBody({ type: TopupCallingWalletDto })
  @ApiResponse({ status: 200 })
  async topupWallet(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: TopupCallingWalletDto,
  ) {
    const auth = await this.inboxService.verifyAuth(authorization);
    return this.callingService.adminTopupWallet(auth, body);
  }

  @Post('settings')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Enable WhatsApp Business Calling on tenant WABA phone number via Meta Graph API (POST /{phoneNumberId}/settings)',
  })
  @ApiBody({ type: EnableWhatsappCallingSettingsDto })
  @ApiResponse({ status: 200 })
  async enableSettings(
    @Headers('authorization') authorization?: string,
    @Body() body?: EnableWhatsappCallingSettingsDto,
  ) {
    const auth = await this.inboxService.verifyAuth(authorization);
    return this.callingService.enableCallingSettings(auth, body || {});
  }

  @Get('permissions/:leadId')
  @ApiOperation({
    summary:
      'Get WhatsApp Callback Permission status, 7-day countdown, request quota, and 09:00-21:00 IST calling window for a lead',
  })
  @ApiParam({ name: 'leadId', description: 'Target CRM Lead ID' })
  @ApiResponse({ status: 200 })
  async getPermission(
    @Headers('authorization') authorization: string | undefined,
    @Param('leadId') leadId: string,
  ) {
    const auth = await this.inboxService.verifyAuth(authorization);
    return this.callingService.getLeadCallPermission(auth, leadId);
  }

  @Post('permissions/:leadId/request')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Send Meta interactive call_permission_request message to a lead (enforces 09:00-21:00 IST & 1/24h, 2/7d Meta caps)',
  })
  @ApiParam({ name: 'leadId', description: 'Target CRM Lead ID' })
  @ApiBody({ type: RequestWhatsappCallPermissionDto })
  @ApiResponse({ status: 200 })
  async requestPermission(
    @Headers('authorization') authorization: string | undefined,
    @Param('leadId') leadId: string,
    @Body() body?: RequestWhatsappCallPermissionDto,
  ) {
    const auth = await this.inboxService.verifyAuth(authorization);
    return this.callingService.requestLeadCallPermission(
      auth,
      leadId,
      body || {},
    );
  }

  @Post('outbound')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Initiate an outbound WhatsApp WebRTC call by leadId and SDP offer (resolves phone server-side to preserve phone masking)',
  })
  @ApiBody({ type: StartOutboundWhatsappCallDto })
  @ApiResponse({ status: 200 })
  async startOutboundCall(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: StartOutboundWhatsappCallDto,
  ) {
    const auth = await this.inboxService.verifyAuth(authorization);
    return this.callingService.startOutboundCall(auth, body);
  }

  @Post(':callId/accept')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Accept an inbound WhatsApp WebRTC call with SDP answer (sends pre_accept + accept and refreshes 7-day callback permission)',
  })
  @ApiParam({ name: 'callId', description: 'WhatsappCallLog ID or Meta Call ID' })
  @ApiBody({ type: AcceptInboundWhatsappCallDto })
  @ApiResponse({ status: 200 })
  async acceptInboundCall(
    @Headers('authorization') authorization: string | undefined,
    @Param('callId') callId: string,
    @Body() body: AcceptInboundWhatsappCallDto,
  ) {
    const auth = await this.inboxService.verifyAuth(authorization);
    return this.callingService.acceptInboundCall(auth, callId, body);
  }

  @Post(':callId/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reject an incoming WhatsApp WebRTC call via Meta Graph API',
  })
  @ApiParam({ name: 'callId', description: 'WhatsappCallLog ID or Meta Call ID' })
  @ApiBody({ type: TerminateWhatsappCallDto, required: false })
  @ApiResponse({ status: 200 })
  async rejectCall(
    @Headers('authorization') authorization: string | undefined,
    @Param('callId') callId: string,
    @Body() body?: TerminateWhatsappCallDto,
  ) {
    const auth = await this.inboxService.verifyAuth(authorization);
    return this.callingService.rejectCall(auth, callId, body);
  }

  @Post(':callId/terminate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Terminate an active WhatsApp WebRTC call, finalize duration, and compute 6-second pulse INR billing',
  })
  @ApiParam({ name: 'callId', description: 'WhatsappCallLog ID or Meta Call ID' })
  @ApiBody({ type: TerminateWhatsappCallDto, required: false })
  @ApiResponse({ status: 200 })
  async terminateCall(
    @Headers('authorization') authorization: string | undefined,
    @Param('callId') callId: string,
    @Body() body?: TerminateWhatsappCallDto,
  ) {
    const auth = await this.inboxService.verifyAuth(authorization);
    return this.callingService.terminateCall(auth, callId, body);
  }

  @Post(':callId/recording')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Upload captured WebRTC mixed call audio blob to Cloudinary, attach recordingUrl, and enqueue post-call AI summary job',
  })
  @ApiParam({ name: 'callId', description: 'WhatsappCallLog ID or Meta Call ID' })
  @ApiBody({ type: UploadWhatsappCallRecordingDto })
  @ApiResponse({ status: 200 })
  async uploadRecording(
    @Headers('authorization') authorization: string | undefined,
    @Param('callId') callId: string,
    @Body() body: UploadWhatsappCallRecordingDto,
  ) {
    const auth = await this.inboxService.verifyAuth(authorization);
    return this.callingService.uploadCallRecording(auth, callId, body);
  }

  @Post(':callId/ai-postprocess')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Run or re-run Whisper Hinglish STT transcription, 3-bullet summary, and BANT extraction for a WhatsApp call log',
  })
  @ApiParam({ name: 'callId', description: 'WhatsappCallLog ID or Meta Call ID' })
  @ApiResponse({ status: 200 })
  async triggerPostprocess(
    @Headers('authorization') authorization: string | undefined,
    @Param('callId') callId: string,
    @Body() body?: { transcript?: string },
  ) {
    const auth = await this.inboxService.verifyAuth(authorization);
    return this.callingService.triggerPostCallAi(auth, callId, body);
  }

  @Get('logs')
  @ApiOperation({
    summary:
      'List recent WhatsApp Business call logs for the workspace (with role-based phone masking)',
  })
  @ApiQuery({ name: 'leadId', required: false })
  @ApiQuery({ name: 'conversationId', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiResponse({ status: 200 })
  async listLogs(
    @Headers('authorization') authorization: string | undefined,
    @Query('leadId') leadId?: string,
    @Query('conversationId') conversationId?: string,
    @Query('limit') limit?: string,
  ) {
    const auth = await this.inboxService.verifyAuth(authorization);
    return this.callingService.listCallLogs(auth, {
      leadId,
      conversationId,
      limit: limit ? Number(limit) : undefined,
    });
  }
}
