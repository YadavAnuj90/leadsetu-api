import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Model, Types } from 'mongoose';
import { randomBytes } from 'crypto';
import * as QRCode from 'qrcode';
import {
  Contact,
  ContactDocument,
} from '../contacts/contacts.service';
import {
  Invoice,
  InvoiceDocument,
  InvoicesService,
} from '../invoices/invoices.service';
import { AuditService } from '../audit/audit.module';
import {
  ManagePortalLinkDto,
  PortalCreateTicketDto,
  PortalPaymentIntentDto,
  PortalQuoteRespondDto,
  PortalTicketReplyDto,
} from './dto/portal.dto';

export interface PortalAuthContext {
  userId: string;
  tenantId: string;
  email: string;
  role: string;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function computeOverdueDays(dueDate?: string, status?: string): number {
  if (!dueDate || status === 'paid' || status === 'cancelled') return 0;
  const dueMs = new Date(`${String(dueDate).slice(0, 10)}T23:59:59`).getTime();
  if (!Number.isFinite(dueMs)) return 0;
  const diff = Math.floor((Date.now() - dueMs) / 86400000);
  return diff > 0 ? diff : 0;
}

@Injectable()
export class PortalService {
  constructor(
    @InjectModel(Contact.name)
    private readonly contactModel: Model<ContactDocument>,
    @InjectModel(Invoice.name)
    private readonly invoiceModel: Model<InvoiceDocument>,
    private readonly invoicesService: InvoicesService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    @Optional() private readonly auditService?: AuditService,
  ) {}

