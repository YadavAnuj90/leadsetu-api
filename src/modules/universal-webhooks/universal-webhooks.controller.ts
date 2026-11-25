import {
  All,
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
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { HttpsOnlyGuard } from './https-only.guard';
import type {
  UniversalDuplicateStrategy,
  UniversalWebhookAction,
  UniversalWebhookFieldMapping,
  UniversalWebhookMethod,
  UniversalWebhookStatus,
} from './schemas/universal-webhook.schema';
import { UniversalWebhooksService } from './universal-webhooks.service';

@ApiTags('Universal Webhooks Management')
@ApiBearerAuth()
@Controller('webhooks/universal')
export class UniversalWebhooksController {
  constructor(private readonly service: UniversalWebhooksService) {}

  @Get('actions')
  @ApiOperation({
    summary:
      'Return supported CRM actions (Create Lead, Create Contact, Create Deal) and their mappable CRM fields (phone required)',
  })
  async getActions(@Headers('authorization') authHeader?: string) {
    await this.service.verifyAuth(authHeader);
    return this.service.getSupportedActions();
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Create a new Universal Webhook endpoint, encrypt secret token (AES-256-GCM), start 10-min sample listener & return https:// URL',
  })
  async createWebhook(
    @Headers('authorization') authHeader: string | undefined,
    @Body()
    body: {
      name: string;
      allowedMethod?: UniversalWebhookMethod;
      targetAction?: UniversalWebhookAction;
      duplicateStrategy?: UniversalDuplicateStrategy;
      triggerWhatsappOnNew?: boolean;
      triggerWhatsappOnRepeat?: boolean;
      whatsappTemplateId?: string;
      defaultAssigneeId?: string;
      optionalHeaderSecret?: string;
      fieldMappings?: UniversalWebhookFieldMapping[];
    },
  ) {
    const auth = await this.service.verifyAuth(authHeader);
    return this.service.createWebhook(auth, body);
  }

  @Get()
  @ApiOperation({ summary: 'List all Universal Webhooks for the current tenant' })
  async listWebhooks(@Headers('authorization') authHeader?: string) {
    const auth = await this.service.verifyAuth(authHeader);
    return this.service.listWebhooks(auth);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Fetch single Universal Webhook configuration' })
  @ApiParam({ name: 'id' })
  async getWebhook(
    @Headers('authorization') authHeader: string | undefined,
    @Param('id') id: string,
  ) {
    const auth = await this.service.verifyAuth(authHeader);
    return this.service.getWebhookById(auth, id);
  }

  @Patch(':id')
  @ApiOperation({
    summary:
      'Update fieldMappings, status (active/paused), duplicateStrategy, or WhatsApp auto-reply settings',
  })
  @ApiParam({ name: 'id' })
  async updateWebhook(
    @Headers('authorization') authHeader: string | undefined,
    @Param('id') id: string,
    @Body()
    body: Partial<{
      name: string;
      allowedMethod: UniversalWebhookMethod;
      targetAction: UniversalWebhookAction;
      status: UniversalWebhookStatus;
      duplicateStrategy: UniversalDuplicateStrategy;
      triggerWhatsappOnNew: boolean;
      triggerWhatsappOnRepeat: boolean;
      whatsappTemplateId: string;
      defaultAssigneeId: string;
      optionalHeaderSecret: string;
      fieldMappings: UniversalWebhookFieldMapping[];
    }>,
  ) {
    const auth = await this.service.verifyAuth(authHeader);
    return this.service.updateWebhook(auth, id, body);
  }

  @Post(':id/listen')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Re-enable 10-minute sample capture mode (status = listening)',
  })
  @ApiParam({ name: 'id' })
  async startListening(
    @Headers('authorization') authHeader: string | undefined,
    @Param('id') id: string,
  ) {
    const auth = await this.service.verifyAuth(authHeader);
    return this.service.startSampleListening(auth, id);
  }

  @Get(':id/sample')
  @ApiOperation({
    summary:
      'Retrieve latest captured sample payload with flattened dot-notation keys and auto-suggested CRM field mappings',
  })
  @ApiParam({ name: 'id' })
  async getSample(
    @Headers('authorization') authHeader: string | undefined,
    @Param('id') id: string,
  ) {
    const auth = await this.service.verifyAuth(authHeader);
    return this.service.getCapturedSample(auth, id);
  }

  @Post(':id/rotate-secret')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Generate a new secret token and return the updated https:// URL',
  })
  @ApiParam({ name: 'id' })
  async rotateSecret(
    @Headers('authorization') authHeader: string | undefined,
    @Param('id') id: string,
  ) {
    const auth = await this.service.verifyAuth(authHeader);
    return this.service.rotateSecret(auth, id);
  }

  @Get(':id/logs')
  @ApiOperation({
    summary: 'List recent 50 execution logs for a Universal Webhook',
  })
  @ApiParam({ name: 'id' })
  async listLogs(
    @Headers('authorization') authHeader: string | undefined,
    @Param('id') id: string,
  ) {
    const auth = await this.service.verifyAuth(authHeader);
    return this.service.listDeliveryLogs(auth, id);
  }

  @Post(':id/logs/:logId/replay')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Re-enqueue and replay a failed webhook payload through the upsert worker',
  })
  @ApiParam({ name: 'id' })
  @ApiParam({ name: 'logId' })
  async replayLog(
    @Headers('authorization') authHeader: string | undefined,
    @Param('id') id: string,
    @Param('logId') logId: string,
  ) {
    const auth = await this.service.verifyAuth(authHeader);
    return this.service.replayDeliveryLog(auth, id, logId);
  }
}

@ApiTags('HTTPS-Only Public Universal Webhook Receiver')
@UseGuards(HttpsOnlyGuard)
@Controller('webhooks/in')
export class UniversalWebhookInboundController {
  constructor(private readonly service: UniversalWebhooksService) {}

  @All(':webhookId/:secretToken')
  @ApiOperation({
    summary:
      'Public HTTPS-Only GET/POST Universal Webhook Receiver (enforces method match 405, rate limit 60/min, sample capture mode & async upsert)',
  })
  async receiveWebhook(
    @Param('webhookId') webhookId: string,
    @Param('secretToken') secretToken: string,
    @Req() req: Request,
    @Res() res: Response,
    @Query() query: Record<string, unknown>,
    @Body() body: Record<string, unknown>,
    @Headers('x-webhook-secret') headerSecret?: string,
  ) {
    const method = String(req.method || 'POST').toUpperCase();
    const payload =
      method === 'GET' ? query || {} : { ...(query || {}), ...(body || {}) };

    const out = await this.service.handleIncomingWebhook({
      webhookId,
      secretToken,
      method,
      headerSecret,
      payload,
    });

    return res.status(out.statusCode).json(out.body);
  }
}
