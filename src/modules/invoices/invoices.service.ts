import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import {
  InjectModel,
  Prop,
  Schema,
  SchemaFactory,
} from '@nestjs/mongoose';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { HydratedDocument, Model, Types } from 'mongoose';
import { randomBytes } from 'crypto';
import { AuditService } from '../audit/audit.service';
import { maskPhoneNumber, resolveOwnerScopeFilter } from '../auth/identity.util';
import { SuperAdminService } from '../super-admin/super-admin.service';
import { AiBridgeService } from '../ai-bridge/ai-bridge.service';
import {
  ApplyBankMatchDto,
  BankStatementReconcileDto,
  CreateInvoiceDto,
  InvoiceLineItemDto,
  MarkInvoicePaidDto,
  RecordInvoicePaymentDto,
  RecordPromiseToPayDto,
  SendRecoveryChaserDto,
  UpdateRecoveryConfigDto,
} from './dto/invoices.dto';

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

@Schema({ _id: false })
export class InvoiceChaserRecord {
  @Prop({ required: true, trim: true })
  id!: string;

  @Prop({ trim: true, default: 'day_7_firm' })
  stage!: string;

  @Prop({ trim: true, default: 'whatsapp' })
  channel!: string;

  @Prop({ trim: true, default: '' })
  message!: string;

  @Prop({ trim: true, default: '' })
  upiLink!: string;

  @Prop({ trim: true, default: 'Admin' })
  sentBy!: string;

  @Prop({ trim: true, default: '' })
  sentAt!: string;
}

export const InvoiceChaserRecordSchema =
  SchemaFactory.createForClass(InvoiceChaserRecord);

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

  @Prop({
    default: 'none',
    enum: ['none', 'day_3_polite', 'day_7_firm', 'day_15_urgent', 'day_30_hold'],
  })
  chaserStage!: 'none' | 'day_3_polite' | 'day_7_firm' | 'day_15_urgent' | 'day_30_hold';

  @Prop({ trim: true, default: '' })
  lastChaserSentAt!: string;

  @Prop({ type: Number, default: 0 })
  chaserCount!: number;

  @Prop({ type: [InvoiceChaserRecordSchema], default: [] })
  chaserHistory!: InvoiceChaserRecord[];

  @Prop({ trim: true, default: '' })
  promisedPaymentDate!: string;

  @Prop({ type: Number, default: 0 })
  promisedAmount!: number;

  @Prop({ trim: true, default: '' })
  ptpNote!: string;

  @Prop({ trim: true, default: '' })
  ptpUpdatedAt!: string;

  @Prop({ trim: true, default: '' })
  creditOverrideBy!: string;

  @Prop({ trim: true, default: '' })
  creditOverrideReason!: string;
}

export const InvoiceSchema = SchemaFactory.createForClass(Invoice);

@Injectable()
export class InvoicesService {
  constructor(
    @InjectModel(Invoice.name)
    private readonly invoiceModel: Model<InvoiceDocument>,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    @Optional() private readonly auditService?: AuditService,
    @Optional() private readonly superAdminService?: SuperAdminService,
    @Optional() private readonly aiBridge?: AiBridgeService,
  ) {}

  async verifyAuth(authHeader?: string) {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Authorization token is required.');
    }
    const token = authHeader.slice(7).trim();
    const secret =
      this.configService.get<string>('JWT_SECRET') ||
      'leadsetu_super_secret_access_key_2026_delhi_ncr';
    let payload: { sub: string; tenantId: string; email: string };
    try {
      payload = await this.jwtService.verifyAsync<{
        sub: string;
        tenantId: string;
        email: string;
      }>(token, { secret });
    } catch {
      throw new UnauthorizedException('Invalid or expired session.');
    }
    await this.superAdminService?.assertFeatureEnabled(
      payload.tenantId,
      'gstBilling',
    );
    return {
      userId: payload.sub,
      tenantId: payload.tenantId,
      email: payload.email,
    };
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

    const todayIso = new Date().toISOString().slice(0, 10);
    const isPtpBroken = Boolean(
      doc.promisedPaymentDate &&
        settlement.balanceDue > 0 &&
        doc.promisedPaymentDate < todayIso,
    );

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
      chaserStage: doc.chaserStage || 'none',
      lastChaserSentAt: doc.lastChaserSentAt || '',
      chaserCount: Number(doc.chaserCount) || 0,
      chaserHistory: Array.isArray(doc.chaserHistory) ? doc.chaserHistory : [],
      promisedPaymentDate: doc.promisedPaymentDate || '',
      promisedAmount: Number(doc.promisedAmount) || 0,
      ptpNote: doc.ptpNote || '',
      ptpUpdatedAt: doc.ptpUpdatedAt || '',
      isPtpBroken,
      creditOverrideBy: doc.creditOverrideBy || '',
      creditOverrideReason: doc.creditOverrideReason || '',
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
    const ownerScope = await resolveOwnerScopeFilter(this.invoiceModel.db, auth);
    const filter: Record<string, unknown> = {
      tenantId: tenantObjectId,
      ...ownerScope,
    };

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
      this.invoiceModel.find({ tenantId: tenantObjectId, ...ownerScope }).exec(),
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

