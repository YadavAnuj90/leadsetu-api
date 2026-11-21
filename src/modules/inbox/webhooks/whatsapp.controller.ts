import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
  Res,
  type RawBodyRequest,
} from '@nestjs/common';
import { ApiBody, ApiHeader, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { InboxService } from '../inbox.service';

@ApiTags('6. Unified WhatsApp & AI Inbox')
@Controller('webhooks/whatsapp')
export class WhatsAppWebhookController {
  constructor(private readonly inboxService: InboxService) {}

  @Get()
  @ApiOperation({
    summary: 'Meta WhatsApp Cloud API webhook verification challenge (GET)',
  })
  @ApiQuery({ name: 'hub.mode', required: true })
  @ApiQuery({ name: 'hub.verify_token', required: true })
  @ApiQuery({ name: 'hub.challenge', required: true })
  @ApiResponse({ status: 200, description: 'Returns raw hub.challenge string.' })
  async verifyChallenge(
    @Query('hub.mode') mode: string | undefined,
    @Query('hub.verify_token') verifyToken: string | undefined,
    @Query('hub.challenge') challenge: string | undefined,
    @Res() res: Response,
  ) {
    const echoed = await this.inboxService.verifyMetaWebhookChallenge(
      mode,
      verifyToken,
      challenge,
    );
    return res.status(HttpStatus.OK).type('text/plain').send(echoed);
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Meta WhatsApp Cloud API live webhook (X-Hub-Signature-256 + inbound messages & delivery statuses)',
    description: 'Verifies Meta HMAC signature and ingests incoming customer WhatsApp messages & delivery status callbacks.',
  })
  @ApiHeader({ name: 'x-hub-signature-256', required: true, description: 'Meta sha256=<hex> webhook signature header' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        object: { type: 'string', example: 'whatsapp_business_account' },
        entry: { type: 'array', items: { type: 'object' } },
      },
    },
  })
  @ApiResponse({ status: 200, description: 'Webhook processed cleanly.' })
  async receiveWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-hub-signature-256') signatureHeader: string | undefined,
    @Body() payload: Record<string, unknown>,
  ) {
    const rawBody =
      req.rawBody || Buffer.from(JSON.stringify(payload || {}), 'utf8');
    return this.inboxService.handleMetaWebhook(rawBody, signatureHeader, payload);
  }
}
