import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Injectable,
  Module,
  NotFoundException,
  Optional,
  Param,
  Patch,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import {
  InjectModel,
  MongooseModule,
  Prop,
  Schema,
  SchemaFactory,
} from '@nestjs/mongoose';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiProperty,
  ApiPropertyOptional,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { HydratedDocument, Model, Types } from 'mongoose';
import { randomBytes } from 'crypto';
import { AuditService } from '../audit/audit.module';
import { maskPhoneNumber } from '../auth/identity.util';

export type InvoiceDocument = HydratedDocument<Invoice>;

@Schema({ _id: false })
export class InvoiceLineItem {
  @Prop({ required: true, trim: true })
  description!: string;

  @Prop({ trim: true, default: '998314' })
  hsnSac!: string;

  @Prop({ type: Number, required: true, default: 1 })
  quantity!: number;

  @Prop({ type: Number, required: true, default: 0 })
  unitPrice!: number;

  @Prop({ type: Number, required: true, default: 0 })
  amount!: number;
}

export const InvoiceLineItemSchema =
  SchemaFactory.createForClass(InvoiceLineItem);

@Schema({ _id: false })
export class InvoicePaymentRecord {
  @Prop({ required: true, trim: true })
  id!: string;

  @Prop({ type: Number, required: true, default: 0 })
  amountPaid!: number;

  @Prop({ type: Number, default: 0 })
  tdsDeducted!: number;

  @Prop({ type: Number, default: 0 })
  totalSettled!: number;

  @Prop({
    default: 'NEFT',
    enum: ['UPI', 'NEFT', 'RTGS', 'Cheque', 'Razorpay', 'Cash'],
  })
  paymentMode!: 'UPI' | 'NEFT' | 'RTGS' | 'Cheque' | 'Razorpay' | 'Cash';

  @Prop({ trim: true, default: '' })
  utrOrChequeNo!: string;

  @Prop({ trim: true, default: '' })
  paymentDate!: string;

  @Prop({ trim: true, default: '' })
  note!: string;

  @Prop({ trim: true, default: '' })
  recordedAt!: string;
}

export const InvoicePaymentRecordSchema =
  SchemaFactory.createForClass(InvoicePaymentRecord);

@Schema({ timestamps: true, collection: 'invoices' })
export class Invoice {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  ownerId!: Types.ObjectId;

  @Prop({ required: true, trim: true, index: true })
  invoiceNumber!: string;

  @Prop({
    default: 'tax_invoice',
    enum: ['tax_invoice', 'proforma_quote'],
  })
  docType!: 'tax_invoice' | 'proforma_quote';

  @Prop({ required: true, trim: true })
  clientName!: string;

  @Prop({ trim: true, default: '' })
  contactPerson!: string;

  @Prop({ trim: true, default: '' })
  phone!: string;

  @Prop({ trim: true, lowercase: true, default: '' })
  email!: string;

  @Prop({ trim: true, uppercase: true, default: '' })
  gstin!: string;

  @Prop({ trim: true, default: '09 - Uttar Pradesh' })
  placeOfSupply!: string;

  @Prop({
    default: 'cgst_sgst',
    enum: ['cgst_sgst', 'igst'],
  })
  taxType!: 'cgst_sgst' | 'igst';

  @Prop({ type: Number, default: 18 })
  gstRate!: number;

  @Prop({ type: [InvoiceLineItemSchema], default: [] })
  items!: InvoiceLineItem[];

  @Prop({ type: Number, default: 0 })
  subTotal!: number;

  @Prop({ type: Number, default: 0 })
  discount!: number;

  @Prop({ type: Number, default: 0 })
  taxableAmount!: number;

  @Prop({ type: Number, default: 0 })
  cgstAmount!: number;

  @Prop({ type: Number, default: 0 })
  sgstAmount!: number;

  @Prop({ type: Number, default: 0 })
  igstAmount!: number;

  @Prop({ type: Number, default: 0 })
  gstAmount!: number;

  @Prop({ type: Number, default: 0 })
  grandTotal!: number;

  @Prop({ type: Number, default: 0 })
  amountPaid!: number;

  @Prop({ type: Number, default: 0 })
  tdsDeducted!: number;

  @Prop({ type: Number, default: 0 })
  balanceDue!: number;

  @Prop({ type: [InvoicePaymentRecordSchema], default: [] })
  payments!: InvoicePaymentRecord[];

  @Prop({
    default: 'sent',
    enum: ['draft', 'sent', 'partial', 'paid', 'overdue', 'cancelled'],
  })
  status!: 'draft' | 'sent' | 'partial' | 'paid' | 'overdue' | 'cancelled';

  @Prop({
    default: 'unpaid',
    enum: ['razorpay', 'upi', 'neft_rtgs', 'unpaid'],
  })
  paymentMethod!: 'razorpay' | 'upi' | 'neft_rtgs' | 'unpaid';

  @Prop({ trim: true, default: '' })
  paymentLink!: string;

  @Prop({ trim: true, default: '' })
  dueDate!: string;

  @Prop({ trim: true, default: '' })
  notes!: string;

  @Prop({ trim: true, default: '' })
  linkedDealId!: string;

  @Prop({ trim: true, default: '' })
  linkedLeadId!: string;

  @Prop({ trim: true, unique: true, sparse: true, index: true })
  publicToken?: string;

  @Prop({
    default: 'pending',
    enum: ['pending', 'approved', 'changes_requested'],
  })
  quoteApprovalStatus!: 'pending' | 'approved' | 'changes_requested';

  @Prop({ trim: true, default: '' })
  approvedByName!: string;

  @Prop({ trim: true, default: '' })
  approvedAt!: string;

  @Prop({ trim: true, default: '' })
  convertedFromQuoteId!: string;

  @Prop({ trim: true, default: '' })
  convertedToInvoiceId!: string;
}

export const InvoiceSchema = SchemaFactory.createForClass(Invoice);

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

@Injectable()
export class InvoicesService {
  constructor(
    @InjectModel(Invoice.name)
    private readonly invoiceModel: Model<InvoiceDocument>,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    @Optional() private readonly auditService?: AuditService,
  ) {}

