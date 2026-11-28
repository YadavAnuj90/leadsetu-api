import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
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
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import axios from 'axios';
import * as QRCode from 'qrcode';
import { AuditService } from '../audit/audit.service';
import {
  maskPhoneNumber,
  normalizeIndianPhone,
  resolveOwnerScopeFilter,
} from '../auth/identity.util';
import { SuperAdminService } from '../super-admin/super-admin.service';
import { resolveEffectiveRazorpayConfig } from '../super-admin/razorpay-config.util';
import { AiBridgeService } from '../ai-bridge/ai-bridge.service';
import { InboxService, extractLast10Digits } from '../inbox/inbox.service';
import { MetaCapiService } from '../meta-capi/meta-capi.service';
import {
  ApplyBankMatchDto,
  BankStatementReconcileDto,
  CreateInvoiceDto,
  CreateWhatsappCartCheckoutDto,
  InvoiceLineItemDto,
  MarkInvoicePaidDto,
  RecordInvoicePaymentDto,
  RecordPromiseToPayDto,
  SendRecoveryChaserDto,
  UpdateInvoiceDispatchDto,
  UpdateRecoveryConfigDto,
  UpdateSellerGstProfileDto,
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

  @Prop({ trim: true, default: '' })
  upiPaymentUri!: string;

  @Prop({ default: '' })
  upiQrDataUrl!: string;

  @Prop({ trim: true, default: '' })
  dispatchCourier!: string;

  @Prop({ trim: true, default: '' })
  dispatchAwbNumber!: string;

  @Prop({ trim: true, default: '' })
  dispatchTrackingUrl!: string;

  @Prop({
    default: 'pending',
    enum: ['pending', 'packed', 'in_transit', 'out_for_delivery', 'delivered'],
  })
  dispatchStatus!: 'pending' | 'packed' | 'in_transit' | 'out_for_delivery' | 'delivered';

  @Prop({ trim: true, default: '' })
  dispatchedAt!: string;

  @Prop({ trim: true, default: '' })
  dispatchNotes!: string;

  @Prop({ trim: true, default: '' })
  dispatchNotifiedAt!: string;
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
    @Optional() private readonly inboxService?: InboxService,
    @Optional() private readonly metaCapiService?: MetaCapiService,
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
      upiPaymentUri: doc.upiPaymentUri || '',
      upiQrDataUrl: doc.upiQrDataUrl || '',
      dispatchCourier: doc.dispatchCourier || '',
      dispatchAwbNumber: doc.dispatchAwbNumber || '',
      dispatchTrackingUrl: doc.dispatchTrackingUrl || '',
      dispatchStatus: doc.dispatchStatus || 'pending',
      dispatchedAt: doc.dispatchedAt || '',
      dispatchNotes: doc.dispatchNotes || '',
      dispatchNotifiedAt: doc.dispatchNotifiedAt || '',
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

  private static readonly GSTIN_REGEX =
    /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

  private extractPosStateCode(raw?: string): string {
    const val = String(raw || '').trim();
    const prefix = val.match(/^(\d{2})/);
    if (prefix) return prefix[1];
    const lower = val.toLowerCase();
    const map: Array<[string, string]> = [
      ['delhi', '07'],
      ['uttar pradesh', '09'],
      ['noida', '09'],
      ['ghaziabad', '09'],
      ['haryana', '06'],
      ['gurugram', '06'],
      ['gurgaon', '06'],
      ['faridabad', '06'],
      ['rajasthan', '08'],
      ['jaipur', '08'],
      ['maharashtra', '27'],
      ['mumbai', '27'],
      ['pune', '27'],
      ['gujarat', '24'],
      ['ahmedabad', '24'],
      ['surat', '24'],
      ['karnataka', '29'],
      ['bengaluru', '29'],
      ['bangalore', '29'],
      ['tamil nadu', '33'],
      ['chennai', '33'],
      ['telangana', '36'],
      ['hyderabad', '36'],
      ['west bengal', '19'],
      ['kolkata', '19'],
      ['punjab', '03'],
      ['madhya pradesh', '23'],
    ];
    for (const [needle, code] of map) {
      if (lower.includes(needle)) return code;
    }
    return '';
  }

  private normalizeMonthParam(month?: string): string {
    const clean = String(month || '').trim();
    return /^\d{4}-\d{2}$/.test(clean) ? clean : 'all';
  }

  private async computeGstr1Dataset(
    auth: { userId: string; tenantId: string; email?: string },
    monthInput?: string,
  ) {
    const db = this.invoiceModel.db;
    const tenantOid = new Types.ObjectId(auth.tenantId);
    const month = this.normalizeMonthParam(monthInput);

    const [tenant, ownerScope] = await Promise.all([
      db.collection('tenants').findOne({ _id: tenantOid }),
      resolveOwnerScopeFilter(db, auth),
    ]);
    const allDocs = await this.invoiceModel
      .find({ tenantId: tenantOid, ...ownerScope })
      .sort({ createdAt: -1 })
      .exec();

    const dtosAll = allDocs.map((d) => this.toDto(d, false));
    const dtosPeriod =
      month === 'all'
        ? dtosAll
        : dtosAll.filter((d) => String(d.createdAt || '').slice(0, 7) === month);

    const taxInvoices = dtosPeriod.filter(
      (d) => d.docType === 'tax_invoice' && d.status !== 'cancelled',
    );
    const cancelledCount = dtosPeriod.filter((d) => d.status === 'cancelled').length;
    const proformaExcludedCount = dtosPeriod.filter(
      (d) => d.docType === 'proforma_quote',
    ).length;

    const sellerGstin = String(tenant?.gstin || '').trim().toUpperCase();
    const sellerCompany = String(
      tenant?.companyName || tenant?.name || 'Leadsetu Workspace',
    ).trim();
    const sellerState = String(tenant?.state || tenant?.city || '09 - Uttar Pradesh').trim();
    const sellerStateCode =
      (sellerGstin && sellerGstin.slice(0, 2)) ||
      this.extractPosStateCode(sellerState) ||
      '09';
    const isSellerGstinValid = InvoicesService.GSTIN_REGEX.test(sellerGstin);

    const b2bInvoices: Array<{
      id: string;
      invoiceNumber: string;
      date: string;
      clientName: string;
      gstin: string;
      placeOfSupply: string;
      posStateCode: string;
      taxType: 'cgst_sgst' | 'igst';
      gstRate: number;
      taxableAmount: number;
      cgstAmount: number;
      sgstAmount: number;
      igstAmount: number;
      gstAmount: number;
      grandTotal: number;
      status: string;
      ewayRequired: boolean;
    }> = [];

    const b2cBucketMap = new Map<
      string,
      {
        bucket: 'B2CL' | 'B2CS';
        placeOfSupply: string;
        posStateCode: string;
        taxType: 'cgst_sgst' | 'igst';
        gstRate: number;
        invoiceCount: number;
        taxableAmount: number;
        cgstAmount: number;
        sgstAmount: number;
        igstAmount: number;
        grandTotal: number;
      }
    >();

    const hsnMap = new Map<
      string,
      {
        hsnSac: string;
        gstRate: number;
        descriptions: string[];
        totalQuantity: number;
        taxableAmount: number;
        cgstAmount: number;
        sgstAmount: number;
        igstAmount: number;
        totalValue: number;
      }
    >();

    const complianceIssues: Array<{
      severity: 'error' | 'warning' | 'info';
      code: string;
      invoiceId?: string;
      invoiceNumber?: string;
      clientName?: string;
      amount?: number;
      message: string;
      recommendation: string;
    }> = [];

    if (!sellerGstin) {
      complianceIssues.push({
        severity: 'error',
        code: 'SELLER_GSTIN_MISSING',
        message: 'Workspace Seller 15-digit GSTIN is not configured yet.',
        recommendation:
          'Add your company GSTIN & State via "Edit Seller GSTIN Profile" before downloading GSTR-1 JSON for GST Portal upload.',
      });
    } else if (!isSellerGstinValid) {
      complianceIssues.push({
        severity: 'error',
        code: 'SELLER_GSTIN_INVALID',
        message: `Workspace Seller GSTIN "${sellerGstin}" does not match 15-character GSTIN format.`,
        recommendation: 'Verify your 15-digit GSTIN in Seller GSTIN Profile.',
      });
    }

    let ewayRequiredCount = 0;

    for (const inv of taxInvoices) {
      const cleanGstin = String(inv.gstin || '').trim().toUpperCase();
      const hasAnyGstin = cleanGstin.length > 0 && cleanGstin !== 'URD';
      const isBuyerGstinValid = hasAnyGstin
        ? InvoicesService.GSTIN_REGEX.test(cleanGstin)
        : false;
      const posCode =
        this.extractPosStateCode(inv.placeOfSupply) || sellerStateCode;

      if (hasAnyGstin && !isBuyerGstinValid) {
        complianceIssues.push({
          severity: 'error',
          code: 'INVALID_BUYER_GSTIN',
          invoiceId: inv.id,
          invoiceNumber: inv.invoiceNumber,
          clientName: inv.clientName,
          amount: inv.grandTotal,
          message: `${inv.invoiceNumber} (${inv.clientName}) has invalid buyer GSTIN "${cleanGstin}".`,
          recommendation: 'Correct the 15-character buyer GSTIN or clear it if unregistered (B2C).',
        });
      }

      if (isBuyerGstinValid && posCode && cleanGstin.slice(0, 2) !== posCode) {
        complianceIssues.push({
          severity: 'warning',
          code: 'GSTIN_POS_MISMATCH',
          invoiceId: inv.id,
          invoiceNumber: inv.invoiceNumber,
          clientName: inv.clientName,
          amount: inv.grandTotal,
          message: `${inv.invoiceNumber}: Buyer GSTIN state (${cleanGstin.slice(0, 2)}) differs from Place of Supply (${inv.placeOfSupply || posCode}).`,
          recommendation:
            'Confirm whether this is a Ship-To different state supply or align Place of Supply with buyer GSTIN.',
        });
      }

      if (sellerStateCode && posCode) {
        const expectedTaxType =
          sellerStateCode === posCode ? 'cgst_sgst' : 'igst';
        if (inv.gstRate > 0 && inv.taxType !== expectedTaxType) {
          complianceIssues.push({
            severity: 'warning',
            code: 'TAX_TYPE_MISMATCH',
            invoiceId: inv.id,
            invoiceNumber: inv.invoiceNumber,
            clientName: inv.clientName,
            amount: inv.grandTotal,
            message: `${inv.invoiceNumber}: Place of Supply (${posCode}) vs Seller State (${sellerStateCode}) expects ${expectedTaxType === 'igst' ? 'IGST' : 'CGST+SGST'}, billed as ${inv.taxType.toUpperCase()}.`,
            recommendation: 'Review intra-state vs inter-state GST rule before GSTR-1 filing.',
          });
        }
      }

      const ewayRequired = inv.grandTotal >= 50000;
      if (ewayRequired) {
        ewayRequiredCount += 1;
        complianceIssues.push({
          severity: 'info',
          code: 'EWAY_BILL_REQUIRED',
          invoiceId: inv.id,
          invoiceNumber: inv.invoiceNumber,
          clientName: inv.clientName,
          amount: inv.grandTotal,
          message: `${inv.invoiceNumber} (₹${inv.grandTotal.toLocaleString('en-IN')}) exceeds ₹50,000 E-Way Bill threshold (Rule 138 CGST).`,
          recommendation:
            'Ensure E-Way Bill Part-A & vehicle number Part-B are generated if physical goods are dispatched.',
        });
      }

      if (isBuyerGstinValid) {
        b2bInvoices.push({
          id: inv.id,
          invoiceNumber: inv.invoiceNumber,
          date: inv.createdAt.slice(0, 10),
          clientName: inv.clientName,
          gstin: cleanGstin,
          placeOfSupply: inv.placeOfSupply || `${posCode} - India`,
          posStateCode: posCode || '09',
          taxType: inv.taxType,
          gstRate: inv.gstRate,
          taxableAmount: inv.taxableAmount,
          cgstAmount: inv.cgstAmount,
          sgstAmount: inv.sgstAmount,
          igstAmount: inv.igstAmount,
          gstAmount: inv.gstAmount,
          grandTotal: inv.grandTotal,
          status: inv.status,
          ewayRequired,
        });
      } else {
        const isB2cl = inv.taxType === 'igst' && inv.grandTotal > 250000;
        const bucket: 'B2CL' | 'B2CS' = isB2cl ? 'B2CL' : 'B2CS';
        const posLabel = inv.placeOfSupply || `${posCode || '09'} - India`;
        const bKey = `${bucket}|${posLabel}|${inv.taxType}|${inv.gstRate}`;
        const cur = b2cBucketMap.get(bKey) || {
          bucket,
          placeOfSupply: posLabel,
          posStateCode: posCode || '09',
          taxType: inv.taxType,
          gstRate: inv.gstRate,
          invoiceCount: 0,
          taxableAmount: 0,
          cgstAmount: 0,
          sgstAmount: 0,
          igstAmount: 0,
          grandTotal: 0,
        };
        cur.invoiceCount += 1;
        cur.taxableAmount = Number((cur.taxableAmount + inv.taxableAmount).toFixed(2));
        cur.cgstAmount = Number((cur.cgstAmount + inv.cgstAmount).toFixed(2));
        cur.sgstAmount = Number((cur.sgstAmount + inv.sgstAmount).toFixed(2));
        cur.igstAmount = Number((cur.igstAmount + inv.igstAmount).toFixed(2));
        cur.grandTotal = Number((cur.grandTotal + inv.grandTotal).toFixed(2));
        b2cBucketMap.set(bKey, cur);
      }

      // HSN/SAC aggregation proportional to taxableAmount (respecting any invoice-level discount)
      const items = Array.isArray(inv.items) && inv.items.length > 0
        ? inv.items
        : [
            {
              description: `${inv.clientName} Supply`,
              hsnSac: '998314',
              quantity: 1,
              unitPrice: inv.taxableAmount,
              amount: inv.taxableAmount,
            },
          ];
      const rawItemsSum = items.reduce(
        (acc, it) => acc + Math.max(0, Number(it.amount || 0)),
        0,
      );
      const scale = rawItemsSum > 0 ? inv.taxableAmount / rawItemsSum : 1;

      for (const item of items) {
        const hsn = String(item.hsnSac || '998314').trim() || '998314';
        const hKey = `${hsn}|${inv.gstRate}`;
        const itemTaxable = Number(
          ((Number(item.amount || 0) || 0) * scale).toFixed(2),
        );
        const itemIgst =
          inv.taxType === 'igst'
            ? Number(((itemTaxable * inv.gstRate) / 100).toFixed(2))
            : 0;
        const itemCgst =
          inv.taxType !== 'igst'
            ? Number(((itemTaxable * (inv.gstRate / 2)) / 100).toFixed(2))
            : 0;
        const itemSgst =
          inv.taxType !== 'igst'
            ? Number(((itemTaxable * (inv.gstRate / 2)) / 100).toFixed(2))
            : 0;
        const curHsn = hsnMap.get(hKey) || {
          hsnSac: hsn,
          gstRate: inv.gstRate,
          descriptions: [],
          totalQuantity: 0,
          taxableAmount: 0,
          cgstAmount: 0,
          sgstAmount: 0,
          igstAmount: 0,
          totalValue: 0,
        };
        if (
          item.description &&
          curHsn.descriptions.length < 3 &&
          !curHsn.descriptions.includes(item.description)
        ) {
          curHsn.descriptions.push(item.description);
        }
        curHsn.totalQuantity += Number(item.quantity || 1);
        curHsn.taxableAmount = Number((curHsn.taxableAmount + itemTaxable).toFixed(2));
        curHsn.cgstAmount = Number((curHsn.cgstAmount + itemCgst).toFixed(2));
        curHsn.sgstAmount = Number((curHsn.sgstAmount + itemSgst).toFixed(2));
        curHsn.igstAmount = Number((curHsn.igstAmount + itemIgst).toFixed(2));
        curHsn.totalValue = Number(
          (
            curHsn.totalValue +
            itemTaxable +
            itemCgst +
            itemSgst +
            itemIgst
          ).toFixed(2),
        );
        hsnMap.set(hKey, curHsn);
      }
    }

    const b2cSummary = Array.from(b2cBucketMap.values());
    const hsnSummary = Array.from(hsnMap.values()).sort(
      (a, b) => b.taxableAmount - a.taxableAmount,
    );

    const b2bTaxable = Number(
      b2bInvoices.reduce((a, r) => a + r.taxableAmount, 0).toFixed(2),
    );
    const b2bTax = Number(
      b2bInvoices.reduce((a, r) => a + r.gstAmount, 0).toFixed(2),
    );
    const b2cTaxable = Number(
      b2cSummary.reduce((a, r) => a + r.taxableAmount, 0).toFixed(2),
    );
    const b2cTax = Number(
      b2cSummary
        .reduce((a, r) => a + r.cgstAmount + r.sgstAmount + r.igstAmount, 0)
        .toFixed(2),
    );

    const criticalIssueCount = complianceIssues.filter(
      (i) => i.severity === 'error' || i.severity === 'warning',
    ).length;
    const complianceScorePct = Math.max(
      0,
      Math.min(100, 100 - criticalIssueCount * 12),
    );

    // Build GST Portal GSTR-1 JSON v1.1 schema
    const refMonth =
      month === 'all' ? new Date().toISOString().slice(0, 7) : month;
    const [yr, mo] = refMonth.split('-');
    const filingPeriodCode = `${mo}${yr}`;

    const portalB2bByCtin = new Map<
      string,
      Array<Record<string, unknown>>
    >();
    for (const inv of b2bInvoices) {
      const ddMMyyyy = `${inv.date.slice(8, 10)}-${inv.date.slice(5, 7)}-${inv.date.slice(0, 4)}`;
      const entry = {
        inum: inv.invoiceNumber,
        idt: ddMMyyyy,
        val: inv.grandTotal,
        pos: inv.posStateCode,
        rchrg: 'N',
        inv_typ: 'R',
        itms: [
          {
            num: 1,
            itm_det: {
              rt: inv.gstRate,
              txval: inv.taxableAmount,
              ...(inv.taxType === 'igst'
                ? { iamt: inv.igstAmount }
                : { camt: inv.cgstAmount, samt: inv.sgstAmount }),
              csamt: 0,
            },
          },
        ],
      };
      const list = portalB2bByCtin.get(inv.gstin) || [];
      list.push(entry);
      portalB2bByCtin.set(inv.gstin, list);
    }

    const portalJson = {
      gstin: sellerGstin || 'UNREGISTERED_SET_IN_SETTINGS',
      fp: filingPeriodCode,
      version: 'GST3.1.6',
      hash: 'hash',
      b2b: Array.from(portalB2bByCtin.entries()).map(([ctin, inv]) => ({
        ctin,
        inv,
      })),
      b2cs: b2cSummary
        .filter((b) => b.bucket === 'B2CS')
        .map((b) => ({
          sply_ty: b.taxType === 'igst' ? 'INTER' : 'INTRA',
          pos: b.posStateCode,
          typ: 'OE',
          rt: b.gstRate,
          txval: b.taxableAmount,
          ...(b.taxType === 'igst'
            ? { iamt: b.igstAmount }
            : { camt: b.cgstAmount, samt: b.sgstAmount }),
          csamt: 0,
        })),
      hsn: {
        data: hsnSummary.map((h, idx) => ({
          num: idx + 1,
          hsn_sc: h.hsnSac,
          desc: h.descriptions[0] || `HSN ${h.hsnSac}`,
          uqc: 'NOS',
          qty: h.totalQuantity,
          rt: h.gstRate,
          txval: h.taxableAmount,
          iamt: h.igstAmount,
          camt: h.cgstAmount,
          samt: h.sgstAmount,
          csamt: 0,
        })),
      },
    };

    return {
      period: {
        month,
        filingPeriodCode,
        label:
          month === 'all'
            ? 'All Periods (FY YTD)'
            : new Date(`${refMonth}-01`).toLocaleString('en-IN', {
                month: 'long',
                year: 'numeric',
              }),
      },
      seller: {
        companyName: sellerCompany,
        gstin: sellerGstin,
        state: sellerState,
        stateCode: sellerStateCode,
        address: String(tenant?.address || ''),
        isSellerGstinValid,
      },
      summary: {
        totalTaxInvoices: taxInvoices.length,
        cancelledCount,
        proformaExcludedCount,
        b2bCount: b2bInvoices.length,
        b2bTaxable,
        b2bTax,
        b2cCount: b2cSummary.reduce((a, b) => a + b.invoiceCount, 0),
        b2cTaxable,
        b2cTax,
        hsnCount: hsnSummary.length,
        ewayRequiredCount,
        issuesCount: criticalIssueCount,
        complianceScorePct,
      },
      b2bInvoices,
      b2cSummary,
      hsnSummary,
      complianceIssues,
      portalJson,
      filteredDocsCount: dtosPeriod.length,
      taxInvoicesDocs: taxInvoices,
      allPeriodDtos: dtosPeriod,
    };
  }

  async getGstr1ComplianceOverview(
    auth: { userId: string; tenantId: string },
    query?: { month?: string },
  ) {
    const dataset = await this.computeGstr1Dataset(auth, query?.month);
    const {
      taxInvoicesDocs: _ignoredTax,
      allPeriodDtos: _ignoredAll,
      ...publicOverview
    } = dataset;
    return publicOverview;
  }

  async updateSellerGstProfile(
    auth: { userId: string; tenantId: string },
    dto: UpdateSellerGstProfileDto,
  ) {
    const db = this.invoiceModel.db;
    const viewer = Types.ObjectId.isValid(auth.userId)
      ? await db.collection('users').findOne({ _id: new Types.ObjectId(auth.userId) })
      : null;
    const role = String(viewer?.role || '').toLowerCase();
    if (!['owner', 'admin', 'super_admin'].includes(role)) {
      throw new ForbiddenException(
        'Only workspace Owners or Admins can update Seller GSTIN & billing state.',
      );
    }

    const updateFields: Record<string, unknown> = {};
    if (dto.companyName !== undefined) {
      updateFields.companyName = String(dto.companyName).trim();
    }
    if (dto.gstin !== undefined) {
      const cleanGstin = String(dto.gstin).trim().toUpperCase();
      if (cleanGstin && !InvoicesService.GSTIN_REGEX.test(cleanGstin)) {
        throw new BadRequestException(
          'Enter a valid 15-character Indian GSTIN (e.g. 09AAACA1234A1Z5).',
        );
      }
      updateFields.gstin = cleanGstin;
    }
    if (dto.state !== undefined) {
      updateFields.state = String(dto.state).trim();
    }
    if (dto.city !== undefined) {
      updateFields.city = String(dto.city).trim();
    }
    if (dto.address !== undefined) {
      updateFields.address = String(dto.address).trim();
    }

    if (Object.keys(updateFields).length > 0) {
      await db.collection('tenants').updateOne(
        { _id: new Types.ObjectId(auth.tenantId) },
        { $set: updateFields },
      );
    }

    return this.getGstr1ComplianceOverview(auth, {});
  }

  async exportGstr1Csv(
    auth: { userId: string; tenantId: string; email: string },
    query?: { month?: string; section?: string },
  ) {
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

    const section = ['b2b', 'b2c', 'hsn'].includes(
      String(query?.section || '').toLowerCase(),
    )
      ? (String(query?.section).toLowerCase() as 'b2b' | 'b2c' | 'hsn')
      : 'all';
    const dataset = await this.computeGstr1Dataset(auth, query?.month);

    const csvEscape = (v: unknown) => {
      const s = String(v ?? '').replace(/"/g, '""');
      return `"${s}"`;
    };

    let headers: string[] = [];
    let rows: string[] = [];
    let rowCount = 0;

    if (section === 'b2b') {
      headers = [
        'GSTIN/UIN of Recipient',
        'Receiver Name',
        'Invoice Number',
        'Invoice Date',
        'Invoice Value (INR)',
        'Place Of Supply',
        'Reverse Charge',
        'Invoice Type',
        'Rate (%)',
        'Taxable Value (INR)',
        'CGST (INR)',
        'SGST (INR)',
        'IGST (INR)',
        'E-Way Bill Required',
      ];
      rows = dataset.b2bInvoices.map((r) =>
        [
          r.gstin,
          r.clientName,
          r.invoiceNumber,
          r.date,
          r.grandTotal,
          r.placeOfSupply,
          'N',
          'Regular B2B',
          r.gstRate,
          r.taxableAmount,
          r.cgstAmount,
          r.sgstAmount,
          r.igstAmount,
          r.ewayRequired ? 'YES (>=50K)' : 'NO',
        ]
          .map(csvEscape)
          .join(','),
      );
      rowCount = dataset.b2bInvoices.length;
    } else if (section === 'b2c') {
      headers = [
        'Return Table',
        'Type',
        'Place Of Supply',
        'Rate (%)',
        'Invoice Count',
        'Taxable Value (INR)',
        'CGST (INR)',
        'SGST (INR)',
        'IGST (INR)',
        'Total Invoice Value (INR)',
      ];
      rows = dataset.b2cSummary.map((r) =>
        [
          r.bucket,
          'OE',
          r.placeOfSupply,
          r.gstRate,
          r.invoiceCount,
          r.taxableAmount,
          r.cgstAmount,
          r.sgstAmount,
          r.igstAmount,
          r.grandTotal,
        ]
          .map(csvEscape)
          .join(','),
      );
      rowCount = dataset.b2cSummary.length;
    } else if (section === 'hsn') {
      headers = [
        'HSN/SAC',
        'Description',
        'UQC',
        'Rate (%)',
        'Total Quantity',
        'Total Value (INR)',
        'Taxable Value (INR)',
        'Integrated Tax (IGST)',
        'Central Tax (CGST)',
        'State/UT Tax (SGST)',
      ];
      rows = dataset.hsnSummary.map((h) =>
        [
          h.hsnSac,
          h.descriptions[0] || `HSN ${h.hsnSac}`,
          'NOS',
          h.gstRate,
          h.totalQuantity,
          h.totalValue,
          h.taxableAmount,
          h.igstAmount,
          h.cgstAmount,
          h.sgstAmount,
        ]
          .map(csvEscape)
          .join(','),
      );
      rowCount = dataset.hsnSummary.length;
    } else {
      headers = [
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
      rows = dataset.allPeriodDtos.map((dto) => {
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
      rowCount = dataset.allPeriodDtos.length;
    }

    const csv = [headers.map(csvEscape).join(','), ...rows].join('\r\n');
    const periodTag = dataset.period.month === 'all' ? new Date().toISOString().slice(0, 10) : dataset.period.month;
    const filename = `Leadsetu-GSTR1-${section.toUpperCase()}-${periodTag}.csv`;

    await this.auditService?.record({
      tenantId: auth.tenantId,
      actorId: auth.userId,
      actorEmail: auth.email,
      action: 'invoice.gstr1_exported',
      entityType: 'invoice',
      entityId: auth.tenantId,
      entityLabel: filename,
      summary: `Exported GSTR-1 ${section.toUpperCase()} CSV (${rowCount} rows, period: ${dataset.period.month})`,
    });

    return {
      filename,
      section,
      month: dataset.period.month,
      rowCount,
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

  public async getTenantRecoveryPublicInfo(tenantId: string) {
    return this.getTenantRecoveryConfig(tenantId);
  }

  public buildUpiPaymentLink(
    upiId: string,
    merchantName: string,
    invoiceNumber: string,
    amountInr: number,
  ) {
    return this.buildUpiLink(upiId, merchantName, invoiceNumber, amountInr);
  }

  private isUsableUpiId(upiId?: string | null): boolean {
    const clean = String(upiId || '').trim();
    if (!clean) return false;
    if (clean.toLowerCase() === 'leadsetu.b2b@icici') return false;
    return /^[a-zA-Z0-9._-]{2,}@[a-zA-Z0-9.-]{2,}$/.test(clean);
  }

  private async getTenantRecoveryConfig(tenantId: string) {
    const tenant = Types.ObjectId.isValid(tenantId)
      ? await this.invoiceModel.db
          ?.collection('tenants')
          .findOne({ _id: new Types.ObjectId(tenantId) })
      : null;
    const saved = (tenant?.creditRecoveryConfig || {}) as Record<string, unknown>;
    const rawUpi = String(saved.upiId || '').trim();
    const upiConfigured = this.isUsableUpiId(rawUpi);
    return {
      upiId: upiConfigured ? rawUpi : rawUpi || 'leadsetu.b2b@icici',
      upiConfigured,
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
    const cleanPa = upiId.trim();
    if (!cleanPa || !cleanPa.includes('@')) return '';
    // Keep literal '@' in `pa` — NPCI / PhonePe / Paytm reject percent-encoded `%40`
    const pa = encodeURIComponent(cleanPa).replace(/%40/g, '@');
    const cleanName =
      merchantName
        .replace(/[^a-zA-Z0-9 ]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 50) || 'Leadsetu Business';
    const pn = encodeURIComponent(cleanName);
    const cleanRef =
      invoiceNumber.replace(/[^a-zA-Z0-9]+/g, '').slice(0, 35) || 'INV';
    const tn = encodeURIComponent(`Invoice ${cleanRef}`);
    const numericAmt = Number(amountInr);
    const am = Math.max(1, Number.isFinite(numericAmt) ? numericAmt : 1).toFixed(2);
    return `upi://pay?pa=${pa}&pn=${pn}&tr=${cleanRef}&tn=${tn}&am=${am}&cu=INR`;
  }

  private isPlaceholderPaymentLink(link?: string | null): boolean {
    const clean = String(link || '').trim();
    return !clean || clean.startsWith('https://rzp.io/i/leadsetu-');
  }

  private async createRazorpayPaymentLink(params: {
    tenantId: string;
    invoiceId?: string;
    invoiceNumber: string;
    amountInr: number;
    clientName: string;
    phone?: string;
    email?: string;
    docType?: string;
  }): Promise<{ paymentLink: string; gatewayMode: 'test' | 'live' | 'sandbox' }> {
    const slugCode = params.invoiceNumber
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-');
    const fallbackUrl = `https://rzp.io/i/leadsetu-${slugCode}`;

    const amountPaise = Math.round(Number(params.amountInr || 0) * 100);
    if (amountPaise < 100) {
      return { paymentLink: fallbackUrl, gatewayMode: 'sandbox' };
    }

    const rzp = await resolveEffectiveRazorpayConfig(
      this.invoiceModel.db,
      this.configService,
    );
    if (!rzp.isLiveConfigured) {
      return { paymentLink: fallbackUrl, gatewayMode: 'sandbox' };
    }

    const basicAuth = Buffer.from(`${rzp.keyId}:${rzp.keySecret}`).toString(
      'base64',
    );
    const digits = extractLast10Digits(params.phone || '');
    const customerPayload: Record<string, string> = {
      name: params.clientName.trim().slice(0, 80) || 'Customer',
    };
    if (params.email?.trim()) {
      customerPayload.email = params.email.trim().toLowerCase();
    }
    if (digits.length === 10) {
      customerPayload.contact = `+91${digits}`;
    }

    const cleanRefBase =
      params.invoiceNumber.replace(/[^a-zA-Z0-9-_]+/g, '').slice(0, 32) || 'INV';
    const referenceId = `${cleanRefBase}-${randomBytes(2).toString('hex')}`;

    try {
      const payload: Record<string, unknown> = {
        amount: amountPaise,
        currency: 'INR',
        accept_partial: amountPaise >= 200,
        ...(amountPaise >= 200 ? { first_min_partial_amount: 100 } : {}),
        reference_id: referenceId,
        description: `${params.docType === 'proforma_quote' ? 'Quotation' : 'GST Invoice'} ${params.invoiceNumber} — ${params.clientName}`,
        customer: customerPayload,
        notify: { sms: false, email: false },
        reminder_enable: false,
        notes: {
          ...(params.invoiceId ? { invoiceId: params.invoiceId } : {}),
          invoiceNumber: params.invoiceNumber,
          tenantId: params.tenantId,
          clientName: params.clientName.trim().slice(0, 100),
        },
      };

      const { data } = await axios.post<{
        id?: string;
        short_url?: string;
      }>(`${rzp.apiBase}/payment_links`, payload, {
        headers: {
          Authorization: `Basic ${basicAuth}`,
          'Content-Type': 'application/json',
        },
        timeout: 12000,
      });

      const shortUrl = String(data?.short_url || '').trim();
      if (shortUrl) {
        return {
          paymentLink: shortUrl,
          gatewayMode: rzp.mode === 'live' ? 'live' : 'test',
        };
      }
    } catch (err) {
      const msg = axios.isAxiosError(err)
        ? String(
            err.response?.data?.error?.description ||
              err.response?.data?.error?.reason ||
              err.message,
          )
        : err instanceof Error
          ? err.message
          : 'Razorpay payment_links failed';
      Logger.warn(
        `Razorpay Payment Link fallback for ${params.invoiceNumber}: ${msg}`,
        'InvoicesService',
      );
    }

    return { paymentLink: fallbackUrl, gatewayMode: 'sandbox' };
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

    const rzpLink =
      status !== 'paid'
        ? await this.createRazorpayPaymentLink({
            tenantId: auth.tenantId,
            invoiceNumber: generatedNumber,
            amountInr:
              initialBalanceDue > 0 ? initialBalanceDue : computed.grandTotal,
            clientName: dto.clientName.trim(),
            phone: dto.phone?.trim(),
            email: dto.email?.trim(),
            docType,
          })
        : {
            paymentLink: `https://rzp.io/i/leadsetu-${generatedNumber
              .toLowerCase()
              .replace(/[^a-z0-9]/g, '')}`,
            gatewayMode: 'sandbox' as const,
          };
    const paymentLink = rzpLink.paymentLink;

    const recoveryCfg = await this.getTenantRecoveryConfig(auth.tenantId);
    const upiPaymentUri = recoveryCfg.upiConfigured
      ? this.buildUpiLink(
          recoveryCfg.upiId,
          recoveryCfg.merchantName,
          generatedNumber,
          initialBalanceDue > 0 ? initialBalanceDue : computed.grandTotal,
        )
      : '';
    const upiQrDataUrl =
      recoveryCfg.upiConfigured && upiPaymentUri && computed.grandTotal > 0
        ? await QRCode.toDataURL(upiPaymentUri, { width: 320, margin: 2 }).catch(
            () => '',
          )
        : '';

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
      upiPaymentUri,
      upiQrDataUrl,
      dispatchStatus: 'pending',
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

    const prevStatus = doc.status;
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
    if (prevStatus !== 'paid' && this.metaCapiService) {
      await this.metaCapiService
        .fireConversionEvent({
          tenantId: auth.tenantId,
          eventName: 'Purchase',
          entityType: 'invoice',
          entityId: doc._id.toString(),
          entityLabel: `${doc.invoiceNumber} · ${doc.clientName}`,
          phone: doc.phone,
          email: doc.email,
          valueInr: Number(doc.grandTotal || 0),
          triggeredBy: 'auto_invoice_paid',
          respectAutoToggle: true,
        })
        .catch(() => {});
    }

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

    const prevStatus = doc.status;
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

    if (prevStatus !== 'paid' && doc.status === 'paid' && this.metaCapiService) {
      await this.metaCapiService
        .fireConversionEvent({
          tenantId: auth.tenantId,
          eventName: 'Purchase',
          entityType: 'invoice',
          entityId: doc._id.toString(),
          entityLabel: `${doc.invoiceNumber} · ${doc.clientName}`,
          phone: doc.phone,
          email: doc.email,
          valueInr: Number(doc.grandTotal || 0),
          triggeredBy: 'auto_invoice_paid',
          respectAutoToggle: true,
        })
        .catch(() => {});
    }

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

    // Update linked deal stage + timeline activity when connected
    if (doc.linkedDealId && Types.ObjectId.isValid(doc.linkedDealId)) {
      try {
        const dealsCol = this.invoiceModel.db?.collection('deals');
        const pipelinesCol = this.invoiceModel.db?.collection('pipelines');
        const existingDeal = await dealsCol?.findOne({
          _id: new Types.ObjectId(doc.linkedDealId),
          tenantId: doc.tenantId,
        });

        const activitiesToPush: Array<Record<string, unknown>> = [
          {
            id: `act-${Date.now()}`,
            type: 'quote',
            description:
              decision === 'approved'
                ? `Buyer ${buyerName} APPROVED ${doc.invoiceNumber} (₹${doc.grandTotal.toLocaleString('en-IN')}) via Magic Portal.`
                : `Buyer ${buyerName} requested changes on ${doc.invoiceNumber}${remark ? `: "${remark}"` : '.'}`,
            authorName: buyerName,
            createdAt: nowIso,
          },
        ];

        const updateSet: Record<string, unknown> = {};
        if (decision === 'approved' && existingDeal) {
          let nextStage = String(existingDeal.stage || 'negotiation');
          let nextProbability = Math.max(Number(existingDeal.probability || 0), 90);
          const curCat = String(existingDeal.stageCategory || 'open');

          if (curCat !== 'won') {
            let targetStageId = '';
            if (existingDeal.pipelineId && pipelinesCol) {
              const pipe = await pipelinesCol.findOne({ _id: existingDeal.pipelineId });
              const pipeStages = Array.isArray(pipe?.stages)
                ? (pipe.stages as Array<{ id: string; name: string; category?: string; probability?: number }>)
                : [];
              const negStage = pipeStages.find(
                (s) =>
                  s.category === 'open' &&
                  /negotiat|approv|closing|verbal|commit|final/i.test(s.name || s.id),
              );
              const openStages = pipeStages.filter((s) => (s.category || 'open') === 'open');
              const picked = negStage || openStages[openStages.length - 1];
              if (picked) {
                targetStageId = picked.id;
                nextProbability = Math.max(90, Number(picked.probability || 90));
              }
            } else {
              targetStageId = 'negotiation';
            }

            if (targetStageId && targetStageId !== nextStage) {
              activitiesToPush.unshift({
                id: `act-${Date.now() + 1}`,
                type: 'stage_change',
                description: `Auto-moved deal stage "${nextStage}" -> "${targetStageId}" (${nextProbability}% confidence) after Buyer approved quote ${doc.invoiceNumber}.`,
                authorName: 'Buyer Portal Automation',
                createdAt: nowIso,
              });
              nextStage = targetStageId;
            }
          }

          updateSet.stage = nextStage;
          updateSet.probability = nextProbability;
        }

        const dealUpdateOp: Record<string, unknown> = {
          $push: {
            activities: {
              $each: activitiesToPush,
              $position: 0,
            },
          },
        };
        if (Object.keys(updateSet).length > 0) {
          dealUpdateOp.$set = updateSet;
        }

        await dealsCol?.updateOne(
          { _id: new Types.ObjectId(doc.linkedDealId), tenantId: doc.tenantId },
          dealUpdateOp,
        );
      } catch {
        // Non-blocking activity sync
      }
    }

    // Also update linked Lead timeline if connected
    if (doc.linkedLeadId && Types.ObjectId.isValid(doc.linkedLeadId)) {
      try {
        await this.invoiceModel.db?.collection('leads').updateOne(
          { _id: new Types.ObjectId(doc.linkedLeadId), tenantId: doc.tenantId },
          {
            $push: {
              activities: {
                $each: [
                  {
                    id: `act-${Date.now() + 2}`,
                    type: 'note',
                    description:
                      decision === 'approved'
                        ? `Buyer ${buyerName} APPROVED quote ${doc.invoiceNumber} (₹${doc.grandTotal.toLocaleString('en-IN')}) via Magic Portal.`
                        : `Buyer ${buyerName} requested revision on quote ${doc.invoiceNumber}${remark ? `: "${remark}"` : '.'}`,
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
        // Non-blocking lead timeline sync
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
    const submittedUpi =
      dto.upiId !== undefined ? dto.upiId.trim() : current.upiId;
    if (
      dto.upiId !== undefined &&
      submittedUpi &&
      !/^[a-zA-Z0-9._-]{2,}@[a-zA-Z0-9.-]{2,}$/.test(submittedUpi)
    ) {
      throw new BadRequestException(
        'Invalid UPI ID format. Enter a valid VPA like yourbusiness@okicici or yourstore@ybl.',
      );
    }

    const nextConfig = {
      upiId: submittedUpi,
      upiConfigured: this.isUsableUpiId(submittedUpi),
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

  async exportTallyXml(
    auth: { userId: string; tenantId: string; email: string },
    query?: { month?: string; includeMasters?: string },
  ) {
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

    const month = this.normalizeMonthParam(query?.month);
    const includeMasters = query?.includeMasters !== 'false';
    const ownerScope = await resolveOwnerScopeFilter(db, auth);
    const allDocs = await this.invoiceModel
      .find({ tenantId: tenantOid, ...ownerScope, docType: 'tax_invoice', status: { $ne: 'cancelled' } })
      .sort({ createdAt: -1 })
      .exec();

    const allDtos = allDocs.map((d) => this.toDto(d, false));
    const docs =
      month === 'all'
        ? allDtos
        : allDtos.filter((d) => String(d.createdAt || '').slice(0, 7) === month);

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

    const masterMessages: string[] = [];
    const partyLedgersSeen = new Map<string, { gstin: string; pos: string }>();
    const bankLedgersSeen = new Set<string>();

    const vouchers: string[] = [];
    let salesVoucherCount = 0;
    let receiptVoucherCount = 0;

    for (const dto of docs) {
      const vDate = tallyDate(dto.createdAt);
      const partyRaw = String(dto.clientName || 'Sundry Customer').trim();
      const party = xmlEscape(partyRaw);
      const cleanGstin = String(dto.gstin || '').trim().toUpperCase();
      const posName = String(dto.placeOfSupply || '09 - Uttar Pradesh')
        .replace(/^\d{2}\s*-\s*/, '')
        .trim();

      if (!partyLedgersSeen.has(partyRaw)) {
        partyLedgersSeen.set(partyRaw, { gstin: cleanGstin, pos: posName });
      }

      // 1) Tally Sales Voucher
      const taxEntries =
        dto.taxType === 'igst'
          ? `<ALLLEDGERENTRIES.LIST><LEDGERNAME>Output IGST</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>${dto.igstAmount.toFixed(2)}</AMOUNT></ALLLEDGERENTRIES.LIST>`
          : `<ALLLEDGERENTRIES.LIST><LEDGERNAME>Output CGST</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>${dto.cgstAmount.toFixed(2)}</AMOUNT></ALLLEDGERENTRIES.LIST><ALLLEDGERENTRIES.LIST><LEDGERNAME>Output SGST</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>${dto.sgstAmount.toFixed(2)}</AMOUNT></ALLLEDGERENTRIES.LIST>`;

      salesVoucherCount += 1;
      vouchers.push(`
    <TALLYMESSAGE xmlns:UDF="TallyUDF">
      <VOUCHER VCHTYPE="Sales" ACTION="Create">
        <DATE>${vDate}</DATE>
        <VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>
        <VOUCHERNUMBER>${xmlEscape(dto.invoiceNumber)}</VOUCHERNUMBER>
        <PARTYLEDGERNAME>${party}</PARTYLEDGERNAME>
        <PARTYGSTIN>${xmlEscape(cleanGstin)}</PARTYGSTIN>
        <PLACEOFSUPPLY>${xmlEscape(dto.placeOfSupply || '')}</PLACEOFSUPPLY>
        <NARRATION>${xmlEscape(`Leadsetu GST Sales ${dto.invoiceNumber} · ${dto.placeOfSupply}`)}</NARRATION>
        <ALLLEDGERENTRIES.LIST><LEDGERNAME>${party}</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-${dto.grandTotal.toFixed(2)}</AMOUNT></ALLLEDGERENTRIES.LIST>
        <ALLLEDGERENTRIES.LIST><LEDGERNAME>B2B Sales Account</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>${dto.taxableAmount.toFixed(2)}</AMOUNT></ALLLEDGERENTRIES.LIST>
        ${taxEntries}
      </VOUCHER>
    </TALLYMESSAGE>`);

      // 2) Tally Receipt + TDS Vouchers for recorded settlements
      for (const p of dto.payments || []) {
        const pDate = tallyDate(p.paymentDate || p.recordedAt);
        const bankLedgerRaw =
          p.paymentMode === 'Cash'
            ? 'Cash-in-Hand'
            : `Bank Receipt (${p.paymentMode})`;
        bankLedgersSeen.add(bankLedgerRaw);
        const tdsEntry =
          p.tdsDeducted > 0
            ? `<ALLLEDGERENTRIES.LIST><LEDGERNAME>TDS Receivable (Buyer Deducted)</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-${p.tdsDeducted.toFixed(2)}</AMOUNT></ALLLEDGERENTRIES.LIST>`
            : '';

        receiptVoucherCount += 1;
        vouchers.push(`
    <TALLYMESSAGE xmlns:UDF="TallyUDF">
      <VOUCHER VCHTYPE="Receipt" ACTION="Create">
        <DATE>${pDate}</DATE>
        <VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME>
        <VOUCHERNUMBER>${xmlEscape(p.utrOrChequeNo || p.id)}</VOUCHERNUMBER>
        <PARTYLEDGERNAME>${party}</PARTYLEDGERNAME>
        <NARRATION>${xmlEscape(`Receipt against ${dto.invoiceNumber} · ${p.paymentMode} ${p.utrOrChequeNo || ''}`)}</NARRATION>
        <ALLLEDGERENTRIES.LIST><LEDGERNAME>${party}</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>${p.totalSettled.toFixed(2)}</AMOUNT></ALLLEDGERENTRIES.LIST>
        <ALLLEDGERENTRIES.LIST><LEDGERNAME>${xmlEscape(bankLedgerRaw)}</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-${p.amountPaid.toFixed(2)}</AMOUNT></ALLLEDGERENTRIES.LIST>
        ${tdsEntry}
      </VOUCHER>
    </TALLYMESSAGE>`);
      }
    }

    if (includeMasters && docs.length > 0) {
      // Party Ledgers under Sundry Debtors
      for (const [partyName, meta] of partyLedgersSeen.entries()) {
        const isReg = InvoicesService.GSTIN_REGEX.test(meta.gstin);
        masterMessages.push(`
    <TALLYMESSAGE xmlns:UDF="TallyUDF">
      <LEDGER NAME="${xmlEscape(partyName)}" ACTION="Create">
        <NAME.LIST><NAME>${xmlEscape(partyName)}</NAME></NAME.LIST>
        <PARENT>Sundry Debtors</PARENT>
        <ISBILLWISEON>Yes</ISBILLWISEON>
        <GSTREGISTRATIONTYPE>${isReg ? 'Regular' : 'Unregistered/Consumer'}</GSTREGISTRATIONTYPE>
        ${isReg ? `<PARTYGSTIN>${xmlEscape(meta.gstin)}</PARTYGSTIN>` : ''}
        <LEDSTATENAME>${xmlEscape(meta.pos || 'Uttar Pradesh')}</LEDSTATENAME>
      </LEDGER>
    </TALLYMESSAGE>`);
      }

      // Core Accounting & GST Ledgers
      const systemLedgers: Array<{ name: string; parent: string; taxDuty?: string }> = [
        { name: 'B2B Sales Account', parent: 'Sales Accounts' },
        { name: 'Output CGST', parent: 'Duties & Taxes', taxDuty: 'CGST' },
        { name: 'Output SGST', parent: 'Duties & Taxes', taxDuty: 'SGST' },
        { name: 'Output IGST', parent: 'Duties & Taxes', taxDuty: 'IGST' },
        { name: 'TDS Receivable (Buyer Deducted)', parent: 'Current Assets' },
      ];
      for (const b of bankLedgersSeen) {
        if (b !== 'Cash-in-Hand') {
          systemLedgers.push({ name: b, parent: 'Bank Accounts' });
        }
      }
      for (const sys of systemLedgers) {
        masterMessages.push(`
    <TALLYMESSAGE xmlns:UDF="TallyUDF">
      <LEDGER NAME="${xmlEscape(sys.name)}" ACTION="Create">
        <NAME.LIST><NAME>${xmlEscape(sys.name)}</NAME></NAME.LIST>
        <PARENT>${xmlEscape(sys.parent)}</PARENT>
        ${sys.taxDuty ? `<TAXTYPE>GST</TAXTYPE><GSTDUTYHEAD>${sys.taxDuty}</GSTDUTYHEAD>` : ''}
      </LEDGER>
    </TALLYMESSAGE>`);
      }
    }

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC><REPORTNAME>All Masters</REPORTNAME></REQUESTDESC>
      <REQUESTDATA>${masterMessages.join('\n')}${vouchers.join('\n')}
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;

    const periodTag = month === 'all' ? new Date().toISOString().slice(0, 10) : month;
    const filename = `Leadsetu-TallyPrime-Complete-${periodTag}.xml`;

    await this.auditService?.record({
      tenantId: auth.tenantId,
      actorId: auth.userId,
      actorEmail: auth.email,
      action: 'invoice.tally_xml_exported',
      entityType: 'invoice',
      entityId: auth.tenantId,
      entityLabel: filename,
      summary: `Exported TallyPrime XML (${masterMessages.length} Masters + ${vouchers.length} Vouchers)`,
    });

    return {
      filename,
      month,
      ledgerMasterCount: masterMessages.length,
      voucherCount: vouchers.length,
      salesVoucherCount,
      receiptVoucherCount,
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

  private sanitizePdfText(text: string): string {
    return String(text || '')
      .replace(/₹/g, 'Rs. ')
      .replace(/[–—]/g, '-')
      .replace(/[·•]/g, '|')
      .replace(/[^\x20-\x7E]/g, ' ')
      .replace(/\\/g, '\\\\')
      .replace(/\(/g, '\\(')
      .replace(/\)/g, '\\)')
      .trim();
  }

  buildDocumentPdfBuffer(
    doc: InvoiceDocument,
    sellerCompany = 'Leadsetu Technologies',
    publicUrl = '',
  ): Buffer {
    const isQuote = doc.docType === 'proforma_quote';
    const cmds: string[] = [];

    const drawRect = (
      x: number,
      y: number,
      w: number,
      h: number,
      r: number,
      g: number,
      b: number,
    ) => {
      cmds.push(`${r} ${g} ${b} rg ${x} ${y} ${w} ${h} re f`);
    };

    const drawText = (
      x: number,
      y: number,
      size: number,
      text: string,
      bold = false,
      r = 0.09,
      g = 0.14,
      b = 0.23,
    ) => {
      const font = bold ? 'F2' : 'F1';
      cmds.push(
        `BT /${font} ${size} Tf ${r} ${g} ${b} rg ${x} ${y} Td (${this.sanitizePdfText(
          text,
        )}) Tj ET`,
      );
    };

    // A4 Header Banner
    drawRect(0, 745, 595, 97, 0.09, 0.14, 0.23);
    drawText(40, 804, 18, sellerCompany.toUpperCase(), true, 1, 1, 1);
    drawText(
      40,
      784,
      10,
      isQuote
        ? 'COMMERCIAL B2B PROFORMA QUOTATION & PDF PROPOSAL'
        : 'OFFICIAL B2B GST TAX INVOICE',
      true,
      0.58,
      0.85,
      0.72,
    );
    drawText(
      40,
      764,
      9,
      `Document No: ${doc.invoiceNumber}   |   Place of Supply: ${
        doc.placeOfSupply || 'Delhi-NCR'
      }   |   Due / Valid Till: ${doc.dueDate || '15 Days'}`,
      false,
      0.82,
      0.88,
      0.96,
    );

    // Buyer Box
    drawRect(40, 650, 515, 76, 0.96, 0.97, 0.99);
    drawText(52, 706, 10, `BILL TO: ${doc.clientName}`, true);
    drawText(
      52,
      688,
      9,
      `Contact: ${doc.contactPerson || doc.clientName}   |   Phone: ${
        doc.phone || 'N/A'
      }   |   Email: ${doc.email || 'N/A'}`,
    );
    drawText(
      52,
      670,
      9,
      `Buyer GSTIN: ${doc.gstin || 'Unregistered / B2C'}   |   Tax Mode: ${(
        doc.taxType || 'cgst_sgst'
      ).toUpperCase()} @ ${doc.gstRate || 18}%`,
    );

    // Table Header
    drawRect(40, 616, 515, 22, 0.12, 0.21, 0.36);
    drawText(48, 623, 8.5, 'HSN/SAC', true, 1, 1, 1);
    drawText(115, 623, 8.5, 'ITEM / DESCRIPTION', true, 1, 1, 1);
    drawText(365, 623, 8.5, 'QTY', true, 1, 1, 1);
    drawText(415, 623, 8.5, 'UNIT RATE', true, 1, 1, 1);
    drawText(485, 623, 8.5, 'AMOUNT', true, 1, 1, 1);

    let y = 596;
    const items = Array.isArray(doc.items) ? doc.items.slice(0, 10) : [];
    for (const item of items) {
      drawText(48, y, 8.5, item.hsnSac || '998314');
      drawText(115, y, 8.5, String(item.description || '').slice(0, 44));
      drawText(365, y, 8.5, String(item.quantity || 1));
      drawText(
        415,
        y,
        8.5,
        `Rs. ${Number(item.unitPrice || 0).toLocaleString('en-IN')}`,
      );
      drawText(
        485,
        y,
        8.5,
        `Rs. ${Number(item.amount || 0).toLocaleString('en-IN')}`,
        true,
      );
      y -= 20;
    }

    // Totals & Payment Link Summary Box
    const summaryY = Math.min(y - 16, 370);
    drawRect(40, summaryY - 125, 515, 130, 0.95, 0.97, 0.96);
    drawText(
      52,
      summaryY - 18,
      9,
      `Sub-Total: Rs. ${Number(doc.subTotal || 0).toLocaleString('en-IN')}   |   Discount: Rs. ${Number(
        doc.discount || 0,
      ).toLocaleString('en-IN')}   |   Taxable Value: Rs. ${Number(
        doc.taxableAmount || 0,
      ).toLocaleString('en-IN')}`,
    );
    drawText(
      52,
      summaryY - 38,
      9,
      `GST (${doc.gstRate || 18}%): Rs. ${Number(doc.gstAmount || 0).toLocaleString(
        'en-IN',
      )} (CGST: Rs. ${Number(doc.cgstAmount || 0).toLocaleString(
        'en-IN',
      )} / SGST: Rs. ${Number(doc.sgstAmount || 0).toLocaleString(
        'en-IN',
      )} / IGST: Rs. ${Number(doc.igstAmount || 0).toLocaleString('en-IN')})`,
    );
    drawText(
      52,
      summaryY - 62,
      12,
      `GRAND TOTAL: Rs. ${Number(doc.grandTotal || 0).toLocaleString('en-IN')}`,
      true,
      0.04,
      0.45,
      0.3,
    );
    drawText(
      52,
      summaryY - 84,
      9,
      `Razorpay Instant Payment Link: ${
        doc.paymentLink || 'https://rzp.io/i/leadsetu'
      }`,
      true,
    );
    if (publicUrl) {
      drawText(
        52,
        summaryY - 102,
        8.5,
        `Online Buyer Portal: ${publicUrl}`,
      );
    }

    drawText(
      40,
      96,
      8,
      `Authorized Signatory - ${sellerCompany} | Generated via Leadsetu GST & WhatsApp Cloud Engine`,
      true,
    );

    const streamContent = cmds.join('\n');
    const objects = [
      '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
      '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
      '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>\nendobj\n',
      '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
      '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>\nendobj\n',
      `6 0 obj\n<< /Length ${streamContent.length} >>\nstream\n${streamContent}\nendstream\nendobj\n`,
    ];

    let pdf = '%PDF-1.4\n';
    const offsets: number[] = [];
    for (const obj of objects) {
      offsets.push(pdf.length);
      pdf += obj;
    }
    const xrefPos = pdf.length;
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const offset of offsets) {
      pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
    }
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;

    return Buffer.from(pdf, 'utf8');
  }

  /**
   * 1-Click Send Quotation or GST Tax Invoice PDF + Razorpay Payment Link on WhatsApp
   * via connected WhatsApp Cloud line, logging to buyer's /inbox thread AND Deal/Lead timelines.
   */
  async sendOnWhatsApp(
    auth: { userId: string; tenantId: string; email: string },
    id: string,
    dto?: {
      phone?: string;
      customMessage?: string;
      publicBaseUrl?: string;
    },
  ) {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Document not found.');
    }
    if (!this.inboxService) {
      throw new BadRequestException('WhatsApp Inbox service is unavailable.');
    }

    const tenantOid = new Types.ObjectId(auth.tenantId);
    const ownerScope = await resolveOwnerScopeFilter(this.invoiceModel.db, auth);
    const doc = await this.invoiceModel
      .findOne({
        _id: new Types.ObjectId(id),
        tenantId: tenantOid,
        ...ownerScope,
      })
      .exec();
    if (!doc) {
      throw new NotFoundException('Quotation or GST Invoice not found.');
    }

    let docChanged = false;
    if (!doc.publicToken) {
      doc.publicToken = `lsq_${randomBytes(10).toString('hex')}`;
      docChanged = true;
    }
    if (this.isPlaceholderPaymentLink(doc.paymentLink) && doc.status !== 'paid') {
      const settle = this.computeSettlement(doc);
      const createdLink = await this.createRazorpayPaymentLink({
        tenantId: auth.tenantId,
        invoiceId: doc._id.toString(),
        invoiceNumber: doc.invoiceNumber,
        amountInr:
          settle.balanceDue > 0 ? settle.balanceDue : settle.grandTotal,
        clientName: doc.clientName,
        phone: doc.phone,
        email: doc.email,
        docType: doc.docType,
      });
      if (doc.paymentLink !== createdLink.paymentLink) {
        doc.paymentLink = createdLink.paymentLink;
        docChanged = true;
      }
    }

    const db = this.invoiceModel.db;
    const [tenantDoc, userDoc] = await Promise.all([
      db.collection('tenants').findOne({ _id: tenantOid }),
      Types.ObjectId.isValid(auth.userId)
        ? db
            .collection('users')
            .findOne({ _id: new Types.ObjectId(auth.userId) })
        : Promise.resolve(null),
    ]);

    const sellerCompany = String(
      tenantDoc?.companyName || tenantDoc?.name || 'Leadsetu Technologies',
    ).trim();
    const actorName = String(
      userDoc?.name || auth.email.split('@')[0] || 'Sales & Accounts',
    ).trim();

    // Resolve phone number from dto, document, or linked Deal/Lead
    let rawPhone = String(dto?.phone || doc.phone || '').trim();
    if (extractLast10Digits(rawPhone).length < 10) {
      if (doc.linkedDealId && Types.ObjectId.isValid(doc.linkedDealId)) {
        const deal = await db
          .collection('deals')
          .findOne({ _id: new Types.ObjectId(doc.linkedDealId), tenantId: tenantOid });
        if (deal?.contactPhone) rawPhone = String(deal.contactPhone).trim();
      }
      if (
        extractLast10Digits(rawPhone).length < 10 &&
        doc.linkedLeadId &&
        Types.ObjectId.isValid(doc.linkedLeadId)
      ) {
        const lead = await db
          .collection('leads')
          .findOne({ _id: new Types.ObjectId(doc.linkedLeadId), tenantId: tenantOid });
        if (lead?.phone) rawPhone = String(lead.phone).trim();
      }
    }

    if (extractLast10Digits(rawPhone).length < 10) {
      throw new BadRequestException(
        'A valid 10-digit buyer WhatsApp phone number is required to send this PDF.',
      );
    }

    const formattedPhone = normalizeIndianPhone(rawPhone) || rawPhone;
    if (doc.phone !== formattedPhone) {
      doc.phone = formattedPhone;
      docChanged = true;
    }

    // Auto-discover linked Deal / Lead by phone or clientName if not already linked
    const last10 = extractLast10Digits(formattedPhone);
    if (!doc.linkedDealId || !Types.ObjectId.isValid(doc.linkedDealId)) {
      const deals = await db
        .collection('deals')
        .find({ tenantId: tenantOid })
        .sort({ updatedAt: -1 })
        .limit(40)
        .toArray();
      const matchedDeal = deals.find(
        (d) =>
          (last10 && extractLast10Digits(String(d.contactPhone || '')) === last10) ||
          (doc.clientName &&
            String(d.company || '').toLowerCase() ===
              doc.clientName.toLowerCase()),
      );
      if (matchedDeal) {
        doc.linkedDealId = String(matchedDeal._id);
        docChanged = true;
      }
    }

    if (!doc.linkedLeadId || !Types.ObjectId.isValid(doc.linkedLeadId)) {
      const leads = await db
        .collection('leads')
        .find({ tenantId: tenantOid })
        .sort({ updatedAt: -1 })
        .limit(50)
        .toArray();
      const matchedLead = leads.find(
        (l) =>
          (last10 && extractLast10Digits(String(l.phone || '')) === last10) ||
          (doc.clientName &&
            String(l.company || '').toLowerCase() ===
              doc.clientName.toLowerCase()),
      );
      if (matchedLead) {
        doc.linkedLeadId = String(matchedLead._id);
        docChanged = true;
      }
    }

    if (docChanged) {
      await doc.save();
    }

    const baseOrigin = String(
      dto?.publicBaseUrl ||
        this.configService.get<string>('FRONTEND_URL') ||
        'http://localhost:3000',
    ).replace(/\/+$/, '');
    const publicUrl = `${baseOrigin}/portal/${doc.publicToken}`;

    const pdfBuffer = this.buildDocumentPdfBuffer(doc, sellerCompany, publicUrl);
    const filename = `${doc.invoiceNumber}.pdf`;
    const pdfDataUrl = `data:application/pdf;base64,${pdfBuffer.toString('base64')}`;

    const isQuote = doc.docType === 'proforma_quote';
    const docLabel = isQuote ? 'Proforma Quotation' : 'GST Tax Invoice';
    const defaultMessage =
      dto?.customMessage?.trim() ||
      `Namaste ${doc.contactPerson || doc.clientName} ji 👋,\n\nPlease find attached your ${docLabel} PDF *${doc.invoiceNumber}* from *${sellerCompany}*.\n\n• Taxable Value: ₹${Number(doc.taxableAmount || 0).toLocaleString('en-IN')}\n• GST (${doc.gstRate || 18}%): ₹${Number(doc.gstAmount || 0).toLocaleString('en-IN')}\n• *Grand Total: ₹${Number(doc.grandTotal || 0).toLocaleString('en-IN')}*\n• ${isQuote ? 'Valid Till' : 'Due Date'}: ${doc.dueDate || '15 Days'}\n\n💳 Pay securely via Razorpay / UPI:\n${doc.paymentLink}\n\n📄 View & Approve Online:\n${publicUrl}`;

    const hasDeal = Boolean(
      doc.linkedDealId && Types.ObjectId.isValid(doc.linkedDealId),
    );
    const hasLead = Boolean(
      doc.linkedLeadId && Types.ObjectId.isValid(doc.linkedLeadId),
    );
    const primaryEntityType: 'deal' | 'lead' = hasDeal ? 'deal' : 'lead';
    const primaryEntityId = hasDeal
      ? doc.linkedDealId
      : hasLead
        ? doc.linkedLeadId
        : doc._id.toString();

    const settle = this.computeSettlement(doc);
    const payableAmt = settle.balanceDue > 0 ? settle.balanceDue : settle.grandTotal;
    const ctaButton =
      doc.status !== 'paid' && /^https?:\/\//i.test(String(doc.paymentLink || ''))
        ? {
            label: `Pay ₹${Math.round(payableAmt).toLocaleString('en-IN')}`.slice(0, 20),
            url: doc.paymentLink,
            amountInr: payableAmt,
            invoiceId: doc._id.toString(),
            invoiceNumber: doc.invoiceNumber,
          }
        : undefined;

    const dispatch = await this.inboxService.dispatchAutomatedWhatsApp({
      tenantId: auth.tenantId,
      userId: auth.userId,
      actorName,
      linkedEntityType: primaryEntityType,
      linkedEntityId: primaryEntityId,
      contactName: doc.contactPerson || doc.clientName,
      company: doc.clientName,
      phone: formattedPhone,
      city: doc.placeOfSupply || 'Delhi-NCR',
      estimatedValue: doc.grandTotal || 0,
      messageBody: defaultMessage,
      attachment: {
        type: 'document',
        url: pdfDataUrl,
        filename,
        mimeType: 'application/pdf',
      },
      ...(ctaButton ? { ctaButton } : {}),
      workflowName: `${docLabel} PDF (${doc.invoiceNumber})`,
    });

    // If BOTH Deal and Lead are linked, also log the WhatsApp PDF dispatch on the Lead timeline!
    if (hasDeal && hasLead) {
      await this.inboxService.logWhatsAppTimelineActivity(
        auth.tenantId,
        'lead',
        doc.linkedLeadId,
        actorName,
        `Sent ${docLabel} PDF ${filename} (₹${Number(doc.grandTotal || 0).toLocaleString('en-IN')}) + Razorpay Link (${doc.paymentLink}) via ${
          dispatch.deliveryProvider === 'meta_cloud'
            ? 'WhatsApp Cloud'
            : 'CRM Inbox'
        }`,
      );
    }

    await this.auditService?.record({
      tenantId: auth.tenantId,
      actorId: auth.userId,
      action: isQuote ? 'quote.whatsapp_pdf_sent' : 'invoice.whatsapp_pdf_sent',
      entityType: 'invoice',
      entityId: doc._id.toString(),
      entityLabel: `${doc.invoiceNumber} · ${doc.clientName}`,
      summary: `Sent ${docLabel} PDF (${filename}) + Razorpay link (${doc.paymentLink}) on WhatsApp to ${formattedPhone}`,
    });

    const maskPhones = this.auditService
      ? await this.auditService.shouldMaskViewerPhones(
          auth.tenantId,
          auth.userId,
        )
      : false;

    return {
      invoice: this.toDto(doc, maskPhones),
      sent: !dispatch.skippedDnd && dispatch.status !== 'failed',
      deliveryProvider: dispatch.deliveryProvider || 'crm_local',
      status: dispatch.status || 'delivered',
      externalMessageId: dispatch.externalMessageId || '',
      conversationId: dispatch.conversationId || '',
      filename,
      paymentLink: doc.paymentLink,
      publicUrl,
      linkedDealId: doc.linkedDealId || '',
      linkedLeadId: doc.linkedLeadId || '',
      ctaButton,
      message: dispatch.renderedMessage || defaultMessage,
      error: dispatch.deliveryError || dispatch.reason || '',
    };
  }

  /**
   * Public Razorpay Payment Webhook for Customer B2B GST Invoices / Quotations.
   * Verifies `X-Razorpay-Signature`, flips matching invoice (`sent`/`overdue`/`partial` -> `paid`),
   * records an Accounts Receivable settlement entry, removes buyer Credit Hold automatically
   * when no other overdue unpaid invoices remain, and dispatches instant WhatsApp receipt.
   */
  async handleCustomerRazorpayWebhook(
    rawBody: Buffer | string | undefined,
    signatureHeader: string | undefined,
    payload: Record<string, unknown>,
  ) {
    const rzp = await resolveEffectiveRazorpayConfig(
      this.invoiceModel.db,
      this.configService,
    );
    const webhookSecret = rzp.webhookSecret;

    const rawBuf = Buffer.isBuffer(rawBody)
      ? rawBody
      : Buffer.from(
          typeof rawBody === 'string' && rawBody.length > 0
            ? rawBody
            : JSON.stringify(payload || {}),
          'utf8',
        );

    const expectedHex = createHmac('sha256', webhookSecret)
      .update(rawBuf)
      .digest('hex');

    let sigOk = false;
    try {
      const a = Buffer.from(expectedHex.toLowerCase(), 'utf8');
      const b = Buffer.from((signatureHeader || '').trim().toLowerCase(), 'utf8');
      sigOk = a.length === b.length && timingSafeEqual(a, b);
    } catch {
      sigOk = false;
    }

    if (!sigOk) {
      throw new UnauthorizedException('Invalid Razorpay webhook signature.');
    }

    const eventType = String(payload?.event || '').trim();
    if (
      eventType !== 'payment_link.paid' &&
      eventType !== 'payment.captured' &&
      eventType !== 'order.paid'
    ) {
      return {
        received: true,
        event: eventType,
        action: 'unhandled_event_acknowledged',
      };
    }

    const payloadObj = (payload?.payload || {}) as Record<
      string,
      { entity?: Record<string, unknown> }
    >;
    const paymentEntity = payloadObj.payment?.entity || {};
    const orderEntity = payloadObj.order?.entity || {};
    const paymentLinkEntity = payloadObj.payment_link?.entity || {};

    const notes = {
      ...((orderEntity.notes as Record<string, unknown>) || {}),
      ...((paymentLinkEntity.notes as Record<string, unknown>) || {}),
      ...((paymentEntity.notes as Record<string, unknown>) || {}),
    };

    const paymentId = String(paymentEntity.id || `rzp_${Date.now()}`).trim();
    const amountPaise = Number(
      paymentEntity.amount || paymentLinkEntity.amount_paid || 0,
    );
    const amountInr = amountPaise > 0 ? Math.round(amountPaise / 100) : 0;

    const hintInvoiceId = String(notes.invoiceId || '').trim();
    const hintInvoiceNumber = String(
      notes.invoiceNumber || paymentLinkEntity.reference_id || '',
    ).trim();
    const hintPaymentLink = String(
      paymentLinkEntity.short_url || paymentLinkEntity.id || '',
    ).trim();
    const descriptionHint = String(
      paymentEntity.description || paymentLinkEntity.description || '',
    ).trim();

    let doc: InvoiceDocument | null = null;
    if (hintInvoiceId && Types.ObjectId.isValid(hintInvoiceId)) {
      doc = await this.invoiceModel.findById(hintInvoiceId).exec();
    }
    if (!doc && hintInvoiceNumber) {
      doc = await this.invoiceModel
        .findOne({ invoiceNumber: hintInvoiceNumber })
        .exec();
    }
    if (!doc && hintPaymentLink) {
      doc = await this.invoiceModel
        .findOne({
          paymentLink: {
            $regex: hintPaymentLink.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
          },
        })
        .exec();
    }
    if (!doc && descriptionHint) {
      const invMatch = descriptionHint.match(/(?:INV|QT)-[A-Z0-9-]+/i);
      if (invMatch) {
        doc = await this.invoiceModel
          .findOne({ invoiceNumber: invMatch[0].toUpperCase() })
          .exec();
      }
    }

    if (!doc) {
      return {
        received: true,
        event: eventType,
        paymentId,
        action: 'invoice_not_found',
      };
    }

    const existingPayments = Array.isArray(doc.payments) ? doc.payments : [];
    if (existingPayments.some((p) => p.utrOrChequeNo === paymentId)) {
      return {
        received: true,
        event: eventType,
        invoiceId: doc._id.toString(),
        invoiceNumber: doc.invoiceNumber,
        paymentId,
        alreadyProcessed: true,
        action: 'already_reconciled',
      };
    }

    const settlementBefore = this.computeSettlement(doc);
    const settledAmount =
      amountInr > 0
        ? Math.min(amountInr, Math.max(amountInr, settlementBefore.balanceDue))
        : settlementBefore.balanceDue;
    const appliedAmount = Math.min(
      Math.max(0, settledAmount),
      settlementBefore.balanceDue || settledAmount,
    );

    let capiEvent: { eventId?: string; status?: string } | null = null;
    if (appliedAmount > 0 && doc.status !== 'paid') {
      const entry: InvoicePaymentRecord = {
        id: `pay-${Date.now()}-${randomBytes(3).toString('hex')}`,
        amountPaid: appliedAmount,
        tdsDeducted: 0,
        totalSettled: appliedAmount,
        paymentMode: 'Razorpay',
        utrOrChequeNo: paymentId,
        paymentDate: new Date().toISOString().slice(0, 10),
        note: `Auto-reconciled via Razorpay Webhook (${eventType})`,
        recordedAt: new Date().toISOString(),
      };
      doc.payments = [...existingPayments, entry];
      const next = this.computeSettlement(doc);
      doc.amountPaid = next.amountPaid;
      doc.tdsDeducted = next.tdsDeducted;
      doc.balanceDue = next.balanceDue;
      doc.status = next.balanceDue <= 0 ? 'paid' : 'partial';
      doc.paymentMethod = 'razorpay';
      doc.markModified('payments');
      await doc.save();

      if (doc.status === 'paid' && this.metaCapiService) {
        capiEvent = await this.metaCapiService
          .fireConversionEvent({
            tenantId: doc.tenantId.toString(),
            eventName: 'Purchase',
            entityType: 'invoice',
            entityId: doc._id.toString(),
            entityLabel: `${doc.invoiceNumber} · ${doc.clientName}`,
            phone: doc.phone,
            email: doc.email,
            valueInr: Number(doc.grandTotal || 0),
            triggeredBy: 'auto_razorpay_webhook_paid',
            respectAutoToggle: true,
          })
          .catch(() => null);
      }
    }

    const tenantIdStr = doc.tenantId.toString();
    const db = this.invoiceModel.db;

    // Auto-clear Credit Hold on buyer Contact if all overdue invoices are settled
    let creditHoldRemoved = false;
    let resolvedContactId = '';
    try {
      const contactsCol = db.collection('contacts');
      let contact: (Record<string, unknown> & { _id?: Types.ObjectId }) | null =
        null;
      if (doc.phone) {
        const l10 = extractLast10Digits(doc.phone);
        if (l10) {
          contact = await contactsCol.findOne({
            tenantId: doc.tenantId,
            phone: { $regex: l10 },
          });
        }
      }
      if (!contact && doc.clientName) {
        contact = await contactsCol.findOne({
          tenantId: doc.tenantId,
          $or: [{ company: doc.clientName }, { name: doc.clientName }],
        });
      }
      if (contact?._id) {
        resolvedContactId = contact._id.toString();
      }

      if (contact && contact.creditHold && contact._id) {
        const openInvoices = await this.invoiceModel
          .find({
            tenantId: doc.tenantId,
            docType: 'tax_invoice',
            status: { $in: ['sent', 'overdue', 'partial'] },
            _id: { $ne: doc._id },
          })
          .exec();
        const contactL10 = extractLast10Digits(String(contact.phone || ''));
        const stillOverdue = openInvoices.some((inv) => {
          const sameBuyer =
            (contactL10 && extractLast10Digits(inv.phone) === contactL10) ||
            (contact?.company &&
              inv.clientName.toLowerCase() ===
                String(contact.company).toLowerCase());
          if (!sameBuyer) return false;
          const dueMs = new Date(inv.dueDate || '').getTime();
          return (
            Number.isFinite(dueMs) &&
            dueMs < Date.now() &&
            this.computeSettlement(inv).balanceDue > 0
          );
        });

        if (!stillOverdue) {
          await contactsCol.updateOne(
            { _id: contact._id },
            {
              $set: {
                creditHold: false,
                creditHoldReason: '',
              },
            },
          );
          creditHoldRemoved = true;
        }
      }
    } catch {
      // ignore optional contact credit hold update error
    }

    // Send instant WhatsApp Payment Receipt Confirmation
    let whatsappReceiptSent = false;
    const formattedPhone = doc.phone
      ? normalizeIndianPhone(doc.phone) || doc.phone
      : '';
    if (this.inboxService && formattedPhone && extractLast10Digits(formattedPhone).length >= 10) {
      const receiptMsg = `Namaste ${doc.contactPerson || doc.clientName} ji 🙏,\n\nWe have received your Razorpay payment of *₹${appliedAmount.toLocaleString('en-IN')}* (Txn ID: \`${paymentId}\`) against *${doc.invoiceNumber}* for *${doc.clientName}*.\n\nStatus: *${doc.status === 'paid' ? 'PAID IN FULL ✅' : `PARTIAL PAID · Balance ₹${Number(doc.balanceDue || 0).toLocaleString('en-IN')}`}*.\nThank you for your prompt settlement!`;

      const entityType: 'deal' | 'lead' | 'contact' =
        doc.linkedDealId && Types.ObjectId.isValid(doc.linkedDealId)
          ? 'deal'
          : doc.linkedLeadId && Types.ObjectId.isValid(doc.linkedLeadId)
            ? 'lead'
            : 'contact';
      const entityId =
        entityType === 'deal'
          ? doc.linkedDealId
          : entityType === 'lead'
            ? doc.linkedLeadId
            : resolvedContactId || doc._id.toString();

      try {
        const dispatch = await this.inboxService.dispatchAutomatedWhatsApp({
          tenantId: tenantIdStr,
          userId: doc.ownerId.toString(),
          actorName: 'Razorpay Auto-Reconciliation',
          linkedEntityType: entityType,
          linkedEntityId: entityId,
          contactName: doc.contactPerson || doc.clientName,
          company: doc.clientName,
          phone: formattedPhone,
          estimatedValue: doc.grandTotal,
          messageBody: receiptMsg,
          sendMode: 'text',
          timelineMarker: `Razorpay payment ₹${appliedAmount.toLocaleString('en-IN')} (${paymentId}) auto-reconciled on ${doc.invoiceNumber}`,
        });
        whatsappReceiptSent = !dispatch.skippedDnd && dispatch.status !== 'failed';
      } catch {
        whatsappReceiptSent = false;
      }
    }

    await this.auditService?.record({
      tenantId: tenantIdStr,
      actorId: doc.ownerId.toString(),
      action: 'invoice.razorpay_webhook_reconciled',
      entityType: 'invoice',
      entityId: doc._id.toString(),
      entityLabel: `${doc.invoiceNumber} · ${doc.clientName}`,
      summary: `Razorpay webhook reconciled ₹${appliedAmount.toLocaleString('en-IN')} (${paymentId}) -> ${doc.invoiceNumber} status=${doc.status}${creditHoldRemoved ? ' · Credit Hold Cleared' : ''}${whatsappReceiptSent ? ' · WhatsApp Receipt Sent' : ''}`,
    });

    return {
      received: true,
      event: eventType,
      invoiceId: doc._id.toString(),
      invoiceNumber: doc.invoiceNumber,
      paymentId,
      amountSettledInr: appliedAmount,
      balanceDue: doc.balanceDue,
      status: doc.status,
      creditHoldRemoved,
      whatsappReceiptSent,
      metaCapiPurchaseFired: Boolean(capiEvent),
      metaCapiEventId: capiEvent?.eventId || '',
      metaCapiStatus: capiEvent?.status || '',
      action: doc.status === 'paid' ? 'invoice_paid' : 'partial_payment_recorded',
    };
  }

  private buildCourierTrackingUrl(courier: string, awbNumber: string): string {
    const cleanAwb = encodeURIComponent(awbNumber.trim());
    if (courier === 'Shiprocket') {
      return `https://shiprocket.co/tracking/${cleanAwb}`;
    }
    if (courier === 'Delhivery') {
      return `https://www.delhivery.com/track/package/${cleanAwb}`;
    }
    if (courier === 'BlueDart') {
      return `https://www.bluedart.com/tracking?trackFor=0&trackNo=${cleanAwb}`;
    }
    if (courier === 'DTDC') {
      return `https://www.dtdc.in/tracking/shipment-tracking.asp?strCnno=${cleanAwb}`;
    }
    return `https://leadsetu.in/track/${cleanAwb}`;
  }

  /**
   * 1-Click WhatsApp Catalog Cart Checkout + Scannable UPI QR Generation + Chat Dispatch
   */
  async createWhatsappCartCheckout(
    auth: { userId: string; tenantId: string; email?: string; name?: string },
    dto: CreateWhatsappCartCheckoutDto,
  ) {
    if (!Array.isArray(dto.items) || dto.items.length === 0) {
      throw new BadRequestException('Select at least one SKU to build a WhatsApp cart.');
    }

    const db = this.invoiceModel.db;
    const tenantOid = new Types.ObjectId(auth.tenantId);

    // Enrich missing SKU details from /products catalog when productId is supplied
    const productIds = dto.items
      .map((i) => i.productId)
      .filter((id): id is string => Boolean(id && Types.ObjectId.isValid(id)))
      .map((id) => new Types.ObjectId(id));

    const catalogDocs =
      productIds.length > 0
        ? await db
            .collection('products')
            .find({ tenantId: tenantOid, _id: { $in: productIds } })
            .toArray()
        : [];
    const catalogMap = new Map(catalogDocs.map((p) => [String(p._id), p]));

    const resolvedItems: InvoiceLineItemDto[] = dto.items.map((line) => {
      const cat = line.productId ? catalogMap.get(line.productId) : undefined;
      return {
        description:
          String(line.description || '').trim() ||
          String(cat?.name || 'Catalog Item'),
        hsnSac:
          String(line.hsnSac || '').trim() ||
          String(cat?.hsnSac || '850440'),
        quantity: Math.max(1, Number(line.quantity || 1)),
        unitPrice: Math.max(
          0,
          Number(line.unitPrice ?? cat?.unitPrice ?? 0),
        ),
      };
    });

    const createdInv = await this.create(
      auth,
      {
        docType: dto.docType || 'tax_invoice',
        clientName: dto.clientName.trim(),
        contactPerson: dto.clientName.trim(),
        phone: dto.phone.trim(),
        email: dto.email?.trim(),
        placeOfSupply: dto.placeOfSupply || '09 - Uttar Pradesh',
        gstRate: dto.gstRate ?? 18,
        discount: dto.discount ?? 0,
        items: resolvedItems,
        notes: 'WhatsApp Interactive Catalog Cart Checkout',
      },
      { skipCreditGuardrail: true },
    );

    const recoveryCfg = await this.getTenantRecoveryConfig(auth.tenantId);
    const upiConfigured = recoveryCfg.upiConfigured;
    const upiPaymentUri = upiConfigured
      ? createdInv.upiPaymentUri ||
        this.buildUpiLink(
          recoveryCfg.upiId,
          recoveryCfg.merchantName,
          createdInv.invoiceNumber,
          createdInv.grandTotal,
        )
      : '';
    const upiQrDataUrl =
      upiConfigured && upiPaymentUri
        ? createdInv.upiQrDataUrl ||
          (await QRCode.toDataURL(upiPaymentUri, {
            width: 320,
            margin: 2,
          }).catch(() => ''))
        : '';

    const linesPreview = resolvedItems
      .map(
        (it, idx) =>
          `${idx + 1}. ${it.description} × ${it.quantity} = ₹${(it.quantity * it.unitPrice).toLocaleString('en-IN')}`,
      )
      .join('\n');

    const paymentLines = upiConfigured && upiPaymentUri
      ? `Scan the attached UPI QR code or pay directly via:\n• UPI Link: ${upiPaymentUri}\n• Razorpay Link: ${createdInv.paymentLink}`
      : `Pay securely via payment link:\n• Payment Link: ${createdInv.paymentLink}`;

    const cartMsg =
      dto.customMessage?.trim() ||
      `Namaste ${dto.clientName} ji! Here is your order summary (*${createdInv.invoiceNumber}*):\n\n${linesPreview}\n\n${
        createdInv.gstAmount > 0
          ? `Taxable: ₹${createdInv.taxableAmount.toLocaleString('en-IN')} + GST (${createdInv.gstRate}%): ₹${createdInv.gstAmount.toLocaleString('en-IN')}\n`
          : ''
      }*Payable Total: ₹${createdInv.grandTotal.toLocaleString('en-IN')}*\n\n${paymentLines}`;

    let whatsappDispatched = false;
    let resolvedConvId = dto.conversationId || '';

    if (dto.sendWhatsappNow !== false && this.inboxService) {
      const qrAttachment = upiQrDataUrl
        ? {
            type: 'image' as const,
            url: upiQrDataUrl,
            filename: `UPI-QR-${createdInv.invoiceNumber}.png`,
            mimeType: 'image/png',
          }
        : undefined;
      const cartCtaButton = /^https?:\/\//i.test(String(createdInv.paymentLink || ''))
        ? {
            label: `Pay ₹${Math.round(createdInv.grandTotal).toLocaleString('en-IN')}`.slice(0, 20),
            url: createdInv.paymentLink,
            amountInr: createdInv.grandTotal,
            invoiceId: createdInv.id,
            invoiceNumber: createdInv.invoiceNumber,
          }
        : undefined;

      if (resolvedConvId && Types.ObjectId.isValid(resolvedConvId)) {
        try {
          await this.inboxService.sendMessage(
            {
              userId: auth.userId,
              tenantId: auth.tenantId,
              email: auth.email || 'team@leadsetu.in',
              name: auth.name || 'Sales Team',
              role: 'admin',
            },
            resolvedConvId,
            {
              content: cartMsg,
              via: 'inbox',
              logToTimeline: true,
              ...(qrAttachment ? { attachment: qrAttachment } : {}),
              ...(cartCtaButton ? { ctaButton: cartCtaButton } : {}),
            },
          );
          whatsappDispatched = true;
        } catch {
          whatsappDispatched = false;
        }
      } else if (dto.phone) {
        try {
          const dispatch = await this.inboxService.dispatchAutomatedWhatsApp({
            tenantId: auth.tenantId,
            userId: auth.userId,
            actorName: auth.name || 'WhatsApp Cart Checkout',
            linkedEntityType: 'contact',
            linkedEntityId: createdInv.id,
            contactName: dto.clientName,
            company: dto.clientName,
            phone: dto.phone,
            estimatedValue: createdInv.grandTotal,
            messageBody: cartMsg,
            sendMode: 'text',
            ...(qrAttachment ? { attachment: qrAttachment } : {}),
            ...(cartCtaButton ? { ctaButton: cartCtaButton } : {}),
            timelineMarker: `WhatsApp Catalog Cart ${createdInv.invoiceNumber} (₹${createdInv.grandTotal.toLocaleString('en-IN')}) sent with UPI QR + Razorpay CTA`,
          });
          whatsappDispatched = !dispatch.skippedDnd && dispatch.status !== 'failed';
          resolvedConvId = dispatch.conversationId || '';
        } catch {
          whatsappDispatched = false;
        }
      }
    }

    return {
      invoice: { ...createdInv, upiPaymentUri, upiQrDataUrl },
      upiId: recoveryCfg.upiId,
      upiConfigured,
      upiPaymentUri,
      upiQrDataUrl,
      paymentLink: createdInv.paymentLink,
      whatsappDispatched,
      conversationId: resolvedConvId,
    };
  }

  async getInvoiceUpiQr(
    auth: { userId: string; tenantId: string },
    id: string,
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

    const cfg = await this.getTenantRecoveryConfig(auth.tenantId);
    const settle = this.computeSettlement(doc);
    const targetAmt = settle.balanceDue > 0 ? settle.balanceDue : settle.grandTotal;
    const upiConfigured = cfg.upiConfigured;
    const upiPaymentUri = upiConfigured
      ? this.buildUpiLink(
          cfg.upiId,
          cfg.merchantName,
          doc.invoiceNumber,
          targetAmt,
        )
      : '';
    const upiQrDataUrl =
      upiConfigured && upiPaymentUri
        ? await QRCode.toDataURL(upiPaymentUri, {
            width: 320,
            margin: 2,
          })
        : '';

    if (
      this.isPlaceholderPaymentLink(doc.paymentLink) &&
      doc.status !== 'paid'
    ) {
      const upgraded = await this.createRazorpayPaymentLink({
        tenantId: auth.tenantId,
        invoiceId: doc._id.toString(),
        invoiceNumber: doc.invoiceNumber,
        amountInr: targetAmt,
        clientName: doc.clientName,
        phone: doc.phone,
        email: doc.email,
        docType: doc.docType,
      });
      if (upgraded.paymentLink && upgraded.paymentLink !== doc.paymentLink) {
        doc.paymentLink = upgraded.paymentLink;
      }
    }

    if (
      doc.upiPaymentUri !== upiPaymentUri ||
      doc.upiQrDataUrl !== upiQrDataUrl ||
      doc.isModified('paymentLink')
    ) {
      doc.upiPaymentUri = upiPaymentUri;
      doc.upiQrDataUrl = upiQrDataUrl;
      await doc.save();
    }

    return {
      invoiceId: doc._id.toString(),
      invoiceNumber: doc.invoiceNumber,
      clientName: doc.clientName,
      grandTotal: settle.grandTotal,
      balanceDue: settle.balanceDue,
      upiId: cfg.upiId,
      merchantName: cfg.merchantName,
      upiConfigured,
      upiPaymentUri,
      upiQrDataUrl,
      paymentLink: doc.paymentLink,
      status: doc.status,
    };
  }

  /**
   * Courier & AWB Dispatch Tracking Update + 1-Click WhatsApp Shipment Alert
   */
  async updateDispatchAndNotify(
    auth: { userId: string; tenantId: string },
    id: string,
    dto: UpdateInvoiceDispatchDto,
  ) {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Invoice not found.');
    }
    if (!dto.awbNumber?.trim()) {
      throw new BadRequestException('AWB / Tracking number is required.');
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

    const awb = dto.awbNumber.trim().toUpperCase();
    const courier = dto.courier || 'Shiprocket';
    const trackingUrl =
      dto.trackingUrl?.trim() || this.buildCourierTrackingUrl(courier, awb);
    const dispatchStatus = dto.dispatchStatus || 'in_transit';
    const nowIso = new Date().toISOString();

    doc.dispatchCourier = courier;
    doc.dispatchAwbNumber = awb;
    doc.dispatchTrackingUrl = trackingUrl;
    doc.dispatchStatus = dispatchStatus;
    if (!doc.dispatchedAt) doc.dispatchedAt = nowIso;
    doc.dispatchNotes = String(dto.notes || '').trim();

    let whatsappNotified = false;
    const formattedPhone = doc.phone
      ? normalizeIndianPhone(doc.phone) || doc.phone
      : '';
    if (
      dto.sendWhatsAppAlert !== false &&
      this.inboxService &&
      formattedPhone &&
      extractLast10Digits(formattedPhone).length >= 10
    ) {
      const stageLabel = dispatchStatus.replace(/_/g, ' ').toUpperCase();
      const alertMsg = `Namaste ${doc.contactPerson || doc.clientName} ji! 📦\n\nYour order against *${doc.invoiceNumber}* has been updated to *${stageLabel}*.\n\n• Courier Partner: *${courier}*\n• AWB Tracking #: \`${awb}\`\n• Live Tracking Link: ${trackingUrl}${
        doc.dispatchNotes ? `\n• Dispatch Note: ${doc.dispatchNotes}` : ''
      }\n\nThank you for shopping with us!`;

      const entityType: 'deal' | 'lead' | 'contact' =
        doc.linkedDealId && Types.ObjectId.isValid(doc.linkedDealId)
          ? 'deal'
          : doc.linkedLeadId && Types.ObjectId.isValid(doc.linkedLeadId)
            ? 'lead'
            : 'contact';
      const entityId =
        entityType === 'deal'
          ? doc.linkedDealId
          : entityType === 'lead'
            ? doc.linkedLeadId
            : doc._id.toString();

      try {
        const dispatch = await this.inboxService.dispatchAutomatedWhatsApp({
          tenantId: auth.tenantId,
          userId: auth.userId,
          actorName: 'Dispatch Tracker',
          linkedEntityType: entityType,
          linkedEntityId: entityId,
          contactName: doc.contactPerson || doc.clientName,
          company: doc.clientName,
          phone: formattedPhone,
          estimatedValue: doc.grandTotal,
          messageBody: alertMsg,
          sendMode: 'text',
          timelineMarker: `Dispatched via ${courier} (AWB ${awb}) · ${stageLabel}`,
        });
        whatsappNotified = !dispatch.skippedDnd && dispatch.status !== 'failed';
        if (whatsappNotified) {
          doc.dispatchNotifiedAt = nowIso;
        }
      } catch {
        whatsappNotified = false;
      }
    }

    await doc.save();

    await this.auditService?.record({
      tenantId: auth.tenantId,
      actorId: auth.userId,
      action: 'invoice.dispatch_updated',
      entityType: 'invoice',
      entityId: doc._id.toString(),
      entityLabel: `${doc.invoiceNumber} · ${courier} (${awb})`,
      summary: `Updated courier dispatch ${courier} AWB ${awb} (${dispatchStatus}) on ${doc.invoiceNumber}${whatsappNotified ? ' · WhatsApp Alert Sent' : ''}`,
    });

    return {
      invoice: this.toDto(doc, false),
      whatsappNotified,
      trackingUrl,
    };
  }

  /**
   * Sandbox 1-Click Payment Webhook Simulation for testing Auto-Reconciliation end-to-end
   */
  async simulateWebhookPaid(
    auth: { userId: string; tenantId: string },
    id: string,
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

    const settle = this.computeSettlement(doc);
    const payPaise = Math.max(100, Math.round((settle.balanceDue || settle.grandTotal) * 100));
    const rzp = await resolveEffectiveRazorpayConfig(
      this.invoiceModel.db,
      this.configService,
    );
    const secret = rzp.webhookSecret;

    const syntheticPayload = {
      event: 'payment_link.paid',
      payload: {
        payment: {
          entity: {
            id: `pay_sim_${Date.now()}`,
            amount: payPaise,
            description: `Payment for ${doc.invoiceNumber}`,
          },
        },
        payment_link: {
          entity: {
            short_url: doc.paymentLink,
            reference_id: doc.invoiceNumber,
            notes: { invoiceId: doc._id.toString(), invoiceNumber: doc.invoiceNumber },
          },
        },
      },
    };
    const rawStr = JSON.stringify(syntheticPayload);
    const sig = createHmac('sha256', secret).update(rawStr).digest('hex');

    return this.handleCustomerRazorpayWebhook(rawStr, sig, syntheticPayload);
  }
}
