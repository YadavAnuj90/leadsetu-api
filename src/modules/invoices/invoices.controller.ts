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
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  ApplyBankMatchDto,
  BankStatementReconcileDto,
  CreateInvoiceDto,
  MarkInvoicePaidDto,
  RecordInvoicePaymentDto,
  RecordPromiseToPayDto,
  SendRecoveryChaserDto,
  UpdateInvoiceDto,
  UpdateRecoveryConfigDto,
} from './dto/invoices.dto';
import { InvoicesService } from './invoices.service';

@ApiTags('7. GST Invoices & Quotations')
@ApiBearerAuth('access-token')
@Controller('invoices')
export class InvoicesController {
  constructor(private readonly invoicesService: InvoicesService) {}

  @Get()
  @ApiOperation({
    summary:
      'List all GST Tax Invoices & Proforma Quotations with live GST & revenue stats',
  })
  @ApiQuery({
    name: 'search',
    required: false,
    description: 'Search by invoice #, client name, 15-digit GSTIN, or place of supply',
    example: 'INV-2026',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['all', 'draft', 'sent', 'partial', 'paid', 'overdue', 'cancelled'],
    description: 'Filter by invoice payment status',
  })
  @ApiQuery({
    name: 'docType',
    required: false,
    enum: ['all', 'tax_invoice', 'proforma_quote'],
    description: 'Filter by document type (Tax Invoice vs Proforma Quote)',
  })
  @ApiResponse({
    status: 200,
    description: 'Returns `{ data: Invoice[], stats: InvoiceStats }`.',
  })
  async findAll(
    @Headers('authorization') authorization: string | undefined,
    @Query() query: { search?: string; status?: string; docType?: string },
  ) {
    const auth = await this.invoicesService.verifyAuth(authorization);
    return this.invoicesService.findAll(auth, query);
  }

  @Get('export/gstr1')
  @ApiOperation({
    summary:
      'Export CA-ready GSTR-1 & Tally Prime CSV across all GST invoices & credit notes',
  })
  async exportGstr1(
    @Headers('authorization') authorization: string | undefined,
  ) {
    const auth = await this.invoicesService.verifyAuth(authorization);
    return this.invoicesService.exportGstr1Csv(auth);
  }

  @Get('export/tally-xml')
  @ApiOperation({
    summary:
      'Export native TallyPrime <ENVELOPE> XML containing Sales, Receipt & TDS Receivable vouchers',
  })
  async exportTallyXml(
    @Headers('authorization') authorization: string | undefined,
  ) {
    const auth = await this.invoicesService.verifyAuth(authorization);
    return this.invoicesService.exportTallyXml(auth);
  }

  @Get('recovery/overview')
  @ApiOperation({
    summary:
      'Udhaar Recovery & Credit Risk Command Center (KPIs, Buyer Credit Risk Ledger, Broken PTPs, Overdue Queue)',
  })
  async getRecoveryOverview(
    @Headers('authorization') authorization: string | undefined,
  ) {
    const auth = await this.invoicesService.verifyAuth(authorization);
    return this.invoicesService.getRecoveryOverview(auth);
  }

  @Patch('recovery/config')
  @ApiOperation({
    summary:
      'Configure Tenant UPI ID, Auto-Hold overdue days threshold, and NEFT bank instructions',
  })
  async updateRecoveryConfig(
    @Headers('authorization') authorization: string | undefined,
    @Body() dto: UpdateRecoveryConfigDto,
  ) {
    const auth = await this.invoicesService.verifyAuth(authorization);
    return this.invoicesService.updateRecoveryConfig(auth, dto);
  }

