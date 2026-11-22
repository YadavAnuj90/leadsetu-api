import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import {
  ManagePortalLinkDto,
  PortalCreateTicketDto,
  PortalPaymentIntentDto,
  PortalQuoteRespondDto,
  PortalTicketReplyDto,
} from './dto/portal.dto';
import { PortalService } from './portal.service';

@ApiTags('7B. B2B Buyer Magic Portal')
@Controller('portal')
export class PortalController {
  constructor(private readonly portalService: PortalService) {}

  @Post('contacts/:contactId/link')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Generate, fetch, or toggle a passwordless B2B Buyer / Dealer Magic Portal link',
    description:
      'Returns a unique `portalToken` (`/portal/:token`) giving this B2B buyer secure access to view quotes, approve offers, inspect Udhaar balance & GST invoices, trigger UPI payments, and raise support tickets.',
  })
  @ApiParam({ name: 'contactId', description: 'B2B Contact / Dealer ID' })
  @ApiBody({ type: ManagePortalLinkDto, required: false })
  async getOrManageContactLink(
    @Headers('authorization') authorization: string | undefined,
    @Param('contactId') contactId: string,
    @Body() dto?: ManagePortalLinkDto,
  ) {
    const auth = await this.portalService.verifyAuth(authorization);
    return this.portalService.getOrManageContactPortalLink(auth, contactId, dto || {});
  }

  @Get('public/:token')
  @ApiOperation({
    summary: 'Public B2B Buyer Self-Service Magic Portal (no login required)',
    description:
      'Resolves either a Contact portal token (`lsp_...`) or a Quotation/Invoice share token (`lsq_...`) to display branded seller details, quotations, open & paid GST invoices, live Udhaar/credit limit balance, and support tickets.',
  })
  @ApiParam({ name: 'token', description: 'Buyer portal token or document share token' })
  async getPublicPortal(@Param('token') token: string) {
    return this.portalService.getPublicPortalData(token);
  }

  @Post('public/:token/quotes/:quoteId/respond')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Approve a Proforma Quotation or request revisions from the Buyer Magic Portal',
    description:
      'Automatically updates quote status, advances linked CRM Deal stage & confidence, and logs timeline events across Lead/Contact/Deal.',
  })
  @ApiParam({ name: 'token', description: 'Buyer portal token' })
  @ApiParam({ name: 'quoteId', description: 'Quotation document ID' })
  @ApiBody({ type: PortalQuoteRespondDto })
  async respondToQuote(
    @Param('token') token: string,
    @Param('quoteId') quoteId: string,
    @Body() dto: PortalQuoteRespondDto,
  ) {
    return this.portalService.respondToQuoteInPortal(token, quoteId, dto);
  }

  @Post('public/:token/invoices/:invoiceId/payment-intent')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Generate UPI QR / deep-link or submit UTR / payment commitment for a GST Invoice',
  })
  @ApiParam({ name: 'token', description: 'Buyer portal token' })
  @ApiParam({ name: 'invoiceId', description: 'GST Tax Invoice ID' })
  @ApiBody({ type: PortalPaymentIntentDto })
  async submitPaymentIntent(
    @Param('token') token: string,
    @Param('invoiceId') invoiceId: string,
    @Body() dto: PortalPaymentIntentDto,
  ) {
    return this.portalService.submitPaymentIntentInPortal(token, invoiceId, dto);
  }

  @Post('public/:token/tickets')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Raise a Delivery / Warranty / GST Correction SLA Ticket from Buyer Portal',
  })
  @ApiParam({ name: 'token', description: 'Buyer portal token' })
  @ApiBody({ type: PortalCreateTicketDto })
  async createTicket(
    @Param('token') token: string,
    @Body() dto: PortalCreateTicketDto,
  ) {
    return this.portalService.createTicketInPortal(token, dto);
  }

  @Post('public/:token/tickets/:ticketId/reply')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Post a buyer reply onto an existing SLA support ticket from Buyer Portal',
  })
  @ApiParam({ name: 'token', description: 'Buyer portal token' })
  @ApiParam({ name: 'ticketId', description: 'Support Ticket ID' })
  @ApiBody({ type: PortalTicketReplyDto })
  async replyTicket(
    @Param('token') token: string,
    @Param('ticketId') ticketId: string,
    @Body() dto: PortalTicketReplyDto,
  ) {
    return this.portalService.replyToTicketInPortal(token, ticketId, dto);
  }
}
