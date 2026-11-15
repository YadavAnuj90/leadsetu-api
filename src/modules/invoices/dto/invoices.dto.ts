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
    example: '672e1a2b3c4d5e6f7a8b9c0d',
  })
  linkedDealId?: string;

  @ApiPropertyOptional({
    description: 'Optional linked Lead ID',
    example: '672e1a2b3c4d5e6f7a8b9c0e',
  })
  linkedLeadId?: string;
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
