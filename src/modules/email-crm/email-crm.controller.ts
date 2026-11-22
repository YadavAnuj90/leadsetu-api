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
  Put,
  Query,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import {
  CreateEmailTemplateDto,
  SaveEmailAccountDto,
  SendEmailDto,
  UpdateEmailTemplateDto,
} from './dto/email-crm.dto';
import { EmailCrmService } from './email-crm.service';

// 1x1 transparent GIF pixel
const TRANSPARENT_GIF = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64',
);

@ApiTags('6B. 2-Way Email CRM & Templates')
@Controller('email-crm')
export class EmailCrmController {
  constructor(private readonly emailCrmService: EmailCrmService) {}

  @Get('config')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get Email CRM SMTP/IMAP connection, reusable templates & recent messages',
    description:
      'Returns the masked SMTP/IMAP account settings, seeded Indian B2B email templates, and recent tracked email threads.',
  })
  async getConfig(@Headers('authorization') authorization: string | undefined) {
    const auth = await this.emailCrmService.verifyAuth(authorization);
    return this.emailCrmService.getConfigAndSummary(auth);
  }

  @Put('account')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Connect or update Gmail, Zoho Mail, Outlook, or custom SMTP/IMAP mailbox',
    description:
      'Saves encrypted SMTP & IMAP credentials (using AES-256-GCM) for sending tracked emails and syncing buyer replies.',
  })
  @ApiBody({ type: SaveEmailAccountDto })
  async saveAccount(
    @Headers('authorization') authorization: string | undefined,
    @Body() dto: SaveEmailAccountDto,
  ) {
    const auth = await this.emailCrmService.verifyAuth(authorization);
    return this.emailCrmService.saveEmailAccount(auth, dto);
  }

  @Post('account/test')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Verify live SMTP & IMAP handshake with stored email account credentials',
    description: 'Tests outgoing SMTP authentication and incoming IMAP login for the connected mailbox.',
  })
  async testAccount(
    @Headers('authorization') authorization: string | undefined,
  ) {
    const auth = await this.emailCrmService.verifyAuth(authorization);
    return this.emailCrmService.testConnection(auth);
  }

  @Post('sync')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Sync inbound buyer email replies from IMAP INBOX & match to Leads/Contacts/Deals',
    description:
      'Fetches latest IMAP emails, deduplicates by RFC Message-ID, matches sender addresses against CRM records, and logs replies onto timelines.',
  })
  async syncInbound(
    @Headers('authorization') authorization: string | undefined,
  ) {
    const auth = await this.emailCrmService.verifyAuth(authorization);
    return this.emailCrmService.syncInboundEmails(auth);
  }

  @Get('templates')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'List reusable CRM email templates',
  })
  async listTemplates(
    @Headers('authorization') authorization: string | undefined,
  ) {
    const auth = await this.emailCrmService.verifyAuth(authorization);
    return this.emailCrmService.listTemplates(auth);
  }

  @Post('templates')
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Create a reusable sales or Udhaar email template',
  })
  @ApiBody({ type: CreateEmailTemplateDto })
  async createTemplate(
    @Headers('authorization') authorization: string | undefined,
    @Body() dto: CreateEmailTemplateDto,
  ) {
    const auth = await this.emailCrmService.verifyAuth(authorization);
    return this.emailCrmService.createTemplate(auth, dto);
  }

  @Patch('templates/:id')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Update a CRM email template',
  })
  @ApiParam({ name: 'id', description: 'Email template ID' })
  @ApiBody({ type: UpdateEmailTemplateDto })
  async updateTemplate(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
    @Body() dto: UpdateEmailTemplateDto,
  ) {
    const auth = await this.emailCrmService.verifyAuth(authorization);
    return this.emailCrmService.updateTemplate(auth, id, dto);
  }

  @Delete('templates/:id')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Delete a CRM email template',
  })
  @ApiParam({ name: 'id', description: 'Email template ID' })
  async deleteTemplate(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
  ) {
    const auth = await this.emailCrmService.verifyAuth(authorization);
    return this.emailCrmService.deleteTemplate(auth, id);
  }

  @Get('messages')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'List sent & received CRM emails filtered by Lead, Contact, or Deal',
  })
  @ApiQuery({ name: 'entityType', required: false, enum: ['lead', 'contact', 'deal'] })
  @ApiQuery({ name: 'entityId', required: false, description: 'CRM entity ID' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async listMessages(
    @Headers('authorization') authorization: string | undefined,
    @Query('entityType') entityType?: string,
    @Query('entityId') entityId?: string,
    @Query('limit') limit?: string,
  ) {
    const auth = await this.emailCrmService.verifyAuth(authorization);
    return this.emailCrmService.listMessages(auth, { entityType, entityId, limit });
  }

  @Post('send')
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Send a tracked email via SMTP & log automatically on Lead/Contact/Deal timeline',
    description:
      'Embeds a 1x1 open-tracking pixel, dispatches via the workspace/user SMTP server, and appends a timeline activity event on the linked CRM record.',
  })
  @ApiBody({ type: SendEmailDto })
  async sendEmail(
    @Headers('authorization') authorization: string | undefined,
    @Body() dto: SendEmailDto,
  ) {
    const auth = await this.emailCrmService.verifyAuth(authorization);
    return this.emailCrmService.sendEmail(auth, dto);
  }

  @Get('track/:trackingPixel')
  @ApiOperation({
    summary: 'Public open-tracking pixel endpoint returning 1x1 transparent GIF',
    description: 'Records email open count & timestamps when a recipient opens a tracked CRM email.',
  })
  @ApiParam({ name: 'trackingPixel', description: 'Tracking ID + .gif filename' })
  async trackOpen(
    @Param('trackingPixel') trackingPixel: string,
    @Res() res: Response,
  ) {
    await this.emailCrmService.recordEmailOpen(trackingPixel).catch(() => {});
    res.setHeader('Content-Type', 'image/gif');
    res.setHeader(
      'Cache-Control',
      'no-store, no-cache, must-revalidate, proxy-revalidate',
    );
    res.send(TRANSPARENT_GIF);
  }
}