    const ownerScope = await resolveOwnerScopeFilter(this.invoiceModel.db, auth);
    const docs = await this.invoiceModel
      .find({ tenantId: new Types.ObjectId(auth.tenantId), ...ownerScope })
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
    const ownerScope = await resolveOwnerScopeFilter(this.invoiceModel.db, auth);
    const doc = await this.invoiceModel
      .findOne({
        _id: new Types.ObjectId(id),
        tenantId: new Types.ObjectId(auth.tenantId),
        ...ownerScope,
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

  private async getTenantRecoveryConfig(tenantId: string) {
    const tenant = Types.ObjectId.isValid(tenantId)
      ? await this.invoiceModel.db
          ?.collection('tenants')
          .findOne({ _id: new Types.ObjectId(tenantId) })
      : null;
    const saved = (tenant?.creditRecoveryConfig || {}) as Record<string, unknown>;
    return {
      upiId: String(saved.upiId || 'leadsetu.b2b@icici'),
      merchantName: String(
        saved.merchantName || tenant?.name || 'Leadsetu Technologies Pvt. Ltd.',
      ),
      autoChasersEnabled: saved.autoChasersEnabled !== false,
      autoHoldAfterDays: Number(saved.autoHoldAfterDays ?? 30),
      bankAccountNote: String(
        saved.bankAccountNote ||
          'HDFC Current A/c 50200084112901 · IFSC HDFC0000412 (Noida Sec 62)',
      ),
    };
  }

  private buildUpiLink(
    upiId: string,
    merchantName: string,
    invoiceNumber: string,
    amountInr: number,
  ) {
    const pa = encodeURIComponent(upiId.trim() || 'leadsetu.b2b@icici');
    const pn = encodeURIComponent(merchantName.trim() || 'Leadsetu B2B');
    const tn = encodeURIComponent(`Invoice ${invoiceNumber}`);
    const am = Math.max(1, Math.round(amountInr)).toFixed(2);
    return `upi://pay?pa=${pa}&pn=${pn}&tn=${tn}&am=${am}&cu=INR`;
  }

  private async findMatchingBuyerContact(
    tenantId: string,
    clientName: string,
    gstin?: string,
    ownerScope: Record<string, unknown> = {},
  ) {
    const db = this.invoiceModel.db;
    if (!db || !Types.ObjectId.isValid(tenantId)) return null;
    const tenantOid = new Types.ObjectId(tenantId);
    const cleanGstin = String(gstin || '').trim().toUpperCase();
    if (cleanGstin) {
      const byGstin = await db
        .collection('contacts')
        .findOne({ tenantId: tenantOid, ...ownerScope, gstin: cleanGstin });
      if (byGstin) return byGstin;
    }
    const cleanName = String(clientName || '').trim();
    if (!cleanName) return null;
    const escaped = cleanName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rx = new RegExp(`^${escaped}$`, 'i');
    return db.collection('contacts').findOne({
      tenantId: tenantOid,
      ...ownerScope,
      $or: [{ company: rx }, { name: rx }],
    });
  }

  private async assertBuyerCreditEligibility(
    auth: { userId: string; tenantId: string },
    params: {
      clientName: string;
      gstin?: string;
      newAmount: number;
      status?: string;
      overrideCreditHold?: boolean;
      overrideReason?: string;
    },
  ): Promise<{ creditTermDays: number; overrideActorName: string }> {
    const ownerScope = await resolveOwnerScopeFilter(this.invoiceModel.db, auth);
    const contact = await this.findMatchingBuyerContact(
      auth.tenantId,
      params.clientName,
      params.gstin,
      ownerScope,
    );
    const creditTermDays = Number(contact?.creditTermDays ?? 15);
    if (params.status === 'paid' || params.status === 'draft') {
      return { creditTermDays, overrideActorName: '' };
    }

    const db = this.invoiceModel.db;
    const tenantOid = new Types.ObjectId(auth.tenantId);
    const cleanGstin = String(params.gstin || contact?.gstin || '')
      .trim()
      .toUpperCase();
    const cleanName = String(params.clientName || '').trim();
    const orFilter: Record<string, unknown>[] = [];
    if (cleanGstin) orFilter.push({ gstin: cleanGstin });
    if (cleanName) {
      const escaped = cleanName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      orFilter.push({ clientName: new RegExp(`^${escaped}$`, 'i') });
    }

    const openInvoices =
      orFilter.length > 0
        ? await this.invoiceModel
            .find({
              tenantId: tenantOid,
              ...ownerScope,
              docType: { $ne: 'proforma_quote' },
              status: { $nin: ['paid', 'cancelled'] },
              $or: orFilter,
            })
            .exec()
        : [];

    let openReceivable = 0;
    let maxOverdueDays = 0;
    for (const inv of openInvoices) {
      const st = this.computeSettlement(inv);
      if (st.balanceDue <= 0) continue;
      openReceivable += st.balanceDue;
      const aging = this.computeAging(inv.status, inv.dueDate);
      if (aging.daysOverdue > maxOverdueDays) {
        maxOverdueDays = aging.daysOverdue;
      }
    }

    const config = await this.getTenantRecoveryConfig(auth.tenantId);
    const creditLimit = Math.max(0, Number(contact?.creditLimitInr) || 0);
    const onHold = Boolean(contact?.creditHold);
    const exceedsLimit =
      creditLimit > 0 && openReceivable + params.newAmount > creditLimit;
    const severeOverdue =
      config.autoHoldAfterDays > 0 &&
      maxOverdueDays >= config.autoHoldAfterDays;

    if (!onHold && !exceedsLimit && !severeOverdue) {
      return { creditTermDays, overrideActorName: '' };
    }

    const reasons: string[] = [];
    if (onHold) {
      reasons.push(
        `Buyer is on CREDIT HOLD${contact?.creditHoldReason ? ` (${contact.creditHoldReason})` : ''}`,
      );
    }
    if (exceedsLimit) {
      reasons.push(
        `Open balance ₹${openReceivable.toLocaleString('en-IN')} + new ₹${params.newAmount.toLocaleString('en-IN')} exceeds approved credit limit ₹${creditLimit.toLocaleString('en-IN')}`,
      );
    }
    if (severeOverdue) {
      reasons.push(
        `Buyer has unpaid invoice overdue by ${maxOverdueDays} days (auto-hold threshold: ${config.autoHoldAfterDays}d)`,
      );
    }

    if (params.overrideCreditHold) {
      const viewer =
        db && Types.ObjectId.isValid(auth.userId)
          ? await db.collection('users').findOne({
              _id: new Types.ObjectId(auth.userId),
              tenantId: tenantOid,
            })
          : null;
      const role = String(viewer?.role || '').toLowerCase();
      if (!['owner', 'admin', 'super_admin', 'manager'].includes(role)) {
        throw new ForbiddenException(
          `CREDIT_GUARDRAIL_OVERRIDE_DENIED: ${reasons.join('; ')}. Only Admin/Owner/Manager can override Credit Hold.`,
        );
      }
      if (!params.overrideReason?.trim()) {
        throw new BadRequestException(
          'Enter an audit override reason to bypass the B2B Credit Hold / Limit guardrail.',
        );
      }
      return {
        creditTermDays,
        overrideActorName: String(viewer?.name || viewer?.email || 'Admin'),
      };
    }

    throw new ForbiddenException(
      `CREDIT_GUARDRAIL: ${reasons.join(' · ')}. Collect overdue payment or enable Admin Override with a reason.`,
    );
  }

  async create(
    auth: { userId: string; tenantId: string },
    dto: CreateInvoiceDto,
    options?: { skipCreditGuardrail?: boolean },
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

    let creditCheck = { creditTermDays: 15, overrideActorName: '' };
    if (!options?.skipCreditGuardrail) {
      creditCheck = await this.assertBuyerCreditEligibility(auth, {
        clientName: dto.clientName.trim(),
        gstin: dto.gstin,
        newAmount: docType === 'proforma_quote' ? 0 : computed.grandTotal,
        status,
        overrideCreditHold: dto.overrideCreditHold,
        overrideReason: dto.overrideReason,
      });
    }

    const defaultDue = new Date(
      Date.now() + Math.max(0, creditCheck.creditTermDays || 15) * 24 * 60 * 60 * 1000,
    )
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
      creditOverrideBy: creditCheck.overrideActorName || '',
      creditOverrideReason: creditCheck.overrideActorName
        ? dto.overrideReason?.trim() || ''
        : '',
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
    const ownerScope = await resolveOwnerScopeFilter(this.invoiceModel.db, auth);
    const doc = await this.invoiceModel
      .findOne({
        _id: new Types.ObjectId(id),
        tenantId: new Types.ObjectId(auth.tenantId),
        ...ownerScope,
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
    const ownerScope = await resolveOwnerScopeFilter(this.invoiceModel.db, auth);
    const doc = await this.invoiceModel
      .findOne({
        _id: new Types.ObjectId(id),
        tenantId: new Types.ObjectId(auth.tenantId),
        ...ownerScope,
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
    const ownerScope = await resolveOwnerScopeFilter(this.invoiceModel.db, auth);
    const doc = await this.invoiceModel
      .findOne({
        _id: new Types.ObjectId(id),
        tenantId: new Types.ObjectId(auth.tenantId),
        ...ownerScope,
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
    const ownerScope = await resolveOwnerScopeFilter(this.invoiceModel.db, auth);
    const doc = await this.invoiceModel
      .findOne({
        _id: new Types.ObjectId(id),
        tenantId: new Types.ObjectId(auth.tenantId),
        ...ownerScope,
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
    override?: { overrideCreditHold?: boolean; overrideReason?: string },
  ) {
    if (!Types.ObjectId.isValid(quoteId)) {
      throw new NotFoundException('Proforma quotation not found.');
    }
    const tenantObjectId = new Types.ObjectId(auth.tenantId);
    const ownerScope = await resolveOwnerScopeFilter(this.invoiceModel.db, auth);
    const quote = await this.invoiceModel
      .findOne({
        _id: new Types.ObjectId(quoteId),
        tenantId: tenantObjectId,
        ...ownerScope,
      })
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

    const creditCheck = await this.assertBuyerCreditEligibility(auth, {
      clientName: quote.clientName,
      gstin: quote.gstin,
      newAmount: quote.grandTotal || 0,
      status: 'sent',
      overrideCreditHold: override?.overrideCreditHold,
      overrideReason: override?.overrideReason,
    });

    const taxCount = await this.invoiceModel.countDocuments({
      tenantId: tenantObjectId,
      docType: 'tax_invoice',
    });
    const invoiceNumber = `INV-2026-${String(1001 + taxCount).padStart(4, '0')}`;
    const slugCode = invoiceNumber.toLowerCase().replace(/[^a-z0-9]/g, '');
    const defaultDue = new Date(
      Date.now() + Math.max(0, creditCheck.creditTermDays || 15) * 24 * 60 * 60 * 1000,
    )
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
      amountPaid: 0,
      tdsDeducted: 0,
      balanceDue: quote.grandTotal,
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
      creditOverrideBy: creditCheck.overrideActorName || '',
      creditOverrideReason: creditCheck.overrideActorName
        ? override?.overrideReason?.trim() || ''
        : '',
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
    const ownerScope = await resolveOwnerScopeFilter(this.invoiceModel.db, auth);
    const doc = await this.invoiceModel
      .findOneAndDelete({
        _id: new Types.ObjectId(id),
        tenantId: new Types.ObjectId(auth.tenantId),
        ...ownerScope,
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

  private composeChaserMessage(params: {
    invoiceNumber: string;
    clientName: string;
    contactPerson?: string;
    balanceDue: number;
    daysOverdue: number;
    dueDate?: string;
    tone: 'polite' | 'firm' | 'urgent' | 'final_hold';
    language: 'hinglish' | 'hindi' | 'english';
    upiLink: string;
    paymentLink: string;
    bankAccountNote: string;
  }) {
    const greetingName =
      params.contactPerson?.trim() || params.clientName || 'Sir/Ma’am';
    const amt = `₹${Math.round(params.balanceDue).toLocaleString('en-IN')}`;
    const dueLabel = params.dueDate || 'due date';

    if (params.language === 'english') {
      const opener =
        params.tone === 'polite'
          ? `Hello ${greetingName}, gentle reminder for Invoice ${params.invoiceNumber} (${amt}), due on ${dueLabel}.`
          : params.tone === 'firm'
            ? `Hello ${greetingName}, Invoice ${params.invoiceNumber} for ${amt} is overdue by ${params.daysOverdue} days (due ${dueLabel}). Kindly release NEFT/UPI today.`
            : params.tone === 'urgent'
              ? `Urgent Accounts Notice (${greetingName}): Invoice ${params.invoiceNumber} (${amt}) is ${params.daysOverdue} days overdue. Please clear immediately to keep dispatch uninterrupted.`
              : `FINAL CREDIT HOLD NOTICE (${greetingName}): ${amt} against ${params.invoiceNumber} is overdue by ${params.daysOverdue} days. New quotations/dispatches are paused until settlement.`;

      return `${opener}\nPay via UPI/Card: ${params.paymentLink}\nUPI Deep Link: ${params.upiLink}\nBank NEFT: ${params.bankAccountNote}`;
    }

    const openerHinglish =
      params.tone === 'polite'
        ? `Namaste ${greetingName} ji, Invoice ${params.invoiceNumber} ka ${amt} balance due (${dueLabel}) ka gentle reminder.`
        : params.tone === 'firm'
          ? `Namaste ${greetingName} ji, Invoice ${params.invoiceNumber} ka ${amt} payment ${params.daysOverdue} din overdue ho gaya hai (due ${dueLabel}). Please aaj NEFT/UPI release karwa dijiye.`
          : params.tone === 'urgent'
            ? `Urgent Reminder ${greetingName} ji: ${params.clientName} ka Invoice ${params.invoiceNumber} (${amt}) ${params.daysOverdue} din se pending hai. Next dispatch smooth rakhne ke liye aaj settlement kar dein.`
            : `FINAL CREDIT HOLD ALERT (${greetingName} ji): ${params.clientName} ka ${amt} (${params.invoiceNumber}) ${params.daysOverdue} din overdue hai. Settlement hone tak naye quotes aur dispatch Credit Hold par rahenge.`;

    return `${openerHinglish}\nInstant Pay Link: ${params.paymentLink}\nUPI App: ${params.upiLink}\nNEFT/RTGS: ${params.bankAccountNote}`;
  }

  async getRecoveryOverview(auth: { userId: string; tenantId: string }) {
    const tenantOid = new Types.ObjectId(auth.tenantId);
    const db = this.invoiceModel.db;
    const ownerScope = await resolveOwnerScopeFilter(db, auth);
    const [invoices, contacts, recoveryConfig, maskPhones] = await Promise.all([
      this.invoiceModel.find({ tenantId: tenantOid, ...ownerScope }).sort({ createdAt: -1 }).exec(),
      db
        ? db
            .collection('contacts')
            .find({ tenantId: tenantOid, ...ownerScope })
            .sort({ createdAt: -1 })
            .toArray()
        : Promise.resolve([]),
      this.getTenantRecoveryConfig(auth.tenantId),
      this.auditService
        ? this.auditService.shouldMaskViewerPhones(auth.tenantId, auth.userId)
        : Promise.resolve(false),
    ]);

    const dtos = invoices.map((d) => this.toDto(d, maskPhones));
    const activeTaxInvoices = dtos.filter(
      (i) => i.docType !== 'proforma_quote' && i.status !== 'cancelled',
    );
    const openInvoices = activeTaxInvoices.filter((i) => i.balanceDue > 0);
    const overdueInvoices = openInvoices.filter(
      (i) => i.status === 'overdue' || (i.daysOverdue ?? 0) > 0,
    );
    const brokenPtps = openInvoices.filter((i) => i.isPtpBroken);
    const activePtps = openInvoices.filter(
      (i) => i.promisedPaymentDate && !i.isPtpBroken,
    );

    const totalInvoiced = activeTaxInvoices.reduce(
      (s, i) => s + (Number(i.grandTotal) || 0),
      0,
    );
    const totalSettled = activeTaxInvoices.reduce(
      (s, i) => s + (Number(i.totalSettled) || 0),
      0,
    );
    const totalOpenUdhaar = openInvoices.reduce(
      (s, i) => s + (Number(i.balanceDue) || 0),
      0,
    );
    const overdueUdhaar = overdueInvoices.reduce(
      (s, i) => s + (Number(i.balanceDue) || 0),
      0,
    );

    // Build unified Buyer Credit Risk Ledger across contacts & invoice parties
    type LedgerRow = {
      contactId: string;
      buyerName: string;
      contactPerson: string;
      phone: string;
      gstin: string;
      gstinStatus: string;
      creditLimitInr: number;
      creditTermDays: number;
      creditHold: boolean;
      creditHoldReason: string;
      openBalanceInr: number;
      overdueBalanceInr: number;
      maxOverdueDays: number;
      openInvoicesCount: number;
      utilizationPct: number;
      riskLevel: 'hold' | 'critical' | 'warning' | 'healthy';
    };

    const contactByGstin = new Map<string, Record<string, unknown>>();
    const contactByName = new Map<string, Record<string, unknown>>();
    const ledgerMap = new Map<string, LedgerRow>();

    for (const c of contacts) {
      const id = String(c._id);
      const gst = String(c.gstin || '').trim().toUpperCase();
      const buyerName = String(c.company || c.name || '').trim();
      const rowKey = gst || buyerName.toLowerCase() || id;
      if (gst) contactByGstin.set(gst, c);
      if (buyerName) contactByName.set(buyerName.toLowerCase(), c);
      if (c.name) contactByName.set(String(c.name).trim().toLowerCase(), c);

      ledgerMap.set(rowKey, {
        contactId: id,
        buyerName: buyerName || String(c.name || 'Buyer'),
        contactPerson: String(c.name || ''),
        phone: maskPhones
          ? maskPhoneNumber(String(c.phone || ''))
          : String(c.phone || ''),
        gstin: gst,
        gstinStatus: String(c.gstinStatus || (gst ? 'unverified' : 'unverified')),
        creditLimitInr: Math.max(0, Number(c.creditLimitInr) || 0),
        creditTermDays: Number(c.creditTermDays ?? 15),
        creditHold: Boolean(c.creditHold),
        creditHoldReason: String(c.creditHoldReason || ''),
        openBalanceInr: 0,
        overdueBalanceInr: 0,
        maxOverdueDays: 0,
        openInvoicesCount: 0,
        utilizationPct: 0,
        riskLevel: c.creditHold ? 'hold' : 'healthy',
      });
    }

    for (const inv of openInvoices) {
      const gst = String(inv.gstin || '').trim().toUpperCase();
      const matchedContact =
        (gst && contactByGstin.get(gst)) ||
        contactByName.get(inv.clientName.trim().toLowerCase());
      const matchedGst = String(matchedContact?.gstin || gst).trim().toUpperCase();
      const matchedName = String(
        matchedContact?.company || matchedContact?.name || inv.clientName,
      ).trim();
      const rowKey = matchedGst || matchedName.toLowerCase();

      if (!ledgerMap.has(rowKey)) {
        ledgerMap.set(rowKey, {
          contactId: matchedContact ? String(matchedContact._id) : '',
          buyerName: matchedName,
          contactPerson: inv.contactPerson || '',
          phone: inv.phone || '',
          gstin: matchedGst,
          gstinStatus: String(matchedContact?.gstinStatus || 'unverified'),
          creditLimitInr: Math.max(0, Number(matchedContact?.creditLimitInr) || 0),
          creditTermDays: Number(matchedContact?.creditTermDays ?? 15),
          creditHold: Boolean(matchedContact?.creditHold),
          creditHoldReason: String(matchedContact?.creditHoldReason || ''),
          openBalanceInr: 0,
          overdueBalanceInr: 0,
          maxOverdueDays: 0,
          openInvoicesCount: 0,
          utilizationPct: 0,
          riskLevel: matchedContact?.creditHold ? 'hold' : 'healthy',
        });
      }

      const row = ledgerMap.get(rowKey)!;
      row.openBalanceInr += inv.balanceDue;
      row.openInvoicesCount += 1;
      const days = Number(inv.daysOverdue) || 0;
      if (days > 0 || inv.status === 'overdue') {
        row.overdueBalanceInr += inv.balanceDue;
        if (days > row.maxOverdueDays) row.maxOverdueDays = days;
      }
    }

    const creditRiskLedger = Array.from(ledgerMap.values())
      .map((r) => {
        const utilizationPct =
          r.creditLimitInr > 0
            ? Math.round((r.openBalanceInr / r.creditLimitInr) * 100)
            : 0;
        let riskLevel: LedgerRow['riskLevel'] = 'healthy';
        if (r.creditHold) {
          riskLevel = 'hold';
        } else if (
          r.maxOverdueDays >= recoveryConfig.autoHoldAfterDays ||
          utilizationPct >= 100
        ) {
          riskLevel = 'critical';
        } else if (r.overdueBalanceInr > 0 || utilizationPct >= 80) {
          riskLevel = 'warning';
        }
        return { ...r, utilizationPct, riskLevel };
      })
      .sort(
        (a, b) =>
          b.overdueBalanceInr - a.overdueBalanceInr ||
          b.openBalanceInr - a.openBalanceInr,
      );

    return {
      kpis: {
        totalOpenUdhaar,
        overdueUdhaar,
        overdueCount: overdueInvoices.length,
        brokenPromisesCount: brokenPtps.length,
        activePromisesCount: activePtps.length,
        blockedAccountsCount: creditRiskLedger.filter((r) => r.creditHold).length,
        recoveryRatePct:
          totalInvoiced > 0
            ? Math.round((totalSettled / totalInvoiced) * 100)
            : 100,
      },
      recoveryConfig,
      creditRiskLedger,
      overdueQueue: overdueInvoices.map((i) => ({
        ...i,
        upiLink: this.buildUpiLink(
          recoveryConfig.upiId,
          recoveryConfig.merchantName,
          i.invoiceNumber,
          i.balanceDue,
        ),
      })),
      promisesQueue: [...brokenPtps, ...activePtps],
    };
  }

  async updateRecoveryConfig(
    auth: { userId: string; tenantId: string },
    dto: UpdateRecoveryConfigDto,
  ) {
    const tenantOid = new Types.ObjectId(auth.tenantId);
    const db = this.invoiceModel.db;
    if (db && Types.ObjectId.isValid(auth.userId)) {
      const viewer = await db.collection('users').findOne({
        _id: new Types.ObjectId(auth.userId),
        tenantId: tenantOid,
      });
      const role = String(viewer?.role || '').toLowerCase();
      if (!['owner', 'admin', 'super_admin', 'manager'].includes(role)) {
        throw new ForbiddenException(
          'Only Workspace Admin/Owner can update Udhaar Recovery & UPI settings.',
        );
      }
    }

    const current = await this.getTenantRecoveryConfig(auth.tenantId);
    const nextConfig = {
      upiId: dto.upiId !== undefined ? dto.upiId.trim() : current.upiId,
      merchantName:
        dto.merchantName !== undefined
          ? dto.merchantName.trim()
          : current.merchantName,
      autoChasersEnabled:
        dto.autoChasersEnabled !== undefined
          ? Boolean(dto.autoChasersEnabled)
          : current.autoChasersEnabled,
      autoHoldAfterDays:
        dto.autoHoldAfterDays !== undefined
          ? Math.max(1, Math.min(180, Number(dto.autoHoldAfterDays) || 30))
          : current.autoHoldAfterDays,
      bankAccountNote:
        dto.bankAccountNote !== undefined
          ? dto.bankAccountNote.trim()
          : current.bankAccountNote,
    };

    await db
      ?.collection('tenants')
      .updateOne(
        { _id: tenantOid },
        { $set: { creditRecoveryConfig: nextConfig } },
      );

    await this.auditService?.record({
      tenantId: auth.tenantId,
      actorId: auth.userId,
      action: 'invoice.recovery_config_updated',
      entityType: 'invoice',
      entityId: auth.tenantId,
      entityLabel: nextConfig.upiId,
      summary: `Updated Udhaar recovery policy: UPI ${nextConfig.upiId}, Auto-hold at ${nextConfig.autoHoldAfterDays} overdue days`,
    });

    return nextConfig;
  }

  async recordPromiseToPay(
    auth: { userId: string; tenantId: string },
    id: string,
    dto: RecordPromiseToPayDto,
  ) {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Invoice not found.');
    }
    const ownerScope = await resolveOwnerScopeFilter(this.invoiceModel.db, auth);
    const doc = await this.invoiceModel
      .findOne({
        _id: new Types.ObjectId(id),
        tenantId: new Types.ObjectId(auth.tenantId),
        ...ownerScope,
      })
      .exec();
    if (!doc) throw new NotFoundException('Invoice not found.');

    const settlement = this.computeSettlement(doc);
    doc.promisedPaymentDate = String(dto.promisedPaymentDate || '').trim();
    doc.promisedAmount = Math.max(
      0,
      Math.round(Number(dto.promisedAmount ?? settlement.balanceDue) || 0),
    );
    doc.ptpNote = String(dto.ptpNote || '').trim();
    doc.ptpUpdatedAt = new Date().toISOString();
    await doc.save();

    await this.auditService?.record({
      tenantId: auth.tenantId,
      actorId: auth.userId,
      action: 'invoice.ptp_recorded',
      entityType: 'invoice',
      entityId: doc._id.toString(),
      entityLabel: `${doc.invoiceNumber} · ${doc.clientName}`,
      summary: `Logged Promise-to-Pay ₹${doc.promisedAmount.toLocaleString('en-IN')} by ${doc.promisedPaymentDate} on ${doc.invoiceNumber}`,
    });

    const maskPhones = this.auditService
      ? await this.auditService.shouldMaskViewerPhones(auth.tenantId, auth.userId)
      : false;
    return this.toDto(doc, maskPhones);
  }

  async sendRecoveryChaser(
    auth: { userId: string; tenantId: string },
    id: string,
    dto: SendRecoveryChaserDto,
  ) {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Invoice not found.');
    }
    const ownerScope = await resolveOwnerScopeFilter(this.invoiceModel.db, auth);
    const doc = await this.invoiceModel
      .findOne({
        _id: new Types.ObjectId(id),
        tenantId: new Types.ObjectId(auth.tenantId),
        ...ownerScope,
      })
      .exec();
    if (!doc) throw new NotFoundException('Invoice not found.');

    const settlement = this.computeSettlement(doc);
    if (settlement.balanceDue <= 0) {
      throw new BadRequestException('Invoice has ₹0 balance due.');
    }

    await this.superAdminService?.consumeTenantQuota(
      auth.tenantId,
      'whatsapp',
      1,
    );

    const config = await this.getTenantRecoveryConfig(auth.tenantId);
    const aging = this.computeAging(doc.status, doc.dueDate);
    const autoTone: 'polite' | 'firm' | 'urgent' | 'final_hold' =
      aging.daysOverdue >= config.autoHoldAfterDays
        ? 'final_hold'
        : aging.daysOverdue >= 15
          ? 'urgent'
          : aging.daysOverdue >= 5
            ? 'firm'
            : 'polite';
    const tone = dto.tone || autoTone;
    const language = dto.language || 'hinglish';
    const upiLink = this.buildUpiLink(
      config.upiId,
      config.merchantName,
      doc.invoiceNumber,
      settlement.balanceDue,
    );

    const aiToneMap: Record<
      'polite' | 'firm' | 'urgent' | 'final_hold',
      'gentle' | 'firm' | 'overdue_alert' | 'final_warning'
    > = {
      polite: 'gentle',
      firm: 'firm',
      urgent: 'overdue_alert',
      final_hold: 'final_warning',
    };

    let message = dto.customMessage?.trim() || '';
    if (!message && this.aiBridge) {
      const aiDraft = await this.aiBridge.draftUdhaarReminder({
        tenantId: auth.tenantId,
        userId: auth.userId,
        context: {
          dealerName: doc.clientName,
          contactPerson: doc.contactPerson,
          invoiceNumber: doc.invoiceNumber,
          overdueInr: settlement.balanceDue,
          overdueDays: aging.daysOverdue,
          tone: aiToneMap[tone],
          language,
          paymentLink: upiLink || doc.paymentLink || '',
          companyName: config.merchantName,
        },
      });
      if (aiDraft?.result?.trim()) {
        message = aiDraft.result.trim();
      }
    }

    if (!message) {
      message = this.composeChaserMessage({
        invoiceNumber: doc.invoiceNumber,
        clientName: doc.clientName,
        contactPerson: doc.contactPerson,
        balanceDue: settlement.balanceDue,
        daysOverdue: aging.daysOverdue,
        dueDate: doc.dueDate,
        tone,
        language,
        upiLink,
        paymentLink: doc.paymentLink || '',
        bankAccountNote: config.bankAccountNote,
      });
    }

    const stageMap: Record<
      'polite' | 'firm' | 'urgent' | 'final_hold',
      Invoice['chaserStage']
    > = {
      polite: 'day_3_polite',
      firm: 'day_7_firm',
      urgent: 'day_15_urgent',
      final_hold: 'day_30_hold',
    };

    const viewer = Types.ObjectId.isValid(auth.userId)
      ? await this.invoiceModel.db
          ?.collection('users')
          .findOne({ _id: new Types.ObjectId(auth.userId) })
      : null;
    const sentBy = String(viewer?.name || viewer?.email || 'Accounts Team');
    const nowIso = new Date().toISOString();

    doc.chaserStage = stageMap[tone];
    doc.lastChaserSentAt = nowIso;
    doc.chaserCount = (Number(doc.chaserCount) || 0) + 1;
    doc.chaserHistory = [
      {
        id: `chs-${Date.now()}-${randomBytes(3).toString('hex')}`,
        stage: doc.chaserStage,
        channel: 'whatsapp',
        message,
        upiLink,
        sentBy,
        sentAt: nowIso,
      },
      ...(Array.isArray(doc.chaserHistory) ? doc.chaserHistory : []),
    ].slice(0, 20);
    await doc.save();

    // Push into buyer's Unified WhatsApp Inbox thread if phone matches
    const cleanDigits = String(doc.phone || '').replace(/\D/g, '').slice(-10);
    if (cleanDigits.length >= 10 && this.invoiceModel.db) {
      try {
        await this.invoiceModel.db.collection('conversations').updateOne(
          {
            tenantId: new Types.ObjectId(auth.tenantId),
            phone: { $regex: cleanDigits },
          },
          {
            $set: {
              lastMessage: message.slice(0, 140),
              lastMessageAt: nowIso,
            },
            $push: {
              messages: {
                id: `msg-${Date.now()}-${randomBytes(3).toString('hex')}`,
                direction: 'outbound',
                content: message,
                senderName: `${sentBy} (Udhaar Bot)`,
                status: 'delivered',
                isAiDrafted: true,
                createdAt: nowIso,
              },
            },
          } as Record<string, unknown>,
        );
      } catch {
        // Non-blocking inbox log
      }
    }

    await this.auditService?.record({
      tenantId: auth.tenantId,
      actorId: auth.userId,
      action: 'invoice.chaser_sent',
      entityType: 'invoice',
      entityId: doc._id.toString(),
      entityLabel: `${doc.invoiceNumber} · ${doc.clientName}`,
      summary: `Sent ${tone.toUpperCase()} WhatsApp + UPI Udhaar chaser on ${doc.invoiceNumber} for ₹${settlement.balanceDue.toLocaleString('en-IN')}`,
    });

    const maskPhones = this.auditService
      ? await this.auditService.shouldMaskViewerPhones(auth.tenantId, auth.userId)
      : false;
    return {
      invoice: this.toDto(doc, maskPhones),
      chaserMessage: message,
      upiLink,
    };
  }

  async runBatchChasers(auth: { userId: string; tenantId: string }) {
    const tenantOid = new Types.ObjectId(auth.tenantId);
    const ownerScope = await resolveOwnerScopeFilter(this.invoiceModel.db, auth);
    const config = await this.getTenantRecoveryConfig(auth.tenantId);
    const openDocs = await this.invoiceModel
      .find({
        tenantId: tenantOid,
        ...ownerScope,
        docType: { $ne: 'proforma_quote' },
        status: { $nin: ['paid', 'cancelled'] },
      })
      .exec();

    const cutoffMs = Date.now() - 24 * 60 * 60 * 1000;
    let sentCount = 0;
    let autoHoldCount = 0;
    const processed: string[] = [];

    for (const doc of openDocs) {
      if (sentCount >= 25) break;
      const st = this.computeSettlement(doc);
      if (st.balanceDue <= 0) continue;
      const aging = this.computeAging(doc.status, doc.dueDate);
      if (aging.daysOverdue <= 0) continue;

      if (doc.lastChaserSentAt) {
        const lastMs = new Date(doc.lastChaserSentAt).getTime();
        if (Number.isFinite(lastMs) && lastMs > cutoffMs) {
          continue;
        }
      }

      await this.sendRecoveryChaser(auth, doc._id.toString(), {
        language: 'hinglish',
      });
      sentCount += 1;
      processed.push(doc.invoiceNumber);

      if (aging.daysOverdue >= config.autoHoldAfterDays) {
        const contact = await this.findMatchingBuyerContact(
          auth.tenantId,
          doc.clientName,
          doc.gstin,
        );
        if (contact && !contact.creditHold && this.invoiceModel.db) {
          await this.invoiceModel.db.collection('contacts').updateOne(
            { _id: contact._id },
            {
              $set: {
                creditHold: true,
                creditHoldReason: `Auto-Hold: Invoice ${doc.invoiceNumber} overdue ${aging.daysOverdue} days`,
              },
            },
          );
          autoHoldCount += 1;
        }
      }
    }

    return {
      sentCount,
      autoHoldCount,
      processedInvoices: processed,
    };
  }

  async exportTallyXml(auth: { userId: string; tenantId: string; email: string }) {
    const db = this.invoiceModel.db;
    const tenantOid = new Types.ObjectId(auth.tenantId);
    if (db && Types.ObjectId.isValid(auth.userId)) {
      const [tenant, viewer] = await Promise.all([
        db.collection('tenants').findOne({ _id: tenantOid }),
        db.collection('users').findOne({ _id: new Types.ObjectId(auth.userId) }),
      ]);
      const blockAgent = tenant?.blockAgentExport !== false;
      if (blockAgent && viewer?.role === 'agent') {
        throw new ForbiddenException(
          'TallyPrime XML exports are restricted by your workspace Anti-Data-Leak Shield.',
        );
      }
    }

    const ownerScope = await resolveOwnerScopeFilter(db, auth);
    const docs = await this.invoiceModel
      .find({ tenantId: tenantOid, ...ownerScope, docType: 'tax_invoice', status: { $ne: 'cancelled' } })
      .sort({ createdAt: -1 })
      .exec();

    const xmlEscape = (v: unknown) =>
      String(v ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');

    const tallyDate = (iso?: string) => {
      const clean = String(iso || new Date().toISOString()).slice(0, 10).replace(/-/g, '');
      return /^\d{8}$/.test(clean) ? clean : '20261115';
    };

    const vouchers: string[] = [];
    for (const d of docs) {
      const dto = this.toDto(d, false);
      const vDate = tallyDate(dto.createdAt);
      const party = xmlEscape(dto.clientName);

      // 1) Tally Sales Voucher
      const taxEntries =
        dto.taxType === 'igst'
          ? `<ALLLEDGERENTRIES.LIST><LEDGERNAME>Output IGST</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>${dto.igstAmount.toFixed(2)}</AMOUNT></ALLLEDGERENTRIES.LIST>`
          : `<ALLLEDGERENTRIES.LIST><LEDGERNAME>Output CGST</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>${dto.cgstAmount.toFixed(2)}</AMOUNT></ALLLEDGERENTRIES.LIST><ALLLEDGERENTRIES.LIST><LEDGERNAME>Output SGST</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>${dto.sgstAmount.toFixed(2)}</AMOUNT></ALLLEDGERENTRIES.LIST>`;

      vouchers.push(`
    <TALLYMESSAGE xmlns:UDF="TallyUDF">
      <VOUCHER VCHTYPE="Sales" ACTION="Create">
        <DATE>${vDate}</DATE>
        <VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>
        <VOUCHERNUMBER>${xmlEscape(dto.invoiceNumber)}</VOUCHERNUMBER>
        <PARTYLEDGERNAME>${party}</PARTYLEDGERNAME>
        <PARTYGSTIN>${xmlEscape(dto.gstin || '')}</PARTYGSTIN>
        <NARRATION>${xmlEscape(`Leadsetu GST Sales ${dto.invoiceNumber} · ${dto.placeOfSupply}`)}</NARRATION>
        <ALLLEDGERENTRIES.LIST><LEDGERNAME>${party}</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-${dto.grandTotal.toFixed(2)}</AMOUNT></ALLLEDGERENTRIES.LIST>
        <ALLLEDGERENTRIES.LIST><LEDGERNAME>B2B Sales Account</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>${dto.taxableAmount.toFixed(2)}</AMOUNT></ALLLEDGERENTRIES.LIST>
        ${taxEntries}
      </VOUCHER>
    </TALLYMESSAGE>`);

      // 2) Tally Receipt + TDS Vouchers for recorded settlements
      for (const p of dto.payments || []) {
        const pDate = tallyDate(p.paymentDate || p.recordedAt);
        const bankLedger =
          p.paymentMode === 'Cash'
            ? 'Cash-in-Hand'
            : `Bank Receipt (${p.paymentMode})`;
        const tdsEntry =
          p.tdsDeducted > 0
            ? `<ALLLEDGERENTRIES.LIST><LEDGERNAME>TDS Receivable (Buyer Deducted)</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-${p.tdsDeducted.toFixed(2)}</AMOUNT></ALLLEDGERENTRIES.LIST>`
            : '';

        vouchers.push(`
    <TALLYMESSAGE xmlns:UDF="TallyUDF">
      <VOUCHER VCHTYPE="Receipt" ACTION="Create">
        <DATE>${pDate}</DATE>
        <VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME>
        <VOUCHERNUMBER>${xmlEscape(p.utrOrChequeNo || p.id)}</VOUCHERNUMBER>
        <PARTYLEDGERNAME>${party}</PARTYLEDGERNAME>
        <NARRATION>${xmlEscape(`Receipt against ${dto.invoiceNumber} · ${p.paymentMode} ${p.utrOrChequeNo || ''}`)}</NARRATION>
        <ALLLEDGERENTRIES.LIST><LEDGERNAME>${party}</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>${p.totalSettled.toFixed(2)}</AMOUNT></ALLLEDGERENTRIES.LIST>
        <ALLLEDGERENTRIES.LIST><LEDGERNAME>${xmlEscape(bankLedger)}</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-${p.amountPaid.toFixed(2)}</AMOUNT></ALLLEDGERENTRIES.LIST>
        ${tdsEntry}
      </VOUCHER>
    </TALLYMESSAGE>`);
      }
    }

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME></REQUESTDESC>
      <REQUESTDATA>${vouchers.join('\n')}
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;

    const filename = `Leadsetu-TallyPrime-Vouchers-${new Date().toISOString().slice(0, 10)}.xml`;

    await this.auditService?.record({
      tenantId: auth.tenantId,
      actorId: auth.userId,
      actorEmail: auth.email,
      action: 'invoice.tally_xml_exported',
      entityType: 'invoice',
      entityId: auth.tenantId,
      entityLabel: filename,
      summary: `Exported TallyPrime XML (${docs.length} Sales + Receipt vouchers)`,
    });

    return {
      filename,
      voucherCount: vouchers.length,
      xml,
    };
  }

  async previewBankReconciliation(
    auth: { userId: string; tenantId: string },
    dto: BankStatementReconcileDto,
  ) {
    const entries = Array.isArray(dto?.entries) ? dto.entries : [];
    if (entries.length === 0) {
      throw new BadRequestException('Provide at least one bank statement credit entry.');
    }

    const ownerScope = await resolveOwnerScopeFilter(this.invoiceModel.db, auth);
    const openDocs = await this.invoiceModel
      .find({
        tenantId: new Types.ObjectId(auth.tenantId),
        ...ownerScope,
        docType: { $ne: 'proforma_quote' },
        status: { $nin: ['paid', 'cancelled'] },
      })
      .exec();

    const openDtos = openDocs
      .map((d) => this.toDto(d, false))
      .filter((i) => i.balanceDue > 0);

    const results = entries.map((entry, idx) => {
      const creditAmount = Math.max(0, Math.round(Number(entry.creditAmount) || 0));
      const narrationUpper = String(entry.narration || '').toUpperCase();
      const utrUpper = String(entry.utrOrRef || '').toUpperCase();

      let best: {
        invoice: (typeof openDtos)[number];
        score: number;
        reasons: string[];
        suggestedTds: number;
      } | null = null;

      for (const inv of openDtos) {
        let score = 0;
        const reasons: string[] = [];
        const invNumUpper = inv.invoiceNumber.toUpperCase();
        const words = inv.clientName
          .toUpperCase()
          .split(/\s+/)
          .filter((w) => w.length >= 4 && !['PVT.', 'PVT', 'LTD.', 'LTD', 'INDIA'].includes(w));

        if (narrationUpper.includes(invNumUpper)) {
          score += 55;
          reasons.push(`Narration mentions ${inv.invoiceNumber}`);
        }
        const matchedWords = words.filter((w) => narrationUpper.includes(w));
        if (matchedWords.length > 0) {
          score += Math.min(35, matchedWords.length * 20);
          reasons.push(`Party keyword "${matchedWords[0]}" matched`);
        }

        let suggestedTds = 0;
        if (creditAmount > 0 && creditAmount === inv.balanceDue) {
          score += 45;
          reasons.push('Exact ₹ balance due match');
        } else if (creditAmount > 0 && creditAmount < inv.balanceDue) {
          // Check common 2% or 10% TDS settlement fit
          const tds2 = Math.round(inv.taxableAmount * 0.02);
          const tds10 = Math.round(inv.taxableAmount * 0.1);
          if (Math.abs(inv.balanceDue - creditAmount - tds2) <= 50) {
            score += 40;
            suggestedTds = inv.balanceDue - creditAmount;
            reasons.push('Exact balance minus ~2% TDS');
          } else if (Math.abs(inv.balanceDue - creditAmount - tds10) <= 50) {
            score += 40;
            suggestedTds = inv.balanceDue - creditAmount;
            reasons.push('Exact balance minus ~10% TDS');
          } else if (creditAmount <= inv.balanceDue) {
            score += 15;
            reasons.push('Fits partial installment against open balance');
          }
        }

        if (
          score > 0 &&
          (!best || score > best.score)
        ) {
          best = { invoice: inv, score, reasons, suggestedTds };
        }
      }

      const mode: 'UPI' | 'RTGS' | 'NEFT' = narrationUpper.includes('UPI')
        ? 'UPI'
        : narrationUpper.includes('RTGS')
          ? 'RTGS'
          : 'NEFT';

      const confidence =
        best && best.score >= 70
          ? 'high'
          : best && best.score >= 35
            ? 'medium'
            : 'unmatched';

      return {
        entryId: entry.id || `bnk-${idx + 1}`,
        date: entry.date || new Date().toISOString().slice(0, 10),
        narration: entry.narration || '',
        utrOrRef: entry.utrOrRef || utrUpper,
        creditAmount,
        paymentMode: mode,
        confidence,
        matchedInvoiceId: best && confidence !== 'unmatched' ? best.invoice.id : '',
        matchedInvoiceNumber:
          best && confidence !== 'unmatched' ? best.invoice.invoiceNumber : '',
        matchedClientName:
          best && confidence !== 'unmatched' ? best.invoice.clientName : '',
        openBalanceDue:
          best && confidence !== 'unmatched' ? best.invoice.balanceDue : 0,
        suggestedTds: best && confidence !== 'unmatched' ? best.suggestedTds : 0,
        matchReasons: best ? best.reasons : ['No open invoice match found'],
      };
    });

    return {
      totalEntries: results.length,
      matchedCount: results.filter((r) => r.confidence !== 'unmatched').length,
      results,
    };
  }

  async applyBankMatches(
    auth: { userId: string; tenantId: string },
    dto: ApplyBankMatchDto,
  ) {
    const matches = Array.isArray(dto?.matches) ? dto.matches : [];
    if (matches.length === 0) {
      throw new BadRequestException('Select at least one matched bank receipt to post.');
    }

    const updatedInvoices = [];
    for (const m of matches) {
      if (!m.invoiceId) continue;
      const updated = await this.recordPayment(auth, m.invoiceId, {
        amountPaid: m.amountPaid,
        tdsDeducted: m.tdsDeducted || 0,
        paymentMode: m.paymentMode || 'NEFT',
        utrOrChequeNo: m.utrOrChequeNo,
        paymentDate: m.paymentDate,
        note: m.note || `Auto-reconciled from Bank Statement (${m.utrOrChequeNo})`,
      });
      updatedInvoices.push(updated);
    }

    return {
      settledCount: updatedInvoices.length,
      invoices: updatedInvoices,
    };
  }
}
