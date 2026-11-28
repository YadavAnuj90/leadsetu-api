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
  Req,
  Res,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { MarketplaceSyncService } from './marketplace-sync.service';
import { BookingSchedulerService } from './booking-scheduler.service';
import {
  CreatePublicBookingDto,
  IngestMarketplaceBatchDto,
  SimulateConnectorWebhookDto,
  SyncIndiaMartNowDto,
  UpdateBookingStatusDto,
  UpdateIndiaMartConfigDto,
  UpdateLeadConnectorsDto,
} from './dto/marketplace-sync.dto';

@ApiTags('IndiaMART Pull & Marketplace Speed-to-Lead')
@Controller('marketplace-sync')
export class MarketplaceSyncController {
  constructor(
    private readonly syncService: MarketplaceSyncService,
    private readonly bookingService: BookingSchedulerService,
  ) {}

  @Get()
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Get IndiaMART Pull API v2 config, <10s Speed-to-Lead SLA metrics, breached leads & sync logs',
  })
  getOverview(@Headers('authorization') authHeader?: string) {
    return this.syncService.getOverview(authHeader);
  }

  @Patch('config')
  @ApiOperation({
    summary:
      'Configure encrypted IndiaMART glusr_crm_key API v2, polling interval & <10s WhatsApp template (Owner/Admin)',
  })
  updateConfig(
    @Headers('authorization') authHeader: string | undefined,
    @Body() body: UpdateIndiaMartConfigDto,
  ) {
    return this.syncService.updateConfig(authHeader, body);
  }

  @Post('pull')
  @ApiOperation({
    summary:
      'Run 1-click IndiaMART CRM Pull API v2 sync (or sandbox inquiry batch) with routing & <10s Auto-WhatsApp',
  })
  syncNow(
    @Headers('authorization') authHeader: string | undefined,
    @Body() body: SyncIndiaMartNowDto,
  ) {
    return this.syncService.syncIndiaMartNow(authHeader, body);
  }

  @Post('ingest-batch')
  @ApiOperation({
    summary:
      'Ingest normalized Justdial / TradeIndia / IndiaMART inquiry batch with deduplication, routing & <10s WhatsApp',
  })
  ingestBatch(
    @Headers('authorization') authHeader: string | undefined,
    @Body() body: IngestMarketplaceBatchDto,
  ) {
    return this.syncService.ingestBatch(authHeader, body);
  }

  @Post('nudge/:leadId')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      '1-click SLA breach rescue: dispatch immediate WhatsApp welcome to an unattended lead',
  })
  rescueSlaLead(
    @Headers('authorization') authHeader: string | undefined,
    @Param('leadId') leadId: string,
  ) {
    return this.syncService.rescueSlaLead(authHeader, leadId);
  }

  @Post('justdial/review-nudge/:leadId')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Send Justdial rating & review booster message via WhatsApp to a converted buyer',
  })
  sendJustdialReviewNudge(
    @Headers('authorization') authHeader: string | undefined,
    @Param('leadId') leadId: string,
  ) {
    return this.syncService.sendJustdialReviewNudge(authHeader, leadId);
  }

  @Get('connectors')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Get Meta Lead Ads, Justdial, TradeIndia & Embeddable Booking Scheduler configs + recent bookings',
  })
  getConnectors(@Headers('authorization') authHeader?: string) {
    return this.syncService.getConnectorsOverview(authHeader);
  }

  @Patch('connectors')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Update Meta Lead Ads, Justdial, TradeIndia & Embeddable Booking Scheduler configs (Owner/Admin)',
  })
  updateConnectors(
    @Headers('authorization') authHeader: string | undefined,
    @Body() body: UpdateLeadConnectorsDto,
  ) {
    return this.syncService.updateConnectors(authHeader, body);
  }

  @Post('connectors/simulate')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Fire a test Meta Lead Ads, Justdial, or TradeIndia webhook inquiry through routing + <10s Auto-WhatsApp',
  })
  simulateConnector(
    @Headers('authorization') authHeader: string | undefined,
    @Body() body: SimulateConnectorWebhookDto,
  ) {
    return this.syncService.simulateConnectorWebhook(authHeader, body);
  }

  @Patch('bookings/:id/status')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Update booking appointment status (confirmed/completed/no_show/cancelled) with optional No-Show WhatsApp nudge',
  })
  async updateBookingStatus(
    @Headers('authorization') authHeader: string | undefined,
    @Param('id') id: string,
    @Body() body: UpdateBookingStatusDto,
  ) {
    const auth = await this.syncService.verifyAuth(authHeader);
    return this.bookingService.updateBookingStatus(
      auth.tenantId,
      auth.userId,
      id,
      body.status,
      body.sendRecoveryWhatsApp !== false,
    );
  }

  // ---- PUBLIC WEBHOOK RECEIVERS (whitelisted via /webhooks/ in TenantSecurityGuard) ----

  @Get('webhooks/meta-lead-ads/:webhookKey')
  @ApiOperation({
    summary: 'Meta Lead Ads Webhook Challenge Verification (hub.mode / hub.verify_token)',
  })
  async verifyMetaLeadAds(
    @Param('webhookKey') webhookKey: string,
    @Query('hub.mode') mode: string | undefined,
    @Query('hub.verify_token') verifyToken: string | undefined,
    @Query('hub.challenge') challenge: string | undefined,
    @Res() res: Response,
  ) {
    const out = await this.syncService.verifyMetaLeadAdsChallenge(
      webhookKey,
      mode,
      verifyToken,
      challenge,
    );
    return res.status(HttpStatus.OK).type('text/plain').send(out);
  }

  @Post('webhooks/meta-lead-ads/:webhookKey')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Public Meta Lead Ads Instant Form webhook receiver (verifies X-Hub-Signature-256 + Graph API hydration)',
  })
  receiveMetaLeadAds(
    @Param('webhookKey') webhookKey: string,
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-hub-signature-256') signatureHeader: string | undefined,
    @Body() payload: Record<string, unknown>,
  ) {
    return this.syncService.handleMetaLeadAdsWebhook(
      webhookKey,
      req.rawBody,
      signatureHeader,
      payload || {},
    );
  }

  @Get('webhooks/justdial/:webhookKey')
  @ApiOperation({
    summary: 'Public Justdial GET query-string lead push receiver',
  })
  receiveJustdialGet(
    @Param('webhookKey') webhookKey: string,
    @Query() query: Record<string, unknown>,
  ) {
    return this.syncService.handleJustdialWebhook(webhookKey, query || {});
  }

  @Post('webhooks/justdial/:webhookKey')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Public Justdial JSON/form lead push receiver',
  })
  receiveJustdialPost(
    @Param('webhookKey') webhookKey: string,
    @Body() body: Record<string, unknown>,
    @Query() query: Record<string, unknown>,
  ) {
    return this.syncService.handleJustdialWebhook(webhookKey, {
      ...(query || {}),
      ...(body || {}),
    });
  }

  @Get('webhooks/tradeindia/:webhookKey')
  @ApiOperation({
    summary: 'Public TradeIndia GET query-string RFI lead push receiver',
  })
  receiveTradeIndiaGet(
    @Param('webhookKey') webhookKey: string,
    @Query() query: Record<string, unknown>,
  ) {
    return this.syncService.handleTradeIndiaWebhook(webhookKey, query || {});
  }

  @Post('webhooks/tradeindia/:webhookKey')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Public TradeIndia JSON/form RFI lead push receiver',
  })
  receiveTradeIndiaPost(
    @Param('webhookKey') webhookKey: string,
    @Body() body: Record<string, unknown>,
    @Query() query: Record<string, unknown>,
  ) {
    return this.syncService.handleTradeIndiaWebhook(webhookKey, {
      ...(query || {}),
      ...(body || {}),
    });
  }
}

@ApiTags('Public Embeddable Booking Scheduler')
@Controller('public/booking')
export class BookingPublicController {
  constructor(private readonly bookingService: BookingSchedulerService) {}

  @Get(':slug')
  @ApiOperation({
    summary: 'Get public scheduler config, branding & real-time free slots for a date (YYYY-MM-DD)',
  })
  getScheduler(
    @Param('slug') slug: string,
    @Query('date') date?: string,
  ) {
    return this.bookingService.getPublicSchedulerInfo(slug, date);
  }

  @Post(':slug')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Create appointment booking, auto-route Lead + Task, prevent double-booking & send instant WhatsApp confirmation',
  })
  createBooking(
    @Param('slug') slug: string,
    @Body() dto: CreatePublicBookingDto,
  ) {
    return this.bookingService.createPublicBooking(slug, dto);
  }
}
