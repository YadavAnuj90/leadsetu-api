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
  Req,
  Res,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { MetaLeadsService } from './meta-leads.service';
import type { MetaFieldMappingItem } from './schemas/meta-page-connection.schema';

@ApiTags('Meta (Facebook & Instagram) Lead Ads')
@ApiBearerAuth()
@Controller('integrations/meta')
export class MetaLeadsController {
  constructor(private readonly metaLeadsService: MetaLeadsService) {}

  @Get('oauth-url')
  @ApiOperation({
    summary:
      'Generate signed state & Facebook Login for Business OAuth URL (leads_retrieval, pages_manage_metadata, pages_show_list, pages_read_engagement, ads_management)',
  })
  @ApiQuery({ name: 'redirectUri', required: false })
  async getOAuthUrl(
    @Headers('authorization') authHeader: string | undefined,
    @Query('redirectUri') redirectUri?: string,
  ) {
    const auth = await this.metaLeadsService.verifyAuth(authHeader);
    return this.metaLeadsService.getOAuthUrl(auth, redirectUri);
  }

  @Post('oauth/exchange')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Exchange Meta OAuth code for short-lived -> long-lived token, fetch /me/accounts Pages, encrypt Page Access Tokens (AES-256-GCM) & upsert MetaPageConnection',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['code', 'state'],
      properties: {
        code: { type: 'string' },
        state: { type: 'string' },
        redirectUri: { type: 'string' },
      },
    },
  })
  async exchangeOAuthCode(
    @Headers('authorization') authHeader: string | undefined,
    @Body() body: { code: string; state: string; redirectUri?: string },
  ) {
    const auth = await this.metaLeadsService.verifyAuth(authHeader);
    return this.metaLeadsService.exchangeOAuthCode(auth, body);
  }

  @Post('pages/:pageId/subscribe')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Subscribe Facebook Page to leadgen webhooks, fetch active Lead Forms & auto-map standard fields',
  })
  @ApiParam({ name: 'pageId' })
  async subscribePage(
    @Headers('authorization') authHeader: string | undefined,
    @Param('pageId') pageId: string,
  ) {
    const auth = await this.metaLeadsService.verifyAuth(authHeader);
    return this.metaLeadsService.subscribePage(auth, pageId);
  }

  @Delete('pages/:pageId/unsubscribe')
  @ApiOperation({
    summary: 'Unsubscribe Facebook Page from leadgen webhooks',
  })
  @ApiParam({ name: 'pageId' })
  async unsubscribePage(
    @Headers('authorization') authHeader: string | undefined,
    @Param('pageId') pageId: string,
  ) {
    const auth = await this.metaLeadsService.verifyAuth(authHeader);
    return this.metaLeadsService.unsubscribePage(auth, pageId);
  }

  @Patch('pages/:pageId/forms/:formId')
  @ApiOperation({
    summary:
      'Save custom fieldMappings, autoReplyEnabled, whatsappTemplateId & defaultAssigneeId for a Lead Form',
  })
  @ApiParam({ name: 'pageId' })
  @ApiParam({ name: 'formId' })
  async updateFormConfig(
    @Headers('authorization') authHeader: string | undefined,
    @Param('pageId') pageId: string,
    @Param('formId') formId: string,
    @Body()
    body: {
      autoReplyEnabled?: boolean;
      whatsappTemplateId?: string;
      defaultAssigneeId?: string;
      fieldMappings?: MetaFieldMappingItem[];
    },
  ) {
    const auth = await this.metaLeadsService.verifyAuth(authHeader);
    return this.metaLeadsService.updateFormConfig(auth, pageId, formId, body);
  }

  @Get('connections')
  @ApiOperation({
    summary:
      'Return connected Facebook Pages and Lead Forms for the current tenant (never exposes encryptedPageAccessToken)',
  })
  async getConnections(
    @Headers('authorization') authHeader: string | undefined,
  ) {
    const auth = await this.metaLeadsService.verifyAuth(authHeader);
    return this.metaLeadsService.getConnections(auth);
  }

  @Post('simulate-lead')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Simulate a Meta Lead Ad test submission on a connected Page/Form through the MetaLeadsProcessor worker',
  })
  async simulateTestLead(
    @Headers('authorization') authHeader: string | undefined,
    @Body() body?: { pageId?: string; formId?: string },
  ) {
    const auth = await this.metaLeadsService.verifyAuth(authHeader);
    return this.metaLeadsService.simulateTestLead(auth, body);
  }

  @Post('backfill')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Safety-net backfill: pull recent leads from Meta Graph API for connected forms to recover missed webhooks',
  })
  async backfillMissedLeads(
    @Headers('authorization') authHeader: string | undefined,
    @Body() body?: { pageId?: string; formId?: string; limit?: number },
  ) {
    const auth = await this.metaLeadsService.verifyAuth(authHeader);
    return this.metaLeadsService.backfillMissedLeads(auth, body);
  }
}

@ApiTags('Meta Lead Ads Public Webhook')
@Controller('webhooks/meta/leads')
export class MetaLeadsWebhookController {
  constructor(private readonly metaLeadsService: MetaLeadsService) {}

  @Get()
  @ApiOperation({
    summary:
      'Verify hub.mode === subscribe and hub.verify_token === META_VERIFY_TOKEN, returning 200 + hub.challenge as plain text',
  })
  verifyChallenge(
    @Query('hub.mode') mode: string | undefined,
    @Query('hub.verify_token') verifyToken: string | undefined,
    @Query('hub.challenge') challenge: string | undefined,
    @Res() res: Response,
  ) {
    const out = this.metaLeadsService.verifyWebhookChallenge(
      mode,
      verifyToken,
      challenge,
    );
    return res.status(HttpStatus.OK).type('text/plain').send(out);
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Verify X-Hub-Signature-256 against raw body (401 on invalid), immediately return 200 OK & enqueue leadgen events onto meta-leads-ingestion queue',
  })
  receiveWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-hub-signature-256') signatureHeader: string | undefined,
    @Body() payload: Record<string, unknown>,
  ) {
    return this.metaLeadsService.handleWebhookPayload(
      req.rawBody,
      signatureHeader,
      payload || {},
    );
  }
}
