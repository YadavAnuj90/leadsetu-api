import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class InvoiceLineItemDto {
  @ApiProperty({
    description: 'Product / service item description',
    example: 'Industrial Three-Phase Servo Voltage Stabilizer (150 KVA)',
  })
  description!: string;

  @ApiPropertyOptional({
    description: '6 or 8-digit HSN / SAC code for GST filing',
    example: '850440',
    default: '998314',
  })
  hsnSac?: string;

  @ApiProperty({
    description: 'Quantity of units',
    example: 2,
    default: 1,
  })
  quantity!: number;

  @ApiProperty({
    description: 'Unit price in INR (₹) excluding GST',
    example: 225000,
  })
  unitPrice!: number;
}

export class CreateInvoiceDto {
  @ApiPropertyOptional({
    description: 'Custom invoice or quotation number (auto-generated if omitted)',
    example: 'INV-2026-1001',
  })
  invoiceNumber?: string;

  @ApiPropertyOptional({
    description: 'Document type: Tax Invoice or Proforma Quotation',
    enum: ['tax_invoice', 'proforma_quote'],
    default: 'tax_invoice',
    example: 'tax_invoice',
  })
  docType?: 'tax_invoice' | 'proforma_quote';

  @ApiProperty({
    description: 'Registered B2B client / company name',
    example: 'RS Electricals Pvt. Ltd.',
  })
  clientName!: string;

  @ApiPropertyOptional({
    description: 'Primary point of contact at the buyer company',
    example: 'Rajesh Sharma',
  })
  contactPerson?: string;

  @ApiPropertyOptional({
    description: 'Buyer WhatsApp phone number (+91) for sending invoice & payment link',
    example: '+91 98112 45678',
  })
  phone?: string;

  @ApiPropertyOptional({
    description: 'Buyer accounts / billing email address',
    example: 'accounts@rselectricals.in',
  })
  email?: string;

  @ApiPropertyOptional({
    description: '15-digit buyer GSTIN number',
    example: '07AABCR1234F1Z5',
  })
  gstin?: string;

  @ApiPropertyOptional({
    description: 'Place of Supply (State Code & Name)',
    example: '09 - Uttar Pradesh',
    default: '09 - Uttar Pradesh',
  })
  placeOfSupply?: string;

  @ApiPropertyOptional({
    description: 'Tax structure: cgst_sgst (Intra-state 9%+9%) or igst (Inter-state 18%)',
    enum: ['cgst_sgst', 'igst'],
    default: 'cgst_sgst',
  })
  taxType?: 'cgst_sgst' | 'igst';

  @ApiPropertyOptional({
    description: 'Applicable GST slab percentage (0, 5, 12, 18, or 28)',
    example: 18,
    default: 18,
  })
  gstRate?: number;

  @ApiProperty({
    description: 'Itemized products/services with HSN/SAC codes',
    type: [InvoiceLineItemDto],
  })
  items!: InvoiceLineItemDto[];

  @ApiPropertyOptional({
    description: 'Flat discount in INR (₹) before GST calculation',
    example: 0,
    default: 0,
  })
  discount?: number;

  @ApiPropertyOptional({
    description: 'Invoice status',
    enum: ['draft', 'sent', 'paid', 'overdue', 'cancelled'],
    default: 'sent',
  })
  status?: 'draft' | 'sent' | 'paid' | 'overdue' | 'cancelled';

  @ApiPropertyOptional({
    description: 'Payment mode',
    enum: ['razorpay', 'upi', 'neft_rtgs', 'unpaid'],
    default: 'unpaid',
  })
  paymentMethod?: 'razorpay' | 'upi' | 'neft_rtgs' | 'unpaid';

  @ApiPropertyOptional({
    description: 'Due date (ISO date or formatted string)',
    example: '2026-11-25',
  })
  dueDate?: string;

  @ApiPropertyOptional({
    description: 'Payment terms, bank NEFT details, or warranty notes',
    example: '50% advance via NEFT/Razorpay, balance before dispatch from Noida Electronic City warehouse.',
  })
  notes?: string;

  @ApiPropertyOptional({
    description: 'Optional linked Deal ID',
    example: 'del_01a2b3c4d5e6',
  })
  linkedDealId?: string;

  @ApiPropertyOptional({
    description: 'Optional linked Lead ID',
    example: 'ld_01a2b3c4d5e6',
  })
  linkedLeadId?: string;

  @ApiPropertyOptional({
    description: 'Admin/Finance override when buyer is on Credit Hold or over Credit Limit',
    default: false,
  })
  overrideCreditHold?: boolean;

  @ApiPropertyOptional({
    description: 'Audit reason for Admin credit override',
    example: 'MD verbal assurance for NEFT clearance by Friday',
  })
  overrideReason?: string;
}

export class UpdateInvoiceDto extends CreateInvoiceDto {}

export class MarkInvoicePaidDto {
  @ApiPropertyOptional({
    description: 'Payment mode used to settle the invoice',
    enum: ['razorpay', 'upi', 'neft_rtgs'],
    default: 'razorpay',
    example: 'razorpay',
  })
  paymentMethod?: 'razorpay' | 'upi' | 'neft_rtgs';
}