  async verifyAuth(authHeader?: string) {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Authorization token is required.');
    }
    const token = authHeader.slice(7).trim();
    const secret =
      this.configService.get<string>('JWT_SECRET') ||
      'leadsetu_super_secret_access_key_2026_delhi_ncr';
    try {
      const payload = await this.jwtService.verifyAsync<{
        sub: string;
        tenantId: string;
        email: string;
      }>(token, { secret });
      return {
        userId: payload.sub,
        tenantId: payload.tenantId,
        email: payload.email,
      };
    } catch {
      throw new UnauthorizedException('Invalid or expired session.');
    }
  }

  private computeTotals(
    rawItems: InvoiceLineItemDto[],
    discount = 0,
    gstRate = 18,
    taxType: 'cgst_sgst' | 'igst' = 'cgst_sgst',
  ) {
    const items: InvoiceLineItem[] = (rawItems || []).map((item) => {
      const quantity = Math.max(1, Number(item.quantity) || 1);
      const unitPrice = Math.max(0, Number(item.unitPrice) || 0);
      const amount = Math.round(quantity * unitPrice);
      return {
        description: (item.description || 'B2B Service / Supply').trim(),
        hsnSac: (item.hsnSac || '998314').trim(),
        quantity,
        unitPrice,
        amount,
      };
    });

    const subTotal = items.reduce((sum, i) => sum + i.amount, 0);
    const safeDiscount = Math.min(subTotal, Math.max(0, Number(discount) || 0));
    const taxableAmount = Math.max(0, subTotal - safeDiscount);
    const rate = [0, 5, 12, 18, 28].includes(Number(gstRate))
      ? Number(gstRate)
      : 18;
    const gstAmount = Math.round((taxableAmount * rate) / 100);

    let cgstAmount = 0;
    let sgstAmount = 0;
    let igstAmount = 0;

    if (taxType === 'igst') {
      igstAmount = gstAmount;
    } else {
      cgstAmount = Math.round(gstAmount / 2);
      sgstAmount = gstAmount - cgstAmount;
    }

    const grandTotal = taxableAmount + gstAmount;

    return {
      items,
      subTotal,
      discount: safeDiscount,
      taxableAmount,
      gstRate: rate,
      cgstAmount,
      sgstAmount,
      igstAmount,
      gstAmount,
      grandTotal,
    };
  }

  private computeAging(status: string, dueDate?: string): {
    daysOverdue: number;
    agingBucket: 'paid' | 'current' | '1_15_days' | '16_30_days' | '30_plus_days';
  } {
    if (status === 'paid' || status === 'cancelled') {
      return { daysOverdue: 0, agingBucket: 'paid' };
    }
    if (!dueDate) {
      return { daysOverdue: 0, agingBucket: 'current' };
    }
    const dueMs = new Date(dueDate).getTime();
    if (!Number.isFinite(dueMs)) {
      return { daysOverdue: 0, agingBucket: 'current' };
    }
    const diffDays = Math.floor((Date.now() - dueMs) / 86400000);
    if (diffDays <= 0) return { daysOverdue: 0, agingBucket: 'current' };
    if (diffDays <= 15) return { daysOverdue: diffDays, agingBucket: '1_15_days' };
    if (diffDays <= 30) return { daysOverdue: diffDays, agingBucket: '16_30_days' };
    return { daysOverdue: diffDays, agingBucket: '30_plus_days' };
  }

  private computeSettlement(doc: {
    grandTotal?: number;
    amountPaid?: number;
    tdsDeducted?: number;
    status?: string;
    payments?: InvoicePaymentRecord[];
  }) {
    const grandTotal = Math.max(0, Number(doc.grandTotal) || 0);
    const payments = Array.isArray(doc.payments) ? doc.payments : [];
    let amountPaid = 0;
    let tdsDeducted = 0;

    if (payments.length > 0) {
      amountPaid = payments.reduce(
        (sum, p) => sum + Math.max(0, Number(p.amountPaid) || 0),
        0,
      );
      tdsDeducted = payments.reduce(
        (sum, p) => sum + Math.max(0, Number(p.tdsDeducted) || 0),
        0,
      );
    } else if ((Number(doc.amountPaid) || 0) > 0 || (Number(doc.tdsDeducted) || 0) > 0) {
      amountPaid = Math.max(0, Number(doc.amountPaid) || 0);
      tdsDeducted = Math.max(0, Number(doc.tdsDeducted) || 0);
    } else if (doc.status === 'paid') {
      amountPaid = grandTotal;
    }

    const totalSettled = Math.round(amountPaid + tdsDeducted);
    const balanceDue =
      doc.status === 'cancelled'
        ? 0
        : Math.max(0, Math.round(grandTotal - totalSettled));

    return {
      grandTotal,
      amountPaid: Math.round(amountPaid),
      tdsDeducted: Math.round(tdsDeducted),
      totalSettled,
      balanceDue,
      payments,
    };
  }

  private toDto(doc: InvoiceDocument, maskPhones = false) {
    const raw = doc.toObject() as unknown as Record<string, unknown> & {
      createdAt?: Date;
      updatedAt?: Date;
    };
    const settlement = this.computeSettlement(doc);
    const isSettledInFull =
      doc.status === 'cancelled' ||
      (settlement.grandTotal > 0 && settlement.balanceDue <= 0) ||
      (settlement.grandTotal === 0 && doc.status === 'paid');

    const aging = this.computeAging(
      doc.status === 'cancelled'
        ? 'cancelled'
        : isSettledInFull
          ? 'paid'
          : 'sent',
      doc.dueDate,
    );

    let effectiveStatus:
      | 'draft'
      | 'sent'
      | 'partial'
      | 'paid'
      | 'overdue'
      | 'cancelled' = doc.status || 'sent';
    if (doc.status === 'cancelled') {
      effectiveStatus = 'cancelled';
    } else if (isSettledInFull) {
      effectiveStatus = 'paid';
    } else if (settlement.totalSettled > 0) {
      effectiveStatus = 'partial';
    } else if (
      aging.daysOverdue > 0 &&
      (doc.status === 'sent' || doc.status === 'draft')
    ) {
      effectiveStatus = 'overdue';
    }

    return {
      id: doc._id.toString(),
      tenantId: doc.tenantId.toString(),
      invoiceNumber: doc.invoiceNumber,
      docType: doc.docType || 'tax_invoice',
      clientName: doc.clientName,
      contactPerson: doc.contactPerson || '',
      phone: maskPhones ? maskPhoneNumber(doc.phone) : doc.phone || '',
      email: doc.email || '',
      gstin: doc.gstin || '',
      placeOfSupply: doc.placeOfSupply || '09 - Uttar Pradesh',
      taxType: doc.taxType || 'cgst_sgst',
      gstRate: doc.gstRate ?? 18,
      items: doc.items || [],
      subTotal: doc.subTotal || 0,
      discount: doc.discount || 0,
      taxableAmount: doc.taxableAmount || 0,
      cgstAmount: doc.cgstAmount || 0,
      sgstAmount: doc.sgstAmount || 0,
      igstAmount: doc.igstAmount || 0,
      gstAmount: doc.gstAmount || 0,
      grandTotal: settlement.grandTotal,
      amountPaid: settlement.amountPaid,
      tdsDeducted: settlement.tdsDeducted,
      totalSettled: settlement.totalSettled,
      balanceDue: settlement.balanceDue,
      payments: settlement.payments,
      status: effectiveStatus,
      daysOverdue: aging.daysOverdue,
      agingBucket: aging.agingBucket,
      paymentMethod: doc.paymentMethod || 'unpaid',
      paymentLink: doc.paymentLink || '',
      dueDate: doc.dueDate || '',
      notes: doc.notes || '',
      linkedDealId: doc.linkedDealId || '',
      linkedLeadId: doc.linkedLeadId || '',
      publicToken: doc.publicToken || '',
      quoteApprovalStatus: doc.quoteApprovalStatus || 'pending',
      approvedByName: doc.approvedByName || '',
      approvedAt: doc.approvedAt || '',
      convertedFromQuoteId: doc.convertedFromQuoteId || '',
      convertedToInvoiceId: doc.convertedToInvoiceId || '',
      createdAt: raw.createdAt
        ? new Date(raw.createdAt).toISOString()
        : new Date().toISOString(),
      updatedAt: raw.updatedAt
        ? new Date(raw.updatedAt).toISOString()
        : new Date().toISOString(),
    };
  }

  async findAll(
    auth: { userId: string; tenantId: string },
    query: { search?: string; status?: string; docType?: string },
  ) {
    const tenantObjectId = new Types.ObjectId(auth.tenantId);
    const filter: Record<string, unknown> = { tenantId: tenantObjectId };

    if (query.docType && query.docType !== 'all') {
      filter.docType = query.docType;
    }
    if (query.search?.trim()) {
      const regex = new RegExp(query.search.trim(), 'i');
      filter.$or = [
        { invoiceNumber: regex },
        { clientName: regex },
        { contactPerson: regex },
        { gstin: regex },
        { placeOfSupply: regex },
      ];
    }

    const [docs, all, maskPhones] = await Promise.all([
      this.invoiceModel.find(filter).sort({ createdAt: -1 }).exec(),
      this.invoiceModel.find({ tenantId: tenantObjectId }).exec(),
      this.auditService
        ? this.auditService.shouldMaskViewerPhones(auth.tenantId, auth.userId)
        : Promise.resolve(false),
    ]);

    const missingTokens = docs.filter((d) => !d.publicToken);
    if (missingTokens.length > 0) {
      await Promise.all(
        missingTokens.map(async (d) => {
          d.publicToken = `lsq_${randomBytes(10).toString('hex')}`;
          await this.invoiceModel
            .updateOne({ _id: d._id }, { $set: { publicToken: d.publicToken } })
            .exec();
        }),
      );
    }

    const allMapped = all.map((d) => this.toDto(d, maskPhones));
    const activeDocs = allMapped.filter((i) => i.status !== 'cancelled');
    const paidDocs = activeDocs.filter((i) => i.status === 'paid');
    const partialDocs = activeDocs.filter((i) => i.status === 'partial');
    const pendingDocs = activeDocs.filter((i) => i.balanceDue > 0);
    const overdueDocs = activeDocs.filter(
      (i) => i.balanceDue > 0 && (i.status === 'overdue' || (i.daysOverdue ?? 0) > 0),
    );

    const sumBucket = (bucket: string) =>
      pendingDocs
        .filter((i) => i.agingBucket === bucket)
        .reduce((sum, i) => sum + (Number(i.balanceDue) || 0), 0);

    let mappedFiltered = docs.map((d) => this.toDto(d, maskPhones));
    if (query.status && query.status !== 'all') {
      if (query.status === 'overdue') {
        mappedFiltered = mappedFiltered.filter(
          (i) => i.balanceDue > 0 && (i.status === 'overdue' || (i.daysOverdue ?? 0) > 0),
        );
      } else {
        mappedFiltered = mappedFiltered.filter((i) => i.status === query.status);
      }
    }

    return {
      data: mappedFiltered,
      stats: {
        totalCount: all.length,
        paidCount: paidDocs.length,
        partialCount: partialDocs.length,
        pendingCount: pendingDocs.length,
        overdueCount: overdueDocs.length,
        totalInvoiced: activeDocs.reduce(
          (sum, i) => sum + (Number(i.grandTotal) || 0),
          0,
        ),
        totalCollected: activeDocs.reduce(
          (sum, i) => sum + (Number(i.amountPaid) || 0),
          0,
        ),
        totalTdsDeducted: activeDocs.reduce(
          (sum, i) => sum + (Number(i.tdsDeducted) || 0),
          0,
        ),
        paidRevenue: activeDocs.reduce(
          (sum, i) => sum + (Number(i.totalSettled) || 0),
          0,
        ),
        pendingAmount: activeDocs.reduce(
          (sum, i) => sum + (Number(i.balanceDue) || 0),
          0,
        ),
        totalGstCollected: activeDocs.reduce(
          (sum, i) => sum + (Number(i.gstAmount) || 0),
          0,
        ),
        aging: {
          currentAmount: sumBucket('current'),
          bucket1to15: sumBucket('1_15_days'),
          bucket16to30: sumBucket('16_30_days'),
          bucket30Plus: sumBucket('30_plus_days'),
        },
      },
    };
  }

  async exportGstr1Csv(auth: { userId: string; tenantId: string; email: string }) {
    const db = this.invoiceModel.db;
    if (db && Types.ObjectId.isValid(auth.tenantId) && Types.ObjectId.isValid(auth.userId)) {
      const [tenant, viewer] = await Promise.all([
        db.collection('tenants').findOne({ _id: new Types.ObjectId(auth.tenantId) }),
        db.collection('users').findOne({ _id: new Types.ObjectId(auth.userId) }),
      ]);
      const blockAgent = tenant?.blockAgentExport !== false;
      if (blockAgent && viewer?.role === 'agent') {
        throw new ForbiddenException(
          'CSV / GSTR-1 exports are restricted by your workspace Anti-Data-Leak Shield.',
        );
      }
    }

    const docs = await this.invoiceModel
      .find({ tenantId: new Types.ObjectId(auth.tenantId) })
      .sort({ createdAt: -1 })
      .exec();

    const csvEscape = (v: unknown) => {
      const s = String(v ?? '').replace(/"/g, '""');
      return `"${s}"`;
    };

    const headers = [
      'Invoice Number',
      'Document Type',
      'Invoice Date',
      'Due Date',
      'Status',
      'Days Overdue',
      'Buyer Name',
      'Buyer GSTIN',
      'Place of Supply',
      'Tax Type',
      'HSN/SAC Summary',
      'GST Rate (%)',
      'Taxable Value (INR)',
      'CGST (INR)',
      'SGST (INR)',
      'IGST (INR)',
      'Total GST (INR)',
      'Grand Total (INR)',
      'Amount Paid (INR)',
      'TDS Deducted (INR)',
      'Balance Due (INR)',
      'Payment Method',
    ];

    const rows = docs.map((d) => {
      const dto = this.toDto(d, false);
      const hsnCodes = Array.from(
        new Set((dto.items || []).map((it) => it.hsnSac).filter(Boolean)),
      ).join(' | ');
      return [
        dto.invoiceNumber,
        dto.docType === 'proforma_quote' ? 'Proforma Quotation' : 'Tax Invoice',
        dto.createdAt.slice(0, 10),
        dto.dueDate || '',
        dto.status.toUpperCase(),
        dto.daysOverdue,
        dto.clientName,
        dto.gstin || 'URD / Unregistered',
        dto.placeOfSupply,
        dto.taxType === 'igst' ? 'IGST (Inter-State)' : 'CGST+SGST (Intra-State)',
        hsnCodes || '998314',
        dto.gstRate,
        dto.taxableAmount,
        dto.cgstAmount,
        dto.sgstAmount,
        dto.igstAmount,
        dto.gstAmount,
        dto.grandTotal,
        dto.amountPaid,
        dto.tdsDeducted,
        dto.balanceDue,
        dto.paymentMethod.toUpperCase(),
      ]
        .map(csvEscape)
        .join(',');
    });

    const csv = [headers.map(csvEscape).join(','), ...rows].join('\r\n');
    const filename = `Leadsetu-GSTR1-Tally-${new Date().toISOString().slice(0, 10)}.csv`;

    await this.auditService?.record({
      tenantId: auth.tenantId,
      actorId: auth.userId,
      actorEmail: auth.email,
      action: 'invoice.gstr1_exported',
      entityType: 'invoice',
      entityId: auth.tenantId,
      entityLabel: filename,
      summary: `Exported GSTR-1 / Tally CSV (${docs.length} invoice records)`,
    });

    return {
      filename,
      rowCount: docs.length,
      csv,
    };
  }

  async findOne(auth: { userId: string; tenantId: string }, id: string) {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Invoice not found.');
    }
    const doc = await this.invoiceModel
      .findOne({
        _id: new Types.ObjectId(id),
        tenantId: new Types.ObjectId(auth.tenantId),
      })
      .exec();
    if (!doc) throw new NotFoundException('Invoice not found.');
    if (!doc.publicToken) {
      doc.publicToken = `lsq_${randomBytes(10).toString('hex')}`;
      await this.invoiceModel
        .updateOne({ _id: doc._id }, { $set: { publicToken: doc.publicToken } })
        .exec();
    }
    const maskPhones = this.auditService
      ? await this.auditService.shouldMaskViewerPhones(auth.tenantId, auth.userId)
      : false;
    return this.toDto(doc, maskPhones);
  }

  async create(
    auth: { userId: string; tenantId: string },
    dto: CreateInvoiceDto,
  ) {
    if (!dto.clientName?.trim()) {
      throw new BadRequestException('Client / company name is required.');
    }
    if (!Array.isArray(dto.items) || dto.items.length === 0) {
      throw new BadRequestException(
        'At least one invoice line item is required.',
      );
    }

    const docType = dto.docType || 'tax_invoice';
    const prefix = docType === 'proforma_quote' ? 'QTN-2026' : 'INV-2026';
    const count = await this.invoiceModel.countDocuments({
      tenantId: new Types.ObjectId(auth.tenantId),
    });
    const generatedNumber =
      dto.invoiceNumber?.trim() ||
      `${prefix}-${String(1001 + count).padStart(4, '0')}`;

    const placeOfSupply = dto.placeOfSupply?.trim() || '09 - Uttar Pradesh';
    // Auto-detect taxType from placeOfSupply if not explicitly set:
    // Noida HQ is 09 (Uttar Pradesh) -> intra-state CGST+SGST, else IGST
    const taxType: 'cgst_sgst' | 'igst' =
      dto.taxType ||
      (placeOfSupply.startsWith('09') ? 'cgst_sgst' : 'igst');

    const computed = this.computeTotals(
      dto.items,
      dto.discount ?? 0,
      dto.gstRate ?? 18,
      taxType,
    );

    const status = dto.status || 'sent';
    const paymentMethod =
      status === 'paid' && (!dto.paymentMethod || dto.paymentMethod === 'unpaid')
        ? 'razorpay'
        : dto.paymentMethod || 'unpaid';

    const initialPayments: InvoicePaymentRecord[] =
      status === 'paid' && computed.grandTotal > 0
        ? [
            {
              id: `pay-${Date.now()}-${randomBytes(3).toString('hex')}`,
              amountPaid: computed.grandTotal,
              tdsDeducted: 0,
              totalSettled: computed.grandTotal,
              paymentMode:
                paymentMethod === 'upi'
                  ? 'UPI'
                  : paymentMethod === 'neft_rtgs'
                    ? 'NEFT'
                    : 'Razorpay',
              utrOrChequeNo: `FULL-${generatedNumber}`,
              paymentDate: new Date().toISOString().slice(0, 10),
              note: 'Settled in full',
              recordedAt: new Date().toISOString(),
            },
          ]
        : [];

    const initialAmountPaid = status === 'paid' ? computed.grandTotal : 0;
    const initialBalanceDue = status === 'paid' ? 0 : computed.grandTotal;

    const slugCode = generatedNumber.toLowerCase().replace(/[^a-z0-9]/g, '');
    const paymentLink = `https://rzp.io/i/leadsetu-${slugCode}`;

    const defaultDue = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);

    const doc = await this.invoiceModel.create({
      tenantId: new Types.ObjectId(auth.tenantId),
      ownerId: new Types.ObjectId(auth.userId),
      invoiceNumber: generatedNumber,
      docType,
      clientName: dto.clientName.trim(),
      contactPerson: dto.contactPerson?.trim() || '',
      phone: dto.phone?.trim() || '',
      email: dto.email?.trim().toLowerCase() || '',
      gstin: dto.gstin?.trim().toUpperCase() || '',
      placeOfSupply,
      taxType,
      gstRate: computed.gstRate,
      items: computed.items,
      subTotal: computed.subTotal,
      discount: computed.discount,
      taxableAmount: computed.taxableAmount,
      cgstAmount: computed.cgstAmount,
      sgstAmount: computed.sgstAmount,
      igstAmount: computed.igstAmount,
      gstAmount: computed.gstAmount,
      grandTotal: computed.grandTotal,
      amountPaid: initialAmountPaid,
      tdsDeducted: 0,
      balanceDue: initialBalanceDue,
      payments: initialPayments,
      status,
      paymentMethod,
      paymentLink,
      dueDate: dto.dueDate?.trim() || defaultDue,
      notes:
        dto.notes?.trim() ||
        'Goods/Services supplied from Noida Electronic City, Uttar Pradesh. Subject to Noida Jurisdiction.',
      linkedDealId: dto.linkedDealId?.trim() || '',
      linkedLeadId: dto.linkedLeadId?.trim() || '',
      publicToken: `lsq_${randomBytes(10).toString('hex')}`,
      quoteApprovalStatus: 'pending',
    });

    await this.auditService?.record({
      tenantId: auth.tenantId,
      actorId: auth.userId,
      action: 'invoice.created',
      entityType: 'invoice',
      entityId: doc._id.toString(),
      entityLabel: `${doc.invoiceNumber} · ${doc.clientName}`,
      summary: `Generated ${doc.docType === 'proforma_quote' ? 'Proforma Quotation' : 'GST Tax Invoice'} ${doc.invoiceNumber} for ₹${doc.grandTotal.toLocaleString('en-IN')}`,
    });

    return this.toDto(doc);
  }

  async update(
    auth: { userId: string; tenantId: string },
    id: string,
    dto: Partial<CreateInvoiceDto>,
  ) {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Invoice not found.');
    }
    const doc = await this.invoiceModel
      .findOne({
        _id: new Types.ObjectId(id),
        tenantId: new Types.ObjectId(auth.tenantId),
      })
      .exec();
    if (!doc) throw new NotFoundException('Invoice not found.');

    if (dto.clientName !== undefined) doc.clientName = dto.clientName.trim();
    if (dto.docType !== undefined) doc.docType = dto.docType;
    if (dto.contactPerson !== undefined)
      doc.contactPerson = dto.contactPerson.trim();
    if (dto.phone !== undefined) doc.phone = dto.phone.trim();
    if (dto.email !== undefined) doc.email = dto.email.trim().toLowerCase();
    if (dto.gstin !== undefined) doc.gstin = dto.gstin.trim().toUpperCase();
    if (dto.placeOfSupply !== undefined)
      doc.placeOfSupply = dto.placeOfSupply.trim();
    if (dto.status !== undefined) doc.status = dto.status;
    if (dto.paymentMethod !== undefined) doc.paymentMethod = dto.paymentMethod;
    if (dto.dueDate !== undefined) doc.dueDate = dto.dueDate.trim();
    if (dto.notes !== undefined) doc.notes = dto.notes.trim();

    if (
      dto.items !== undefined ||
      dto.discount !== undefined ||
      dto.gstRate !== undefined ||
      dto.taxType !== undefined ||
      dto.placeOfSupply !== undefined
    ) {
      const nextTaxType =
        dto.taxType ||
        (doc.placeOfSupply.startsWith('09') ? 'cgst_sgst' : 'igst');
      const computed = this.computeTotals(
        dto.items ?? doc.items,
        dto.discount ?? doc.discount,
        dto.gstRate ?? doc.gstRate,
        nextTaxType,
      );
      doc.taxType = nextTaxType;
      doc.gstRate = computed.gstRate;
      doc.items = computed.items;
      doc.subTotal = computed.subTotal;
      doc.discount = computed.discount;
      doc.taxableAmount = computed.taxableAmount;
      doc.cgstAmount = computed.cgstAmount;
      doc.sgstAmount = computed.sgstAmount;
      doc.igstAmount = computed.igstAmount;
      doc.gstAmount = computed.gstAmount;
      doc.grandTotal = computed.grandTotal;
    }

    await doc.save();
    const maskPhones = this.auditService
      ? await this.auditService.shouldMaskViewerPhones(auth.tenantId, auth.userId)
      : false;
    return this.toDto(doc, maskPhones);
  }

  async markPaid(
    auth: { userId: string; tenantId: string },
    id: string,
    dto: MarkInvoicePaidDto,
  ) {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Invoice not found.');
    }
    const doc = await this.invoiceModel
      .findOne({
        _id: new Types.ObjectId(id),
        tenantId: new Types.ObjectId(auth.tenantId),
      })
      .exec();
    if (!doc) throw new NotFoundException('Invoice not found.');

    const current = this.computeSettlement(doc);
    if (current.balanceDue > 0) {
      const modeMap: Record<string, 'UPI' | 'NEFT' | 'Razorpay'> = {
        upi: 'UPI',
        neft_rtgs: 'NEFT',
        razorpay: 'Razorpay',
      };
      const paymentMode =
        modeMap[dto.paymentMethod || 'razorpay'] || 'Razorpay';
      doc.payments = [
        ...(Array.isArray(doc.payments) ? doc.payments : []),
        {
          id: `pay-${Date.now()}-${randomBytes(3).toString('hex')}`,
          amountPaid: current.balanceDue,
          tdsDeducted: 0,
          totalSettled: current.balanceDue,
          paymentMode,
          utrOrChequeNo: `FULL-${doc.invoiceNumber}`,
          paymentDate: new Date().toISOString().slice(0, 10),
          note:
            current.totalSettled > 0
              ? 'Final balance settled in full'
              : 'Marked Paid in full',
          recordedAt: new Date().toISOString(),
        },
      ];
    }

    const updated = this.computeSettlement(doc);
    doc.amountPaid = updated.amountPaid;
    doc.tdsDeducted = updated.tdsDeducted;
    doc.balanceDue = 0;
    doc.status = 'paid';
    doc.paymentMethod = dto.paymentMethod || 'razorpay';
    await doc.save();
    await this.auditService?.record({
      tenantId: auth.tenantId,
      actorId: auth.userId,
      action: 'invoice.marked_paid',
      entityType: 'invoice',
      entityId: doc._id.toString(),
      entityLabel: `${doc.invoiceNumber} · ${doc.clientName}`,
      summary: `Marked ${doc.invoiceNumber} (₹${doc.grandTotal.toLocaleString('en-IN')}) as PAID via ${doc.paymentMethod.toUpperCase()}`,
    });

    const maskPhones = this.auditService
      ? await this.auditService.shouldMaskViewerPhones(auth.tenantId, auth.userId)
      : false;
    return this.toDto(doc, maskPhones);
  }

  async recordPayment(
    auth: { userId: string; tenantId: string },
    id: string,
    dto: RecordInvoicePaymentDto,
  ) {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Invoice not found.');
    }
    const doc = await this.invoiceModel
      .findOne({
        _id: new Types.ObjectId(id),
        tenantId: new Types.ObjectId(auth.tenantId),
      })
      .exec();
    if (!doc) throw new NotFoundException('Invoice not found.');
    if (doc.status === 'cancelled') {
      throw new BadRequestException(
        'Cannot record payment on a cancelled invoice.',
      );
    }

    const current = this.computeSettlement(doc);
    if (current.balanceDue <= 0) {
      throw new BadRequestException(
        'This invoice has already been settled in full (Balance Due is ₹0).',
      );
    }

    const amountPaid = Math.max(0, Math.round(Number(dto.amountPaid) || 0));
    const tdsDeducted = Math.max(0, Math.round(Number(dto.tdsDeducted) || 0));
    const totalSettled = amountPaid + tdsDeducted;

    if (totalSettled <= 0) {
      throw new BadRequestException(
        'Enter Amount Paid and/or TDS Deducted greater than ₹0.',
      );
    }
    if (totalSettled > current.balanceDue) {
      throw new BadRequestException(
        `Amount + TDS (₹${totalSettled.toLocaleString('en-IN')}) exceeds remaining Balance Due (₹${current.balanceDue.toLocaleString('en-IN')}).`,
      );
    }

    const allowedModes = [
      'UPI',
      'NEFT',
      'RTGS',
      'Cheque',
      'Razorpay',
      'Cash',
    ] as const;
    const paymentMode = allowedModes.includes(dto.paymentMode)
      ? dto.paymentMode
      : 'NEFT';

    const entry: InvoicePaymentRecord = {
      id: `pay-${Date.now()}-${randomBytes(3).toString('hex')}`,
      amountPaid,
      tdsDeducted,
      totalSettled,
      paymentMode,
      utrOrChequeNo: String(dto.utrOrChequeNo || '').trim(),
      paymentDate:
        String(dto.paymentDate || '').trim() ||
        new Date().toISOString().slice(0, 10),
      note: String(dto.note || '').trim(),
      recordedAt: new Date().toISOString(),
    };

    doc.payments = [...(Array.isArray(doc.payments) ? doc.payments : []), entry];
    const next = this.computeSettlement(doc);
    doc.amountPaid = next.amountPaid;
    doc.tdsDeducted = next.tdsDeducted;
    doc.balanceDue = next.balanceDue;
    doc.status = next.balanceDue <= 0 ? 'paid' : 'partial';
    doc.paymentMethod =
      paymentMode === 'UPI'
        ? 'upi'
        : paymentMode === 'Razorpay'
          ? 'razorpay'
          : 'neft_rtgs';

    await doc.save();

    await this.auditService?.record({
      tenantId: auth.tenantId,
      actorId: auth.userId,
      action: 'invoice.payment_recorded',
      entityType: 'invoice',
      entityId: doc._id.toString(),
      entityLabel: `${doc.invoiceNumber} · ${doc.clientName}`,
      summary: `Recorded ${paymentMode} payment ₹${amountPaid.toLocaleString('en-IN')}${
        tdsDeducted > 0
          ? ` + TDS ₹${tdsDeducted.toLocaleString('en-IN')}`
          : ''
      }${entry.utrOrChequeNo ? ` (${entry.utrOrChequeNo})` : ''} on ${doc.invoiceNumber}. Balance due: ₹${next.balanceDue.toLocaleString('en-IN')}`,
    });

    const maskPhones = this.auditService
      ? await this.auditService.shouldMaskViewerPhones(auth.tenantId, auth.userId)
      : false;
    return this.toDto(doc, maskPhones);
  }

  async deletePayment(
    auth: { userId: string; tenantId: string },
    id: string,
    paymentId: string,
  ) {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Invoice not found.');
    }
    const doc = await this.invoiceModel
      .findOne({
        _id: new Types.ObjectId(id),
        tenantId: new Types.ObjectId(auth.tenantId),
      })
      .exec();
    if (!doc) throw new NotFoundException('Invoice not found.');

    const existing = Array.isArray(doc.payments) ? doc.payments : [];
    const target = existing.find((p) => p.id === paymentId);
    if (!target) {
      throw new NotFoundException('Payment ledger entry not found.');
    }

    doc.payments = existing.filter((p) => p.id !== paymentId);
    const next = this.computeSettlement(doc);
    doc.amountPaid = next.amountPaid;
    doc.tdsDeducted = next.tdsDeducted;
    doc.balanceDue = next.balanceDue;
    doc.status =
      next.balanceDue <= 0
        ? 'paid'
        : next.totalSettled > 0
          ? 'partial'
          : 'sent';
    if (next.totalSettled === 0) {
      doc.paymentMethod = 'unpaid';
    }
    await doc.save();

    await this.auditService?.record({
      tenantId: auth.tenantId,
      actorId: auth.userId,
      action: 'invoice.payment_reversed',
      entityType: 'invoice',
      entityId: doc._id.toString(),
      entityLabel: `${doc.invoiceNumber} · ${doc.clientName}`,
      summary: `Reversed ledger payment ₹${target.amountPaid.toLocaleString('en-IN')} (+ ₹${target.tdsDeducted.toLocaleString('en-IN')} TDS) on ${doc.invoiceNumber}`,
    });

    const maskPhones = this.auditService
      ? await this.auditService.shouldMaskViewerPhones(auth.tenantId, auth.userId)
      : false;
    return this.toDto(doc, maskPhones);
  }

  async convertQuoteToInvoice(
    auth: { userId: string; tenantId: string },
    quoteId: string,
  ) {
    if (!Types.ObjectId.isValid(quoteId)) {
      throw new NotFoundException('Proforma quotation not found.');
    }
    const tenantObjectId = new Types.ObjectId(auth.tenantId);
    const quote = await this.invoiceModel
      .findOne({ _id: new Types.ObjectId(quoteId), tenantId: tenantObjectId })
      .exec();
    if (!quote) throw new NotFoundException('Proforma quotation not found.');

    const maskPhones = this.auditService
      ? await this.auditService.shouldMaskViewerPhones(auth.tenantId, auth.userId)
      : false;

    if (quote.docType !== 'proforma_quote') {
      throw new BadRequestException(
        'Only Proforma Quotations can be converted into a Tax Invoice.',
      );
    }

    if (
      quote.convertedToInvoiceId &&
      Types.ObjectId.isValid(quote.convertedToInvoiceId)
    ) {
      const existingInv = await this.invoiceModel
        .findOne({
          _id: new Types.ObjectId(quote.convertedToInvoiceId),
          tenantId: tenantObjectId,
        })
        .exec();
      if (existingInv) {
        return {
          alreadyConverted: true,
          quote: this.toDto(quote, maskPhones),
          invoice: this.toDto(existingInv, maskPhones),
        };
      }
    }

    const taxCount = await this.invoiceModel.countDocuments({
      tenantId: tenantObjectId,
      docType: 'tax_invoice',
    });
    const invoiceNumber = `INV-2026-${String(1001 + taxCount).padStart(4, '0')}`;
    const slugCode = invoiceNumber.toLowerCase().replace(/[^a-z0-9]/g, '');
    const defaultDue = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);

    const newInvoice = await this.invoiceModel.create({
      tenantId: tenantObjectId,
      ownerId: new Types.ObjectId(auth.userId),
      invoiceNumber,
      docType: 'tax_invoice',
      clientName: quote.clientName,
      contactPerson: quote.contactPerson,
      phone: quote.phone,
      email: quote.email,
      gstin: quote.gstin,
      placeOfSupply: quote.placeOfSupply,
      taxType: quote.taxType,
      gstRate: quote.gstRate,
      items: quote.items,
      subTotal: quote.subTotal,
      discount: quote.discount,
      taxableAmount: quote.taxableAmount,
      cgstAmount: quote.cgstAmount,
      sgstAmount: quote.sgstAmount,
      igstAmount: quote.igstAmount,
      gstAmount: quote.gstAmount,
      grandTotal: quote.grandTotal,
      status: 'sent',
      paymentMethod: 'unpaid',
      paymentLink: `https://rzp.io/i/leadsetu-${slugCode}`,
      dueDate: defaultDue,
      notes: `${quote.notes}\nConverted from Proforma Quotation ${quote.invoiceNumber}.`.trim(),
      linkedDealId: quote.linkedDealId,
      linkedLeadId: quote.linkedLeadId,
      publicToken: `lsq_${randomBytes(10).toString('hex')}`,
      quoteApprovalStatus: quote.quoteApprovalStatus || 'approved',
      approvedByName: quote.approvedByName || '',
      approvedAt: quote.approvedAt || '',
      convertedFromQuoteId: quote._id.toString(),
    });

    quote.convertedToInvoiceId = newInvoice._id.toString();
    await quote.save();

    await this.auditService?.record({
      tenantId: auth.tenantId,
      actorId: auth.userId,
      action: 'invoice.converted_from_quote',
      entityType: 'invoice',
      entityId: newInvoice._id.toString(),
      entityLabel: `${newInvoice.invoiceNumber} ← ${quote.invoiceNumber}`,
      summary: `Converted Proforma Quote ${quote.invoiceNumber} into GST Tax Invoice ${newInvoice.invoiceNumber} (₹${newInvoice.grandTotal.toLocaleString('en-IN')})`,
    });

    return {
      alreadyConverted: false,
      quote: this.toDto(quote, maskPhones),
      invoice: this.toDto(newInvoice, maskPhones),
    };
  }

  async getPublicQuote(token: string) {
    const cleanToken = String(token || '').trim();
    if (!cleanToken) {
      throw new NotFoundException('Shareable quotation token is required.');
    }
    const doc = await this.invoiceModel.findOne({ publicToken: cleanToken }).exec();
    if (!doc) {
      throw new NotFoundException('Quotation or invoice link is invalid or expired.');
    }

    const tenant = await this.invoiceModel.db
      ?.collection('tenants')
      .findOne({ _id: doc.tenantId });

    const aging = this.computeAging(doc.status || 'sent', doc.dueDate);
    return {
      id: doc._id.toString(),
      invoiceNumber: doc.invoiceNumber,
      docType: doc.docType || 'tax_invoice',
      clientName: doc.clientName,
      contactPerson: doc.contactPerson || '',
      gstin: doc.gstin || '',
      placeOfSupply: doc.placeOfSupply || '09 - Uttar Pradesh',
      taxType: doc.taxType || 'cgst_sgst',
      gstRate: doc.gstRate ?? 18,
      items: doc.items || [],
      subTotal: doc.subTotal || 0,
      discount: doc.discount || 0,
      taxableAmount: doc.taxableAmount || 0,
      cgstAmount: doc.cgstAmount || 0,
      sgstAmount: doc.sgstAmount || 0,
      igstAmount: doc.igstAmount || 0,
      gstAmount: doc.gstAmount || 0,
      grandTotal: doc.grandTotal || 0,
      status: doc.status || 'sent',
      daysOverdue: aging.daysOverdue,
      paymentLink: doc.paymentLink || '',
      dueDate: doc.dueDate || '',
      notes: doc.notes || '',
      publicToken: doc.publicToken || '',
      quoteApprovalStatus: doc.quoteApprovalStatus || 'pending',
      approvedByName: doc.approvedByName || '',
      approvedAt: doc.approvedAt || '',
      convertedToInvoiceId: doc.convertedToInvoiceId || '',
      sellerName: String(tenant?.name || 'Leadsetu Technologies Pvt. Ltd.'),
      sellerCity: String(tenant?.city || 'Noida Electronic City, UP'),
      createdAt: (doc as unknown as { createdAt?: Date }).createdAt
        ? new Date((doc as unknown as { createdAt: Date }).createdAt).toISOString()
        : new Date().toISOString(),
    };
  }

  async respondToPublicQuote(
    token: string,
    body: {
      decision: 'approved' | 'changes_requested';
      buyerName?: string;
      remark?: string;
    },
  ) {
    const cleanToken = String(token || '').trim();
    const doc = await this.invoiceModel.findOne({ publicToken: cleanToken }).exec();
    if (!doc) {
      throw new NotFoundException('Quotation link not found.');
    }

    const decision =
      body?.decision === 'changes_requested' ? 'changes_requested' : 'approved';
    const buyerName =
      String(body?.buyerName || '').trim() ||
      doc.contactPerson ||
      doc.clientName;
    const remark = String(body?.remark || '').trim();
    const nowIso = new Date().toISOString();

    doc.quoteApprovalStatus = decision;
    doc.approvedByName = buyerName;
    doc.approvedAt = nowIso;
    if (remark) {
      doc.notes = `${doc.notes ? `${doc.notes}\n` : ''}[Buyer Feedback - ${buyerName}]: ${remark}`;
    }
    await doc.save();

    // Update linked deal activity if connected
    if (doc.linkedDealId && Types.ObjectId.isValid(doc.linkedDealId)) {
      try {
        await this.invoiceModel.db?.collection('deals').updateOne(
          { _id: new Types.ObjectId(doc.linkedDealId), tenantId: doc.tenantId },
          {
            $push: {
              activities: {
                $each: [
                  {
                    id: `act-${Date.now()}`,
                    type: 'quote',
                    description:
                      decision === 'approved'
                        ? `Buyer ${buyerName} APPROVED ${doc.invoiceNumber} (₹${doc.grandTotal.toLocaleString('en-IN')}) via public quote portal.`
                        : `Buyer ${buyerName} requested changes on ${doc.invoiceNumber}${remark ? `: "${remark}"` : '.'}`,
                    authorName: buyerName,
                    createdAt: nowIso,
                  },
                ],
                $position: 0,
              },
            },
          } as Record<string, unknown>,
        );
      } catch {
        // Non-blocking activity sync
      }
    }

    await this.auditService?.record({
      tenantId: doc.tenantId.toString(),
      actorId: doc.ownerId.toString(),
      actorName: buyerName,
      actorRole: 'buyer_portal',
      action:
        decision === 'approved'
          ? 'quote.buyer_approved'
          : 'quote.changes_requested',
      entityType: 'invoice',
      entityId: doc._id.toString(),
      entityLabel: `${doc.invoiceNumber} · ${doc.clientName}`,
      summary:
        decision === 'approved'
          ? `Buyer ${buyerName} approved quote ${doc.invoiceNumber} (₹${doc.grandTotal.toLocaleString('en-IN')})`
          : `Buyer ${buyerName} requested revision on ${doc.invoiceNumber}`,
    });

    return this.getPublicQuote(cleanToken);
  }

  async remove(auth: { userId: string; tenantId: string }, id: string) {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Invoice not found.');
    }
    const doc = await this.invoiceModel
      .findOneAndDelete({
        _id: new Types.ObjectId(id),
        tenantId: new Types.ObjectId(auth.tenantId),
      })
      .exec();
    if (doc) {
      await this.auditService?.record({
        tenantId: auth.tenantId,
        actorId: auth.userId,
        action: 'invoice.deleted',
        entityType: 'invoice',
        entityId: id,
        entityLabel: `${doc.invoiceNumber} · ${doc.clientName}`,
        summary: `Deleted invoice ${doc.invoiceNumber}`,
      });
    }
    return { success: true, id };
  }

  async seedSamples(auth: { userId: string; tenantId: string }) {
    const samples: CreateInvoiceDto[] = [
      {
        invoiceNumber: 'INV-2026-1001',
        docType: 'tax_invoice',
        clientName: 'Malhotra Luxury Interiors Pvt. Ltd.',
        contactPerson: 'Priya Malhotra',
        phone: '+91 98180 23451',
        email: 'priya@malhotrainteriors.com',
        gstin: '09AAECM5678G1Z2',
        placeOfSupply: '09 - Uttar Pradesh',
        taxType: 'cgst_sgst',
        gstRate: 18,
        status: 'paid',
        paymentMethod: 'razorpay',
        dueDate: '2026-11-15',
        items: [
          {
            description: 'Modular Acoustic Office Workstations (Cluster of 24)',
            hsnSac: '940330',
            quantity: 2,
            unitPrice: 140000,
          },
          {
            description: 'On-site Installation & Commissioning (Noida Sector 62)',
            hsnSac: '998314',
            quantity: 1,
            unitPrice: 35000,
          },
        ],
        notes: 'Paid in full via Razorpay Corporate Netbanking. Dispatched from Noida Electronic City.',
      },
      {
        invoiceNumber: 'INV-2026-1002',
        docType: 'tax_invoice',
        clientName: 'RS Electricals & Switchgear Pvt. Ltd.',
        contactPerson: 'Rajesh Sharma',
        phone: '+91 98112 45678',
        email: 'rajesh@rselectricals.in',
        gstin: '07AABCR1234F1Z5',
        placeOfSupply: '07 - Delhi',
        taxType: 'igst',
        gstRate: 18,
        status: 'sent',
        paymentMethod: 'unpaid',
        dueDate: '2026-11-20',
        items: [
          {
            description: 'Three-Phase Industrial Servo Voltage Stabilizer 150 KVA',
            hsnSac: '850440',
            quantity: 2,
            unitPrice: 225000,
          },
        ],
        notes: 'Inter-state supply from Noida (UP) to Karol Bagh (New Delhi). 18% IGST applicable.',
      },
      {
        invoiceNumber: 'QTN-2026-1003',
        docType: 'proforma_quote',
        clientName: 'Apex Auto Components Ltd.',
        contactPerson: 'Vikramjit Singh',
        phone: '+91 99104 88712',
        email: 'vikram@apexauto.in',
        gstin: '06AABCA9012H1Z8',
        placeOfSupply: '06 - Haryana',
        taxType: 'igst',
        gstRate: 18,
        status: 'sent',
        paymentMethod: 'unpaid',
        dueDate: '2026-11-25',
        items: [
          {
            description: 'Annual Enterprise AMC + IoT Energy Telemetry Sensors',
            hsnSac: '998313',
            quantity: 4,
            unitPrice: 155000,
          },
        ],
        discount: 20000,
        notes: 'Proforma Quotation valid for 15 days. 50% advance required to release purchase order.',
      },
      {
        invoiceNumber: 'INV-2026-1004',
        docType: 'tax_invoice',
        clientName: 'Bansal Steel & Infra Projects',
        contactPerson: 'Sandeep Bansal',
        phone: '+91 98711 65090',
        email: 'sandeep@bansalinfra.in',
        gstin: '07AABCB3456J1Z1',
        placeOfSupply: '07 - Delhi',
        taxType: 'igst',
        gstRate: 18,
        status: 'overdue',
        paymentMethod: 'unpaid',
        dueDate: '2026-11-05',
        items: [
          {
            description: 'Heavy Duty LT Power Distribution Panel Board (Okhla Site)',
            hsnSac: '853710',
            quantity: 1,
            unitPrice: 380000,
          },
        ],
        notes: 'Credit period expired. Automated WhatsApp reminder triggered via Leadsetu AI.',
      },
    ];

    const created = [];
    for (const s of samples) {
      const inv = await this.create(auth, s);
      if (s.invoiceNumber === 'INV-2026-1002') {
        const withPartial = await this.recordPayment(auth, inv.id, {
          amountPaid: 150000,
          tdsDeducted: 9000,
          paymentMode: 'NEFT',
          utrOrChequeNo: 'HDFCR520261114009812',
          paymentDate: new Date().toISOString().slice(0, 10),
          note: '30% Advance + 2% TDS u/s 194C deducted by buyer',
        });
        created.push(withPartial);
      } else {
        created.push(inv);
      }
    }
    return { count: created.length, data: created };
  }
}

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

  @Post('seed')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Seed 4 sample Delhi-NCR / Noida B2B GST Invoices & Proforma Quotations with HSN codes',
  })
  @ApiResponse({ status: 201, description: '4 sample GST invoices created.' })
  async seed(@Headers('authorization') authorization: string | undefined) {
    const auth = await this.invoicesService.verifyAuth(authorization);
    return this.invoicesService.seedSamples(auth);
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

  @Get('public/:token')
  @ApiOperation({
    summary: 'Public buyer quotation view by shareable token (no auth required)',
  })
  async getPublicQuote(@Param('token') token: string) {
    return this.invoicesService.getPublicQuote(token);
  }

  @Post('public/:token/respond')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Buyer public quote decision (Approve Quote or Request Revision)',
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
  })
  async convertToInvoice(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
  ) {
    const auth = await this.invoicesService.verifyAuth(authorization);
    return this.invoicesService.convertQuoteToInvoice(auth, id);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get a single GST Invoice or Proforma Quotation by ID',
  })
  @ApiParam({
    name: 'id',
    description: 'MongoDB ObjectId of the invoice',
    example: '672e1a2b3c4d5e6f7a8b9c0d',
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
    description: 'MongoDB ObjectId of the invoice',
    example: '672e1a2b3c4d5e6f7a8b9c0d',
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
  })
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
  })
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
    description: 'MongoDB ObjectId of the invoice',
    example: '672e1a2b3c4d5e6f7a8b9c0d',
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

  @Delete(':id')
  @ApiOperation({
    summary: 'Delete a GST Invoice or Proforma Quotation',
  })
  @ApiParam({
    name: 'id',
    description: 'MongoDB ObjectId of the invoice',
    example: '672e1a2b3c4d5e6f7a8b9c0d',
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

@Module({
  imports: [
    ConfigModule,
    MongooseModule.forFeature([{ name: Invoice.name, schema: InvoiceSchema }]),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret:
          config.get<string>('JWT_SECRET') ||
          'leadsetu_super_secret_access_key_2026_delhi_ncr',
      }),
    }),
  ],
  controllers: [InvoicesController],
  providers: [InvoicesService],
  exports: [InvoicesService],
})
export class InvoicesModule {}