  async verifyAuth(authHeader?: string): Promise<PortalAuthContext> {
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
        role?: string;
      }>(token, { secret });
      return {
        userId: payload.sub,
        tenantId: payload.tenantId,
        email: payload.email,
        role: payload.role || 'agent',
      };
    } catch {
      throw new UnauthorizedException('Invalid or expired session.');
    }
  }

  async getOrManageContactPortalLink(
    auth: PortalAuthContext,
    contactId: string,
    dto: ManagePortalLinkDto = {},
  ) {
    if (!Types.ObjectId.isValid(contactId)) {
      throw new NotFoundException('Contact not found.');
    }
    const contact = await this.contactModel
      .findOne({
        _id: new Types.ObjectId(contactId),
        tenantId: new Types.ObjectId(auth.tenantId),
      })
      .exec();
    if (!contact) {
      throw new NotFoundException('B2B Contact / Dealer not found.');
    }

    let changed = false;
    if (!contact.portalToken || dto.regenerate) {
      contact.portalToken = `lsp_${randomBytes(12).toString('hex')}`;
      changed = true;
    }
    if (typeof dto.enabled === 'boolean' && contact.portalEnabled !== dto.enabled) {
      contact.portalEnabled = dto.enabled;
      changed = true;
    }
    if (contact.portalEnabled === undefined) {
      contact.portalEnabled = true;
      changed = true;
    }
    if (changed) {
      await contact.save();
      await this.auditService?.record({
        tenantId: auth.tenantId,
        actorId: auth.userId,
        action: dto.regenerate ? 'portal.token_regenerated' : 'portal.link_updated',
        entityType: 'contact',
        entityId: contact._id.toString(),
        entityLabel: contact.company || contact.name,
        summary: `Buyer Magic Portal ${contact.portalEnabled ? 'enabled' : 'disabled'} for ${contact.company || contact.name}`,
      });
    }

    return {
      contactId: contact._id.toString(),
      portalToken: contact.portalToken,
      portalEnabled: contact.portalEnabled !== false,
      portalLastAccessedAt: contact.portalLastAccessedAt || '',
      portalPath: `/portal/${contact.portalToken}`,
    };
  }

  private async resolvePortalSubject(token: string): Promise<{
    tenantId: Types.ObjectId;
    contact: ContactDocument | null;
    focusDoc: InvoiceDocument | null;
    buyerName: string;
    buyerCompany: string;
    buyerGstin: string;
    buyerPhone: string;
    buyerEmail: string;
  }> {
    const cleanToken = String(token || '').trim();
    if (!cleanToken) {
      throw new NotFoundException('Portal link is missing or invalid.');
    }

    // 1) Try Contact-level Magic Portal token (`lsp_...`)
    const contactMatch = await this.contactModel
      .findOne({ portalToken: cleanToken })
      .exec();
    if (contactMatch) {
      if (contactMatch.portalEnabled === false) {
        throw new ForbiddenException(
          'This buyer portal link has been disabled by the seller.',
        );
      }
      return {
        tenantId: contactMatch.tenantId,
        contact: contactMatch,
        focusDoc: null,
        buyerName: contactMatch.name,
        buyerCompany: contactMatch.company || contactMatch.name,
        buyerGstin: contactMatch.gstin || '',
        buyerPhone: contactMatch.phone || '',
        buyerEmail: contactMatch.email || '',
      };
    }

    // 2) Fallback: Resolve Document public token (`lsq_...`) seamlessly into full Dealer Portal
    const docMatch = await this.invoiceModel
      .findOne({ publicToken: cleanToken })
      .exec();
    if (!docMatch) {
      throw new NotFoundException(
        'Buyer portal link not found or expired. Request a fresh link from your supplier.',
      );
    }

    // Attempt to find matching B2B Contact record for Udhaar credit & ticket aggregation
    const orClauses: Array<Record<string, unknown>> = [];
    if (docMatch.gstin?.trim()) {
      orClauses.push({ gstin: docMatch.gstin.trim().toUpperCase() });
    }
    if (docMatch.clientName?.trim()) {
      const rx = new RegExp(`^${escapeRegex(docMatch.clientName.trim())}$`, 'i');
      orClauses.push({ company: rx }, { name: rx });
    }

    const linkedContact =
      orClauses.length > 0
        ? await this.contactModel
            .findOne({ tenantId: docMatch.tenantId, $or: orClauses })
            .exec()
        : null;

    if (linkedContact && linkedContact.portalEnabled === false) {
      throw new ForbiddenException(
        'This buyer portal link has been disabled by the seller.',
      );
    }

    return {
      tenantId: docMatch.tenantId,
      contact: linkedContact,
      focusDoc: docMatch,
      buyerName: linkedContact?.name || docMatch.contactPerson || docMatch.clientName,
      buyerCompany: linkedContact?.company || docMatch.clientName,
      buyerGstin: linkedContact?.gstin || docMatch.gstin || '',
      buyerPhone: linkedContact?.phone || docMatch.phone || '',
      buyerEmail: linkedContact?.email || docMatch.email || '',
    };
  }

  private buildBuyerDocumentFilter(subject: {
    tenantId: Types.ObjectId;
    contact: ContactDocument | null;
    focusDoc: InvoiceDocument | null;
    buyerCompany: string;
    buyerGstin: string;
  }) {
    const matchClauses: Array<Record<string, unknown>> = [];
    if (subject.focusDoc) {
      matchClauses.push({ _id: subject.focusDoc._id });
    }
    if (subject.buyerGstin.trim()) {
      matchClauses.push({ gstin: subject.buyerGstin.trim().toUpperCase() });
    }
    const candidateNames = Array.from(
      new Set(
        [
          subject.buyerCompany,
          subject.contact?.company,
          subject.contact?.name,
          subject.focusDoc?.clientName,
        ]
          .map((v) => String(v || '').trim())
          .filter(Boolean),
      ),
    );
    for (const name of candidateNames) {
      matchClauses.push({
        clientName: new RegExp(`^${escapeRegex(name)}$`, 'i'),
      });
    }

    return {
      tenantId: subject.tenantId,
      ...(matchClauses.length > 0 ? { $or: matchClauses } : {}),
    };
  }

  async getPublicPortalData(token: string) {
    const subject = await this.resolvePortalSubject(token);

    if (subject.contact) {
      subject.contact.portalLastAccessedAt = new Date().toISOString();
      await subject.contact.save().catch(() => undefined);
    }

    const tenantDoc = await this.invoiceModel.db
      ?.collection('tenants')
      .findOne({ _id: subject.tenantId });

    const recovery = await this.invoicesService.getTenantRecoveryPublicInfo(
      subject.tenantId.toString(),
    );

    const docFilter = this.buildBuyerDocumentFilter(subject);
    const allDocs = await this.invoiceModel
      .find(docFilter)
      .sort({ createdAt: -1 })
      .limit(100)
      .exec();

    const quotations = [];
    const invoices = [];

    let totalInvoicedInr = 0;
    let totalPaidInr = 0;
    let openBalanceInr = 0;
    let overdueBalanceInr = 0;

    for (const doc of allDocs) {
      const grandTotal = Math.round(Number(doc.grandTotal) || 0);
      const amountPaid = Math.round(Number(doc.amountPaid) || 0);
      const tdsDeducted = Math.round(Number(doc.tdsDeducted) || 0);
      const computedBalance = Math.max(
        0,
        doc.status === 'paid'
          ? 0
          : Number.isFinite(Number(doc.balanceDue)) && Number(doc.balanceDue) > 0
            ? Math.round(Number(doc.balanceDue))
            : Math.max(0, grandTotal - amountPaid - tdsDeducted),
      );
      const daysOverdue = computeOverdueDays(doc.dueDate, doc.status);
      const raw = doc.toObject() as unknown as { createdAt?: Date };
      const createdAt = raw.createdAt
        ? new Date(raw.createdAt).toISOString()
        : new Date().toISOString();

      if (doc.docType === 'proforma_quote') {
        quotations.push({
          id: doc._id.toString(),
          invoiceNumber: doc.invoiceNumber,
          clientName: doc.clientName,
          contactPerson: doc.contactPerson || '',
          gstin: doc.gstin || '',
          placeOfSupply: doc.placeOfSupply || '07 - Delhi',
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
          grandTotal,
          dueDate: doc.dueDate || '',
          notes: doc.notes || '',
          publicToken: doc.publicToken || '',
          quoteApprovalStatus: doc.quoteApprovalStatus || 'pending',
          approvedByName: doc.approvedByName || '',
          approvedAt: doc.approvedAt || '',
          convertedToInvoiceId: doc.convertedToInvoiceId || '',
          createdAt,
        });
      } else {
        totalInvoicedInr += grandTotal;
        totalPaidInr += amountPaid + tdsDeducted;
        if (doc.status !== 'cancelled' && doc.status !== 'draft') {
          openBalanceInr += computedBalance;
          if (daysOverdue > 0 || doc.status === 'overdue') {
            overdueBalanceInr += computedBalance;
          }
        }

        const upiDeepLink =
          computedBalance > 0
            ? this.invoicesService.buildUpiPaymentLink(
                recovery.upiId,
                recovery.merchantName,
                doc.invoiceNumber,
                computedBalance,
              )
            : '';

        invoices.push({
          id: doc._id.toString(),
          invoiceNumber: doc.invoiceNumber,
          clientName: doc.clientName,
          gstin: doc.gstin || '',
          placeOfSupply: doc.placeOfSupply || '07 - Delhi',
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
          grandTotal,
          amountPaid,
          tdsDeducted,
          balanceDue: computedBalance,
          status: daysOverdue > 0 && doc.status === 'sent' ? 'overdue' : doc.status,
          daysOverdue,
          dueDate: doc.dueDate || '',
          paymentLink: doc.paymentLink || '',
          upiDeepLink,
          promisedPaymentDate: doc.promisedPaymentDate || '',
          payments: Array.isArray(doc.payments) ? doc.payments : [],
          notes: doc.notes || '',
          createdAt,
        });
      }
    }

    // Fetch buyer SLA / support tickets
    const ticketOr: Array<Record<string, unknown>> = [];
    if (subject.contact) {
      ticketOr.push({ linkedContactId: subject.contact._id.toString() });
    }
    if (subject.buyerEmail) {
      ticketOr.push({ email: subject.buyerEmail.toLowerCase() });
    }
    if (subject.buyerCompany) {
      ticketOr.push({
        company: new RegExp(`^${escapeRegex(subject.buyerCompany)}$`, 'i'),
      });
    }

    const ticketDocs =
      ticketOr.length > 0
        ? (await this.invoiceModel.db
            ?.collection('tickets')
            .find({
              tenantId: subject.tenantId,
              $or: ticketOr,
            })
            .sort({ createdAt: -1 })
            .limit(40)
            .toArray()) || []
        : [];

    const tickets = ticketDocs.map((t) => ({
      id: String(t._id),
      ticketNumber: String(t.ticketNumber || ''),
      subject: String(t.subject || ''),
      category: String(t.category || 'general'),
      priority: String(t.priority || 'medium'),
      status: String(t.status || 'open'),
      linkedInvoiceNumber: String(t.linkedInvoiceNumber || ''),
      slaDueAt: String(t.slaDueAt || ''),
      resolvedAt: String(t.resolvedAt || ''),
      resolutionSummary: String(t.resolutionSummary || ''),
      comments: Array.isArray(t.comments)
        ? (t.comments as Array<Record<string, unknown>>)
            .filter((c) => !c.isInternal)
            .map((c) => ({
              id: String(c.id || ''),
              authorName: String(c.authorName || ''),
              authorRole: String(c.authorRole || 'agent'),
              message: String(c.message || ''),
              createdAt: String(c.createdAt || ''),
            }))
        : [],
      createdAt: t.createdAt
        ? new Date(t.createdAt as string | Date).toISOString()
        : new Date().toISOString(),
    }));

    const creditLimitInr = Math.max(0, Number(subject.contact?.creditLimitInr || 0));
    const availableCreditInr =
      creditLimitInr > 0 ? Math.max(0, creditLimitInr - openBalanceInr) : 0;

    return {
      portalToken: token,
      focusDocId: subject.focusDoc?._id.toString() || '',
      seller: {
        companyName: String(
          tenantDoc?.companyName || tenantDoc?.name || 'Leadsetu B2B Workspace',
        ),
        logoUrl: String(tenantDoc?.logoUrl || ''),
        city: String(tenantDoc?.city || 'New Delhi'),
        gstin: String(tenantDoc?.gstin || ''),
        state: String(tenantDoc?.state || 'Delhi (07)'),
        phone: String(tenantDoc?.phone || ''),
        email: String(tenantDoc?.email || ''),
        address: String(tenantDoc?.address || ''),
        upiId: recovery.upiId,
        bankAccountNote: recovery.bankAccountNote,
      },
      buyer: {
        id: subject.contact?._id.toString() || '',
        name: subject.buyerName,
        company: subject.buyerCompany,
        designation: subject.contact?.designation || '',
        phone: subject.buyerPhone,
        email: subject.buyerEmail,
        city: subject.contact?.city || 'India',
        gstin: subject.buyerGstin,
        gstinStatus: subject.contact?.gstinStatus || 'unverified',
        creditLimitInr,
        creditTermDays: Number(subject.contact?.creditTermDays ?? 15),
        creditHold: Boolean(subject.contact?.creditHold),
        creditHoldReason: subject.contact?.creditHoldReason || '',
        openBalanceInr,
        overdueBalanceInr,
        availableCreditInr,
        totalInvoicedInr,
        totalPaidInr,
      },
      quotations,
      invoices,
      tickets,
    };
  }

  private async logPortalContactActivity(
    contact: ContactDocument | null,
    description: string,
    authorName: string,
  ) {
    if (!contact) return;
    await this.contactModel.updateOne(
      { _id: contact._id },
      {
        $push: {
          activities: {
            $each: [
              {
                id: `portal-${Date.now()}`,
                type: 'portal',
                description,
                authorName,
                createdAt: new Date().toISOString(),
              },
            ],
            $position: 0,
          },
        },
      },
    );
  }

  async respondToQuoteInPortal(
    token: string,
    quoteId: string,
    dto: PortalQuoteRespondDto,
  ) {
    if (!Types.ObjectId.isValid(quoteId)) {
      throw new NotFoundException('Quotation not found.');
    }
    const subject = await this.resolvePortalSubject(token);
    const filter = this.buildBuyerDocumentFilter(subject);
    const quote = await this.invoiceModel
      .findOne({
        ...filter,
        _id: new Types.ObjectId(quoteId),
      })
      .exec();
    if (!quote) {
      throw new NotFoundException('Quotation not found for this buyer portal.');
    }

    if (!quote.publicToken) {
      quote.publicToken = `lsq_${randomBytes(10).toString('hex')}`;
      await quote.save();
    }

    const buyerName = dto.buyerName?.trim() || subject.buyerName;
    await this.invoicesService.respondToPublicQuote(quote.publicToken, {
      decision: dto.decision,
      buyerName,
      remark: dto.remark,
    });

    await this.logPortalContactActivity(
      subject.contact,
      dto.decision === 'approved'
        ? `Buyer ${buyerName} APPROVED quote ${quote.invoiceNumber} via Magic Portal.`
        : `Buyer ${buyerName} requested revision on quote ${quote.invoiceNumber}${dto.remark ? `: "${dto.remark}"` : '.'}`,
      buyerName,
    );

    return this.getPublicPortalData(token);
  }

  async submitPaymentIntentInPortal(
    token: string,
    invoiceId: string,
    dto: PortalPaymentIntentDto,
  ) {
    if (!Types.ObjectId.isValid(invoiceId)) {
      throw new NotFoundException('Invoice not found.');
    }
    const subject = await this.resolvePortalSubject(token);
    const filter = this.buildBuyerDocumentFilter(subject);
    const invoice = await this.invoiceModel
      .findOne({
        ...filter,
        _id: new Types.ObjectId(invoiceId),
      })
      .exec();
    if (!invoice) {
      throw new NotFoundException('Invoice not found for this buyer portal.');
    }

    const amount = Math.max(1, Math.round(Number(dto.amountInr || invoice.balanceDue || invoice.grandTotal)));
    const recovery = await this.invoicesService.getTenantRecoveryPublicInfo(
      subject.tenantId.toString(),
    );
    const upiDeepLink = this.invoicesService.buildUpiPaymentLink(
      recovery.upiId,
      recovery.merchantName,
      invoice.invoiceNumber,
      amount,
    );
    const upiQrDataUrl = await QRCode.toDataURL(upiDeepLink, {
      width: 220,
      margin: 1,
    });

    const buyerName = dto.buyerName?.trim() || subject.buyerName;
    const utr = dto.utrOrReference?.trim() || '';
    const promisedDate = dto.promisedDate?.trim() || '';
    const note = dto.note?.trim() || '';

    const summaryLine = utr
      ? `Buyer submitted ${dto.paymentMode} UTR/Ref "${utr}" for ₹${amount.toLocaleString('en-IN')} on ${invoice.invoiceNumber}`
      : promisedDate
        ? `Buyer committed to pay ₹${amount.toLocaleString('en-IN')} via ${dto.paymentMode} by ${promisedDate} for ${invoice.invoiceNumber}`
        : `Buyer generated ${dto.paymentMode} payment QR/link for ₹${amount.toLocaleString('en-IN')} on ${invoice.invoiceNumber}`;

    if (promisedDate) {
      invoice.promisedPaymentDate = promisedDate;
    }
    if (utr || note || promisedDate) {
      const stamp = new Date().toLocaleDateString('en-IN');
      invoice.notes = `${invoice.notes ? `${invoice.notes}\n` : ''}[Portal ${stamp} - ${buyerName}]: ${summaryLine}${note ? ` (${note})` : ''}`;
      await invoice.save();
    }

    await this.logPortalContactActivity(subject.contact, summaryLine, buyerName);

    await this.auditService?.record({
      tenantId: subject.tenantId.toString(),
      actorId: invoice.ownerId.toString(),
      actorName: buyerName,
      actorRole: 'buyer_portal',
      action: 'portal.payment_intent',
      entityType: 'invoice',
      entityId: invoice._id.toString(),
      entityLabel: `${invoice.invoiceNumber} · ${invoice.clientName}`,
      summary: summaryLine,
    });

    return {
      upiDeepLink,
      upiQrDataUrl,
      upiId: recovery.upiId,
      bankAccountNote: recovery.bankAccountNote,
      paymentLink: invoice.paymentLink || '',
      message: summaryLine,
      portal: await this.getPublicPortalData(token),
    };
  }

  async createTicketInPortal(token: string, dto: PortalCreateTicketDto) {
    if (!dto.subject?.trim() || !dto.message?.trim()) {
      throw new BadRequestException('Ticket subject and message are required.');
    }

    const subject = await this.resolvePortalSubject(token);
    const buyerName = dto.buyerName?.trim() || subject.buyerName;
    const ticketsCol = this.invoiceModel.db?.collection('tickets');
    if (!ticketsCol) {
      throw new BadRequestException('Tickets store unavailable.');
    }

    const ownerId =
      subject.contact?.ownerId ||
      subject.focusDoc?.ownerId ||
      (await this.invoiceModel.db
        ?.collection('users')
        .findOne({ tenantId: subject.tenantId, role: { $in: ['owner', 'admin'] } }))?._id ||
      new Types.ObjectId();

    const priority = dto.priority || 'medium';
    const hours =
      priority === 'urgent'
        ? 4
        : priority === 'high'
          ? 24
          : priority === 'low'
            ? 72
            : 48;
    const slaDueAt = new Date(Date.now() + hours * 3600000).toISOString().slice(0, 10);
    const count = await ticketsCol.countDocuments({ tenantId: subject.tenantId });
    const year = new Date().getFullYear();
    const ticketNumber = `TKT-${year}-${String(count + 1).padStart(4, '0')}`;
    const now = new Date();
    const nowIso = now.toISOString();

    const insertRes = await ticketsCol.insertOne({
      tenantId: subject.tenantId,
      ownerId,
      ticketNumber,
      subject: dto.subject.trim(),
      category: dto.category || 'general',
      priority,
      status: 'open',
      customerName: buyerName,
      company: subject.buyerCompany,
      phone: subject.buyerPhone,
      email: subject.buyerEmail,
      siteAddress: subject.contact?.city || '',
      linkedContactId: subject.contact?._id.toString() || '',
      linkedInvoiceNumber: dto.linkedInvoiceNumber?.trim() || '',
      productSerialOrSku: '',
      assignedToName: '',
      assignedToPhone: '',
      slaDueAt,
      resolvedAt: '',
      resolutionSummary: '',
      csatRating: 0,
      notes: 'Raised via Buyer Magic Portal',
      comments: [
        {
          id: `cmt-${Date.now()}`,
          authorName: buyerName,
          authorRole: 'customer',
          message: dto.message.trim(),
          isInternal: false,
          createdAt: nowIso,
        },
      ],
      createdAt: now,
      updatedAt: now,
    });

    await this.logPortalContactActivity(
      subject.contact,
      `Buyer ${buyerName} raised support ticket ${ticketNumber}: "${dto.subject.trim()}"`,
      buyerName,
    );

    await this.auditService?.record({
      tenantId: subject.tenantId.toString(),
      actorId: String(ownerId),
      actorName: buyerName,
      actorRole: 'buyer_portal',
      action: 'portal.ticket_created',
      entityType: 'ticket',
      entityId: String(insertRes.insertedId),
      entityLabel: `${ticketNumber} · ${subject.buyerCompany}`,
      summary: `Buyer raised ${ticketNumber} (${dto.category}) via Magic Portal`,
    });

    return this.getPublicPortalData(token);
  }

  async replyToTicketInPortal(
    token: string,
    ticketId: string,
    dto: PortalTicketReplyDto,
  ) {
    if (!Types.ObjectId.isValid(ticketId)) {
      throw new NotFoundException('Ticket not found.');
    }
    if (!dto.message?.trim()) {
      throw new BadRequestException('Reply message cannot be empty.');
    }

    const subject = await this.resolvePortalSubject(token);
    const ticketsCol = this.invoiceModel.db?.collection('tickets');
    if (!ticketsCol) {
      throw new BadRequestException('Tickets store unavailable.');
    }

    const ticket = await ticketsCol.findOne({
      _id: new Types.ObjectId(ticketId),
      tenantId: subject.tenantId,
    });
    if (!ticket) {
      throw new NotFoundException('Support ticket not found.');
    }

    const buyerName = dto.buyerName?.trim() || subject.buyerName;
    const now = new Date();
    await ticketsCol.updateOne(
      { _id: ticket._id },
      {
        $push: {
          comments: {
            id: `cmt-${Date.now()}`,
            authorName: buyerName,
            authorRole: 'customer',
            message: dto.message.trim(),
            isInternal: false,
            createdAt: now.toISOString(),
          },
        },
        $set: {
          status: ticket.status === 'waiting_client' ? 'open' : ticket.status,
          updatedAt: now,
        },
      } as Record<string, unknown>,
    );

    return this.getPublicPortalData(token);
  }
}