  @Post('recovery/run-chasers')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Batch-run automated Hinglish WhatsApp + UPI Udhaar chasers & auto-apply Credit Hold on severe defaulters',
  })
  async runBatchChasers(
    @Headers('authorization') authorization: string | undefined,
  ) {
    const auth = await this.invoicesService.verifyAuth(authorization);
    return this.invoicesService.runBatchChasers(auth);
  }

  @Post('reconcile-bank')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Match bank statement NEFT/RTGS/UPI credits against open GST invoices (including TDS detection)',
  })
  async previewBankReconciliation(
    @Headers('authorization') authorization: string | undefined,
    @Body() dto: BankStatementReconcileDto,
  ) {
    const auth = await this.invoicesService.verifyAuth(authorization);
    return this.invoicesService.previewBankReconciliation(auth, dto);
  }

  @Post('reconcile-bank/apply')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Apply matched bank statement settlements into invoice Accounts Receivable ledgers',
  })
  async applyBankMatches(
    @Headers('authorization') authorization: string | undefined,
    @Body() dto: ApplyBankMatchDto,
  ) {
    const auth = await this.invoicesService.verifyAuth(authorization);
    return this.invoicesService.applyBankMatches(auth, dto);
  }

  @Post('webhooks/razorpay')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Public Razorpay Payment Webhook for Customer B2B GST Invoices (auto-flips paid, clears Credit Hold, sends WhatsApp receipt)',
    description: 'Verifies X-Razorpay-Signature, records Razorpay settlement on the customer invoice, clears Contact Credit Hold if no other overdue unpaid invoices remain, and dispatches WhatsApp receipt.',
  })
  @ApiHeader({ name: 'x-razorpay-signature', required: true, description: 'HMAC-SHA256 hex digest from Razorpay' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['event', 'payload'],
      properties: {
        event: { type: 'string', example: 'payment_link.paid' },
        payload: { type: 'object' },
      },
    },
  })
  async handleCustomerRazorpayWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-razorpay-signature') signature: string | undefined,
    @Body() payload: Record<string, unknown>,
  ) {
    return this.invoicesService.handleCustomerRazorpayWebhook(
      req.rawBody,
      signature,
      payload || {},
    );
  }

  @Get('public/:token')
  @ApiOperation({
    summary: 'Public buyer quotation view by shareable token (no auth required)',
    description: 'Fetches buyer-facing GST Proforma Quotation details and line items using the shareable public token.',
  })
  @ApiParam({ name: 'token', description: 'Unique public quotation token' })
  async getPublicQuote(@Param('token') token: string) {
    return this.invoicesService.getPublicQuote(token);
  }

  @Post('public/:token/respond')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Buyer public quote decision (Approve Quote or Request Revision)',
    description: 'Records buyer approval or change request directly from the shareable public quote page.',
  })
  @ApiParam({ name: 'token', description: 'Unique public quotation token' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['decision'],
      properties: {
        decision: { type: 'string', enum: ['approved', 'changes_requested'], example: 'approved' },
        buyerName: { type: 'string', example: 'Rajesh Sharma' },
        remark: { type: 'string', example: 'Approved, proceed with tax invoice.' },
      },
    },
  })
  async respondToPublicQuote(
    @Param('token') token: string,
    @Body()
    body: {
      decision: 'approved' | 'changes_requested';
      buyerName?: string;
      remark?: string;
    },
  ) {
    return this.invoicesService.respondToPublicQuote(token, body);
  }

  @Post(':id/convert-to-invoice')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Convert an approved or pending Proforma Quotation into a GST Tax Invoice',
    description: 'Converts a Proforma Quotation into a GST Tax Invoice (checks buyer Credit Hold unless overridden by Owner/Admin).',
  })
  @ApiParam({ name: 'id', description: 'Unique quotation record ID', example: 'inv_01a2b3c4d5e6' })
  @ApiBody({
    required: false,
    schema: {
      type: 'object',
      properties: {
        overrideCreditHold: { type: 'boolean', example: false },
        overrideReason: { type: 'string', example: 'MD approved dispatch against PDC' },
      },
    },
  })
  async convertToInvoice(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
    @Body() body?: { overrideCreditHold?: boolean; overrideReason?: string },
  ) {
    const auth = await this.invoicesService.verifyAuth(authorization);
    return this.invoicesService.convertQuoteToInvoice(auth, id, body);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get a single GST Invoice or Proforma Quotation by ID',
  })
  @ApiParam({
    name: 'id',
    description: 'Unique invoice record ID',
    example: 'inv_01a2b3c4d5e6',
  })
  @ApiResponse({ status: 200, description: 'Full GST invoice returned.' })
  async findOne(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
  ) {
    const auth = await this.invoicesService.verifyAuth(authorization);
    return this.invoicesService.findOne(auth, id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Create a new GST Tax Invoice or Proforma Quotation (auto-calculates CGST/SGST or IGST)',
  })
  @ApiBody({ type: CreateInvoiceDto })
  @ApiResponse({ status: 201, description: 'GST Invoice created.' })
  async create(
    @Headers('authorization') authorization: string | undefined,
    @Body() dto: CreateInvoiceDto,
  ) {
    const auth = await this.invoicesService.verifyAuth(authorization);
    return this.invoicesService.create(auth, dto);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update an existing GST Invoice or Proforma Quotation',
  })
  @ApiParam({
    name: 'id',
    description: 'Unique invoice record ID',
    example: 'inv_01a2b3c4d5e6',
  })
  @ApiBody({ type: UpdateInvoiceDto })
  @ApiResponse({ status: 200, description: 'Invoice updated.' })
  async update(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
    @Body() dto: UpdateInvoiceDto,
  ) {
    const auth = await this.invoicesService.verifyAuth(authorization);
    return this.invoicesService.update(auth, id, dto);
  }

  @Post(':id/payments')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Record a Partial / Advance Payment & TDS Deduction on an Invoice (Accounts Receivable Ledger)',
    description: 'Appends a payment ledger entry with optional TDS deduction and updates balance due.',
  })
  @ApiParam({ name: 'id', description: 'Unique invoice record ID', example: 'inv_01a2b3c4d5e6' })
  @ApiBody({ type: RecordInvoicePaymentDto })
  async recordPayment(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
    @Body() dto: RecordInvoicePaymentDto,
  ) {
    const auth = await this.invoicesService.verifyAuth(authorization);
    return this.invoicesService.recordPayment(auth, id, dto);
  }

  @Delete(':id/payments/:paymentId')
  @ApiOperation({
    summary: 'Reverse/delete an Accounts Receivable ledger payment entry on an invoice',
    description: 'Removes a specific settlement entry and recalculates invoice balance due.',
  })
  @ApiParam({ name: 'id', description: 'Unique invoice record ID', example: 'inv_01a2b3c4d5e6' })
  @ApiParam({ name: 'paymentId', description: 'Unique AR payment ledger entry ID' })
  async deletePayment(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
    @Param('paymentId') paymentId: string,
  ) {
    const auth = await this.invoicesService.verifyAuth(authorization);
    return this.invoicesService.deletePayment(auth, id, paymentId);
  }

  @Post(':id/mark-paid')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Mark an invoice as Paid (via Razorpay, UPI, or NEFT/RTGS)',
  })
  @ApiParam({
    name: 'id',
    description: 'Unique invoice record ID',
    example: 'inv_01a2b3c4d5e6',
  })
  @ApiBody({ type: MarkInvoicePaidDto })
  @ApiResponse({ status: 200, description: 'Invoice marked as paid.' })
  async markPaid(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
    @Body() dto: MarkInvoicePaidDto,
  ) {
    const auth = await this.invoicesService.verifyAuth(authorization);
    return this.invoicesService.markPaid(auth, id, dto);
  }

  @Post(':id/ptp')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Record Promise-to-Pay (PTP) date & committed amount on an unpaid invoice',
    description: 'Logs buyer promise-to-pay commitment date and notes for AR follow-up.',
  })
  @ApiParam({ name: 'id', description: 'Unique invoice record ID', example: 'inv_01a2b3c4d5e6' })
  @ApiBody({ type: RecordPromiseToPayDto })
  async recordPtp(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
    @Body() dto: RecordPromiseToPayDto,
  ) {
    const auth = await this.invoicesService.verifyAuth(authorization);
    return this.invoicesService.recordPromiseToPay(auth, id, dto);
  }

  @Post(':id/send-chaser')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Dispatch WhatsApp + UPI Udhaar recovery reminder & log chaser history',
    description: 'Sends an automated recovery message with payment link to the buyer.',
  })
  @ApiParam({ name: 'id', description: 'Unique invoice record ID', example: 'inv_01a2b3c4d5e6' })
  @ApiBody({ type: SendRecoveryChaserDto })
  async sendChaser(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
    @Body() dto: SendRecoveryChaserDto,
  ) {
    const auth = await this.invoicesService.verifyAuth(authorization);
    return this.invoicesService.sendRecoveryChaser(auth, id, dto);
  }

  @Post(':id/send-whatsapp')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      '1-Click Send Quotation or GST Tax Invoice PDF + Razorpay payment link via connected WhatsApp Cloud & log to Deal/Lead timeline',
    description: 'Generates document PDF and dispatches it to the buyer phone over Meta WhatsApp Cloud or CRM Inbox.',
  })
  @ApiParam({ name: 'id', description: 'Unique invoice or quotation ID', example: 'inv_01a2b3c4d5e6' })
  @ApiBody({
    required: false,
    schema: {
      type: 'object',
      properties: {
        phone: { type: 'string', example: '+91 9811001122' },
        customMessage: { type: 'string', example: 'Please find attached GST Proforma Quotation.' },
        publicBaseUrl: { type: 'string', example: 'http://localhost:3000' },
      },
    },
  })
  async sendOnWhatsApp(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
    @Body()
    dto?: {
      phone?: string;
      customMessage?: string;
      publicBaseUrl?: string;
    },
  ) {
    const auth = await this.invoicesService.verifyAuth(authorization);
    return this.invoicesService.sendOnWhatsApp(auth, id, dto);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Delete a GST Invoice or Proforma Quotation',
  })
  @ApiParam({
    name: 'id',
    description: 'Unique invoice record ID',
    example: 'inv_01a2b3c4d5e6',
  })
  @ApiResponse({ status: 200, description: 'Invoice deleted.' })
  async remove(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
  ) {
    const auth = await this.invoicesService.verifyAuth(authorization);
    return this.invoicesService.remove(auth, id);
  }
}