export class RecordInvoicePaymentDto {
  @ApiProperty({
    description: 'Cash / Bank amount actually received from buyer in INR',
    example: 150000,
  })
  amountPaid!: number;

  @ApiPropertyOptional({
    description: 'TDS deducted by buyer (e.g. 2% u/s 194C or 10% u/s 194J) in INR',
    example: 3000,
    default: 0,
  })
  tdsDeducted?: number;

  @ApiProperty({
    description: 'Payment mode used by buyer',
    enum: ['UPI', 'NEFT', 'RTGS', 'Cheque', 'Razorpay', 'Cash'],
    example: 'NEFT',
  })
  paymentMode!: 'UPI' | 'NEFT' | 'RTGS' | 'Cheque' | 'Razorpay' | 'Cash';

  @ApiPropertyOptional({
    description: 'UTR reference, IMPS ref, Razorpay payment ID, or Cheque number',
    example: 'UTR431988120945',
  })
  utrOrChequeNo?: string;

  @ApiPropertyOptional({
    description: 'Date payment was received (YYYY-MM-DD)',
    example: '2026-11-14',
  })
  paymentDate?: string;

  @ApiPropertyOptional({
    description: 'Milestone / remark (e.g. 30% Advance, Balance Dispatch)',
    example: '30% Advance Milestone + 2% TDS',
  })
  note?: string;
}

export class RecordPromiseToPayDto {
  @ApiProperty({
    description: 'Promised payment date (YYYY-MM-DD)',
    example: '2026-11-22',
  })
  promisedPaymentDate!: string;

  @ApiPropertyOptional({
    description: 'Promised amount in INR',
    example: 150000,
  })
  promisedAmount?: number;

  @ApiPropertyOptional({
    description: 'Buyer commitment note',
    example: 'Director confirmed NEFT release after GST audit on Friday',
  })
  ptpNote?: string;
}

export class SendRecoveryChaserDto {
  @ApiPropertyOptional({
    enum: ['polite', 'firm', 'urgent', 'final_hold'],
    default: 'firm',
  })
  tone?: 'polite' | 'firm' | 'urgent' | 'final_hold';

  @ApiPropertyOptional({
    enum: ['hinglish', 'hindi', 'english'],
    default: 'hinglish',
  })
  language?: 'hinglish' | 'hindi' | 'english';

  @ApiPropertyOptional({
    description: 'Optional custom chaser message text',
  })
  customMessage?: string;
}

export class UpdateRecoveryConfigDto {
  @ApiPropertyOptional({ example: 'leadsetu@icici' })
  upiId?: string;

  @ApiPropertyOptional({ example: 'Leadsetu Technologies Pvt. Ltd.' })
  merchantName?: string;

  @ApiPropertyOptional({ default: true })
  autoChasersEnabled?: boolean;

  @ApiPropertyOptional({ example: 30, default: 30 })
  autoHoldAfterDays?: number;

  @ApiPropertyOptional({
    example: 'HDFC Current A/c 50200084112901 · IFSC HDFC0000412 (Noida Sec 62)',
  })
  bankAccountNote?: string;
}

export class BankStatementEntryDto {
  @ApiPropertyOptional({ example: 'stmt-row-01' })
  id?: string;

  @ApiProperty({ example: '2026-11-21', description: 'Bank transaction date (YYYY-MM-DD)' })
  date!: string;

  @ApiProperty({ example: 'NEFT CR-HDFC0000412-SHARMA STEEL WORKS-UTR99812', description: 'Bank statement narration string' })
  narration!: string;

  @ApiProperty({ example: 'HDFCR5202611210099812', description: 'UTR or bank reference number' })
  utrOrRef!: string;

  @ApiProperty({ example: 58410, description: 'Credited amount in INR' })
  creditAmount!: number;
}

export class BankStatementReconcileDto {
  @ApiProperty({ type: [BankStatementEntryDto] })
  entries!: BankStatementEntryDto[];
}

export class BankMatchItemDto {
  @ApiProperty({ example: '67401a2f8c1b9e0012ab3456', description: 'Target CRM Invoice ID' })
  invoiceId!: string;

  @ApiProperty({ example: 58410, description: 'Settled amount in INR' })
  amountPaid!: number;

  @ApiPropertyOptional({ example: 1180, description: 'TDS u/s 194C/194J deducted by buyer in INR' })
  tdsDeducted?: number;

  @ApiProperty({ example: 'HDFCR5202611210099812', description: 'UTR or cheque number' })
  utrOrChequeNo!: string;

  @ApiProperty({ example: '2026-11-21', description: 'Payment settlement date (ISO-8601)' })
  paymentDate!: string;

  @ApiPropertyOptional({
    enum: ['UPI', 'NEFT', 'RTGS', 'Cheque', 'Razorpay', 'Cash'],
    example: 'NEFT',
  })
  paymentMode?: 'UPI' | 'NEFT' | 'RTGS' | 'Cheque' | 'Razorpay' | 'Cash';

  @ApiPropertyOptional({ example: 'Matched automatically from HDFC Nov statement' })
  note?: string;
}

export class ApplyBankMatchDto {
  @ApiProperty({ type: [BankMatchItemDto], description: 'Reconciled bank matches to post to invoice ledgers' })
  matches!: BankMatchItemDto[];
}
