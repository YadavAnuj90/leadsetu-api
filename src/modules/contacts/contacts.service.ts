import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectModel, Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { HydratedDocument, Model, Types } from 'mongoose';
import { AuditService } from '../audit/audit.module';
import { maskPhoneNumber, resolveOwnerScopeFilter } from '../auth/identity.util';
import { CreateContactDto } from './dto/contacts.dto';
import { CustomFieldsService } from '../custom-fields/custom-fields.service';

export type ContactDocument = HydratedDocument<Contact>;

export interface ContactActivity {
  id: string;
  type: 'created' | 'note' | 'call' | 'whatsapp' | 'portal';
  description: string;
  authorName: string;
  createdAt: string;
}

const GST_STATE_CODES: Record<string, string> = {
  '01': '01 - Jammu & Kashmir',
  '02': '02 - Himachal Pradesh',
  '03': '03 - Punjab',
  '04': '04 - Chandigarh',
  '05': '05 - Uttarakhand',
  '06': '06 - Haryana',
  '07': '07 - Delhi',
  '08': '08 - Rajasthan',
  '09': '09 - Uttar Pradesh',
  '10': '10 - Bihar',
  '11': '11 - Sikkim',
  '12': '12 - Arunachal Pradesh',
  '13': '13 - Nagaland',
  '14': '14 - Manipur',
  '15': '15 - Mizoram',
  '16': '16 - Tripura',
  '17': '17 - Meghalaya',
  '18': '18 - Assam',
  '19': '19 - West Bengal',
  '20': '20 - Jharkhand',
  '21': '21 - Odisha',
  '22': '22 - Chhattisgarh',
  '23': '23 - Madhya Pradesh',
  '24': '24 - Gujarat',
  '26': '26 - Dadra & Nagar Haveli and Daman & Diu',
  '27': '27 - Maharashtra',
  '29': '29 - Karnataka',
  '30': '30 - Goa',
  '31': '31 - Lakshadweep',
  '32': '32 - Kerala',
  '33': '33 - Tamil Nadu',
  '34': '34 - Puducherry',
  '35': '35 - Andaman & Nicobar Islands',
  '36': '36 - Telangana',
  '37': '37 - Andhra Pradesh',
  '38': '38 - Ladakh',
  '97': '97 - Other Territory',
};

const GSTIN_CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function validateIndianGstin(rawGstin?: string): {
  normalized: string;
  valid: boolean;
  status: 'unverified' | 'verified_active' | 'invalid_format' | 'checksum_failed';
  stateCode: string;
  stateName: string;
  pan: string;
  reason: string;
} {
  const gstin = String(rawGstin || '').trim().toUpperCase();
  if (!gstin) {
    return {
      normalized: '',
      valid: false,
      status: 'unverified',
      stateCode: '',
      stateName: '',
      pan: '',
      reason: 'No GSTIN provided.',
    };
  }

  const pattern = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
  if (!pattern.test(gstin)) {
    return {
      normalized: gstin,
      valid: false,
      status: 'invalid_format',
      stateCode: gstin.slice(0, 2),
      stateName: GST_STATE_CODES[gstin.slice(0, 2)] || '',
      pan: gstin.slice(2, 12),
      reason: 'Expected 15-char format: 2-digit State + 10-char PAN + Entity + Z + Checksum.',
    };
  }

  const stateCode = gstin.slice(0, 2);
  const stateName = GST_STATE_CODES[stateCode] || '';
  if (!stateName) {
    return {
      normalized: gstin,
      valid: false,
      status: 'invalid_format',
      stateCode,
      stateName: '',
      pan: gstin.slice(2, 12),
      reason: `Unknown GST state code "${stateCode}".`,
    };
  }

  // Official Luhn mod-36 GSTIN check digit on first 14 chars
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const codePoint = GSTIN_CHARSET.indexOf(gstin[i]);
    const factor = i % 2 === 0 ? 1 : 2;
    const product = codePoint * factor;
    sum += Math.floor(product / 36) + (product % 36);
  }
  const expectedDigit = GSTIN_CHARSET[(36 - (sum % 36)) % 36];
  if (gstin[14] !== expectedDigit) {
    return {
      normalized: gstin,
      valid: false,
      status: 'checksum_failed',
      stateCode,
      stateName,
      pan: gstin.slice(2, 12),
      reason: `GSTIN checksum mismatch (expected trailing character "${expectedDigit}").`,
    };
  }

  return {
    normalized: gstin,
    valid: true,
    status: 'verified_active',
    stateCode,
    stateName,
    pan: gstin.slice(2, 12),
    reason: `Format & Mod-36 checksum verified (${stateName}).`,
  };
}

@Schema({ timestamps: true, collection: 'contacts' })
export class Contact {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  ownerId!: Types.ObjectId;

  @Prop({ required: true, trim: true })
  name!: string;

  @Prop({ trim: true, default: '' })
  company!: string;

  @Prop({ trim: true, default: '' })
  designation!: string;

  @Prop({ trim: true, default: '' })
  phone!: string;

  @Prop({ trim: true, lowercase: true, default: '' })
  email!: string;

  @Prop({ trim: true, default: 'New Delhi' })
  city!: string;

  @Prop({ trim: true, default: '' })
  gstin!: string;

  @Prop({
    default: 'unverified',
    enum: ['unverified', 'verified_active', 'invalid_format', 'checksum_failed'],
  })
  gstinStatus!: 'unverified' | 'verified_active' | 'invalid_format' | 'checksum_failed';

  @Prop({ trim: true, default: '' })
  gstinStateName!: string;

  @Prop({ trim: true, default: '' })
  gstinVerifiedAt!: string;

  @Prop({
    default: 'business',
    enum: ['business', 'consumer'],
  })
  accountKind!: 'business' | 'consumer';

  @Prop({
    default: 'customer',
    enum: ['customer', 'prospect', 'partner', 'vendor'],
  })
  type!: 'customer' | 'prospect' | 'partner' | 'vendor';

  @Prop({ type: Number, default: 0 })
  lifetimeValue!: number;

  @Prop({ type: Number, default: 0 })
  creditLimitInr!: number;

  @Prop({ type: Number, default: 15 })
  creditTermDays!: number;

  @Prop({ type: Boolean, default: false })
  creditHold!: boolean;

  @Prop({ trim: true, default: '' })
  creditHoldReason!: string;

  @Prop({ type: [String], default: [] })
  tags!: string[];

  @Prop({ default: '' })
  notes!: string;

  @Prop({ type: Object, default: {} })
  customFields!: Record<string, unknown>;

  @Prop({ trim: true, unique: true, sparse: true, index: true })
  portalToken?: string;

  @Prop({ type: Boolean, default: true })
  portalEnabled?: boolean;

  @Prop({ trim: true, default: '' })
  portalLastAccessedAt?: string;

  @Prop({ type: Array, default: [] })
  activities!: ContactActivity[];
}

export const ContactSchema = SchemaFactory.createForClass(Contact);

@Injectable()
export class ContactsService {
  constructor(
    @InjectModel(Contact.name)
    private readonly contactModel: Model<ContactDocument>,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    @Optional() private readonly auditService?: AuditService,
    @Optional() private readonly customFieldsService?: CustomFieldsService,
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

  private async assertCanManageCredit(tenantId: string, userId: string) {
    if (!Types.ObjectId.isValid(userId)) return;
    const viewer = await this.contactModel.db
      ?.collection('users')
      .findOne({ _id: new Types.ObjectId(userId), tenantId: new Types.ObjectId(tenantId) });
    const role = String(viewer?.role || '').toLowerCase();
    if (!['owner', 'admin', 'super_admin', 'manager'].includes(role)) {
      throw new ForbiddenException(
        'Only Admin, Owner, or Finance Manager can modify B2B credit limits or Credit Hold.',
      );
    }
  }

  private async getReceivableMaps(
    tenantId: string,
    ownerScope: Record<string, unknown> = {},
  ) {
    const byGstin = new Map<string, { open: number; overdue: number }>();
    const byName = new Map<string, { open: number; overdue: number }>();
    const rows =
      (await this.contactModel.db
        ?.collection('invoices')
        .find({
          tenantId: new Types.ObjectId(tenantId),
          ...ownerScope,
          status: { $nin: ['paid', 'cancelled'] },
          docType: { $ne: 'proforma_quote' },
        })
        .toArray()) || [];

    const nowMs = Date.now();
    for (const inv of rows) {
      const grandTotal = Math.max(0, Number(inv.grandTotal) || 0);
      const settled =
        Math.max(0, Number(inv.amountPaid) || 0) +
        Math.max(0, Number(inv.tdsDeducted) || 0);
      const balance =
        inv.balanceDue !== undefined
          ? Math.max(0, Number(inv.balanceDue) || 0)
          : Math.max(0, grandTotal - settled);
      if (balance <= 0) continue;

      const dueMs = inv.dueDate ? new Date(String(inv.dueDate)).getTime() : NaN;
      const isOverdue =
        inv.status === 'overdue' || (Number.isFinite(dueMs) && dueMs < nowMs);

      const gKey = String(inv.gstin || '').trim().toUpperCase();
      if (gKey) {
        const cur = byGstin.get(gKey) || { open: 0, overdue: 0 };
        cur.open += balance;
        if (isOverdue) cur.overdue += balance;
        byGstin.set(gKey, cur);
      }

      const nKey = String(inv.clientName || '').trim().toLowerCase();
      if (nKey) {
        const cur = byName.get(nKey) || { open: 0, overdue: 0 };
        cur.open += balance;
        if (isOverdue) cur.overdue += balance;
        byName.set(nKey, cur);
      }
    }

    return { byGstin, byName };
  }

  private toDto(
    doc: ContactDocument,
    maskPhones = false,
    receivable?: { open: number; overdue: number },
  ) {
    const raw = doc.toObject() as unknown as Record<string, unknown> & {
      createdAt?: Date;
      updatedAt?: Date;
    };
    const gstCheck = doc.gstin ? validateIndianGstin(doc.gstin) : null;
    const creditLimitInr = Math.max(0, Number(doc.creditLimitInr) || 0);
    const openReceivableInr = Math.round(receivable?.open || 0);
    const overdueReceivableInr = Math.round(receivable?.overdue || 0);
    const creditUtilizationPct =
      creditLimitInr > 0
        ? Math.round((openReceivableInr / creditLimitInr) * 100)
        : 0;

    return {
      id: doc._id.toString(),
      tenantId: doc.tenantId.toString(),
      name: doc.name,
      company: doc.company || '',
      designation: doc.designation || '',
      phone: maskPhones ? maskPhoneNumber(doc.phone) : doc.phone || '',
      email: doc.email || '',
      city: doc.city || 'Delhi-NCR',
      gstin: doc.gstin || '',
      gstinStatus:
        doc.gstinStatus && doc.gstinStatus !== 'unverified'
          ? doc.gstinStatus
          : gstCheck?.status || 'unverified',
      gstinStateName: doc.gstinStateName || gstCheck?.stateName || '',
      gstinVerifiedAt: doc.gstinVerifiedAt || '',
      accountKind: doc.accountKind === 'consumer' ? 'consumer' : 'business',
      type: doc.type || 'customer',
      lifetimeValue: doc.lifetimeValue || 0,
      creditLimitInr,
      creditTermDays: Number(doc.creditTermDays ?? 15),
      creditHold: Boolean(doc.creditHold),
      creditHoldReason: doc.creditHoldReason || '',
      openReceivableInr,
      overdueReceivableInr,
      creditUtilizationPct,
      tags: doc.tags || [],
      notes: doc.notes || '',
      customFields: doc.customFields || {},
      portalToken: doc.portalToken || '',
      portalEnabled: doc.portalEnabled !== false,
      portalLastAccessedAt: doc.portalLastAccessedAt || '',
      activities: doc.activities || [],
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
    query: { search?: string; type?: string; accountKind?: string },
  ) {
    const tenantObjectId = new Types.ObjectId(auth.tenantId);
    const ownerScope = await resolveOwnerScopeFilter(this.contactModel.db, auth);
    const baseScope: Record<string, unknown> = {
      tenantId: tenantObjectId,
      ...ownerScope,
    };
    const filter: Record<string, unknown> = { ...baseScope };

    if (query.type && query.type !== 'all') {
      filter.type = query.type;
    }
    if (query.accountKind === 'consumer') {
      filter.accountKind = 'consumer';
    } else if (query.accountKind === 'business') {
      filter.accountKind = { $ne: 'consumer' };
    }
    if (query.search?.trim()) {
      const regex = new RegExp(query.search.trim(), 'i');
      filter.$or = [
        { name: regex },
        { company: regex },
        { phone: regex },
        { email: regex },
        { city: regex },
        { gstin: regex },
      ];
    }

    const [docs, all, maskPhones, recMaps] = await Promise.all([
      this.contactModel.find(filter).sort({ createdAt: -1 }).exec(),
      this.contactModel.find(baseScope).exec(),
      this.auditService
        ? this.auditService.shouldMaskViewerPhones(auth.tenantId, auth.userId)
        : Promise.resolve(false),
      this.getReceivableMaps(auth.tenantId, ownerScope),
    ]);

    const resolveRec = (c: ContactDocument) => {
      const gKey = String(c.gstin || '').trim().toUpperCase();
      if (gKey && recMaps.byGstin.has(gKey)) return recMaps.byGstin.get(gKey);
      const cKey = String(c.company || '').trim().toLowerCase();
      if (cKey && recMaps.byName.has(cKey)) return recMaps.byName.get(cKey);
      const nKey = String(c.name || '').trim().toLowerCase();
      return recMaps.byName.get(nKey);
    };

    return {
      data: docs.map((d) => this.toDto(d, maskPhones, resolveRec(d))),
      stats: {
        total: all.length,
        businessCount: all.filter((c) => c.accountKind !== 'consumer').length,
        consumerCount: all.filter((c) => c.accountKind === 'consumer').length,
        customers: all.filter((c) => c.type === 'customer').length,
        prospects: all.filter((c) => c.type === 'prospect').length,
        creditHoldCount: all.filter((c) => c.creditHold).length,
        totalLtv: all.reduce((s, c) => s + (Number(c.lifetimeValue) || 0), 0),
      },
    };
  }

  async findOne(auth: { userId: string; tenantId: string }, id: string) {
    if (!Types.ObjectId.isValid(id))
      throw new NotFoundException('Contact not found.');
    const ownerScope = await resolveOwnerScopeFilter(this.contactModel.db, auth);
    const doc = await this.contactModel
      .findOne({
        _id: new Types.ObjectId(id),
        tenantId: new Types.ObjectId(auth.tenantId),
        ...ownerScope,
      })
      .exec();
    if (!doc) throw new NotFoundException('Contact not found.');
    const [maskPhones, recMaps] = await Promise.all([
      this.auditService
        ? this.auditService.shouldMaskViewerPhones(auth.tenantId, auth.userId)
        : Promise.resolve(false),
      this.getReceivableMaps(auth.tenantId, ownerScope),
    ]);
    const rec =
      (doc.gstin && recMaps.byGstin.get(doc.gstin.trim().toUpperCase())) ||
      (doc.company && recMaps.byName.get(doc.company.trim().toLowerCase())) ||
      recMaps.byName.get(doc.name.trim().toLowerCase());
    return this.toDto(doc, maskPhones, rec);
  }

  async create(
    auth: { userId: string; tenantId: string },
    dto: CreateContactDto,
  ) {
    if (!dto.name?.trim())
      throw new BadRequestException('Contact name is required.');
    if (
      dto.creditHold !== undefined ||
      dto.creditLimitInr !== undefined
    ) {
      await this.assertCanManageCredit(auth.tenantId, auth.userId);
    }

    const cleanGstin = dto.gstin?.trim().toUpperCase() || '';
    const gstCheck = cleanGstin ? validateIndianGstin(cleanGstin) : null;

    const sanitizedCustomFields = this.customFieldsService
      ? await this.customFieldsService.sanitizeEntityValues(
          auth.tenantId,
          'contact',
          dto.customFields,
        )
      : dto.customFields || {};

    const doc = await this.contactModel.create({
      tenantId: new Types.ObjectId(auth.tenantId),
      ownerId: new Types.ObjectId(auth.userId),
      name: dto.name.trim(),
      company: dto.company?.trim() || '',
      designation: dto.designation?.trim() || '',
      phone: dto.phone?.trim() || '',
      email: dto.email?.trim().toLowerCase() || '',
      city: dto.city?.trim() || 'New Delhi',
      gstin: cleanGstin,
      gstinStatus: gstCheck ? gstCheck.status : 'unverified',
      gstinStateName: gstCheck?.stateName || '',
      gstinVerifiedAt: gstCheck?.valid ? new Date().toISOString() : '',
      accountKind: dto.accountKind === 'consumer' ? 'consumer' : 'business',
      type: dto.type || 'customer',
      lifetimeValue: Number(dto.lifetimeValue) || 0,
      creditLimitInr: Math.max(0, Number(dto.creditLimitInr) || 0),
      creditTermDays: Math.max(0, Number(dto.creditTermDays ?? 15)),
      creditHold: Boolean(dto.creditHold),
      creditHoldReason: dto.creditHoldReason?.trim() || '',
      tags: Array.isArray(dto.tags) ? dto.tags : [],
      notes: dto.notes?.trim() || '',
      customFields: sanitizedCustomFields,
    });
    return this.toDto(doc);
  }

  async update(
    auth: { userId: string; tenantId: string },
    id: string,
    dto: Partial<CreateContactDto>,
  ) {
    if (!Types.ObjectId.isValid(id))
      throw new NotFoundException('Contact not found.');
    const ownerScope = await resolveOwnerScopeFilter(this.contactModel.db, auth);
    const doc = await this.contactModel
      .findOne({
        _id: new Types.ObjectId(id),
        tenantId: new Types.ObjectId(auth.tenantId),
        ...ownerScope,
      })
      .exec();
    if (!doc) throw new NotFoundException('Contact not found.');

    if (
      dto.creditLimitInr !== undefined ||
      dto.creditHold !== undefined ||
      dto.creditTermDays !== undefined
    ) {
      await this.assertCanManageCredit(auth.tenantId, auth.userId);
    }

    if (dto.name !== undefined) doc.name = dto.name.trim();
    if (dto.company !== undefined) doc.company = dto.company.trim();
    if (dto.designation !== undefined)
      doc.designation = dto.designation.trim();
    if (dto.phone !== undefined) doc.phone = dto.phone.trim();
    if (dto.email !== undefined) doc.email = dto.email.trim().toLowerCase();
    if (dto.city !== undefined) doc.city = dto.city.trim();
    if (dto.gstin !== undefined) {
      doc.gstin = dto.gstin.trim().toUpperCase();
      if (doc.gstin) {
        const check = validateIndianGstin(doc.gstin);
        doc.gstinStatus = check.status;
        doc.gstinStateName = check.stateName;
        doc.gstinVerifiedAt = check.valid ? new Date().toISOString() : '';
      } else {
        doc.gstinStatus = 'unverified';
        doc.gstinStateName = '';
        doc.gstinVerifiedAt = '';
      }
    }
    if (dto.accountKind !== undefined) {
      doc.accountKind = dto.accountKind === 'consumer' ? 'consumer' : 'business';
    }
    if (dto.type !== undefined) doc.type = dto.type;
    if (dto.lifetimeValue !== undefined)
      doc.lifetimeValue = Number(dto.lifetimeValue) || 0;
    if (dto.creditLimitInr !== undefined)
      doc.creditLimitInr = Math.max(0, Number(dto.creditLimitInr) || 0);
    if (dto.creditTermDays !== undefined)
      doc.creditTermDays = Math.max(0, Number(dto.creditTermDays) || 0);
    if (dto.creditHold !== undefined) doc.creditHold = Boolean(dto.creditHold);
    if (dto.creditHoldReason !== undefined)
      doc.creditHoldReason = dto.creditHoldReason.trim();
    if (dto.tags !== undefined) doc.tags = dto.tags;
    if (dto.notes !== undefined) doc.notes = dto.notes.trim();
    if (dto.customFields !== undefined) {
      doc.customFields = this.customFieldsService
        ? await this.customFieldsService.sanitizeEntityValues(
            auth.tenantId,
            'contact',
            dto.customFields,
            doc.customFields,
          )
        : { ...(doc.customFields || {}), ...dto.customFields };
      doc.markModified('customFields');
    }

    await doc.save();

    if (
      dto.creditLimitInr !== undefined ||
      dto.creditHold !== undefined
    ) {
      await this.auditService?.record({
        tenantId: auth.tenantId,
        actorId: auth.userId,
        action: 'contact.credit_policy_updated',
        entityType: 'contact',
        entityId: doc._id.toString(),
        entityLabel: `${doc.company || doc.name}`,
        summary: `Updated credit controls for ${doc.company || doc.name}: Limit ₹${(doc.creditLimitInr || 0).toLocaleString('en-IN')}, Terms Net ${doc.creditTermDays}d, Credit Hold: ${doc.creditHold ? 'ON' : 'OFF'}`,
      });
    }

    return this.toDto(doc);
  }

  async verifyGstin(
    auth: { userId: string; tenantId: string },
    id: string,
    overrideGstin?: string,
  ) {
    if (!Types.ObjectId.isValid(id))
      throw new NotFoundException('Contact not found.');
    const ownerScope = await resolveOwnerScopeFilter(this.contactModel.db, auth);
    const doc = await this.contactModel
      .findOne({
        _id: new Types.ObjectId(id),
        tenantId: new Types.ObjectId(auth.tenantId),
        ...ownerScope,
      })
      .exec();
    if (!doc) throw new NotFoundException('Contact not found.');

    const targetGstin = (overrideGstin ?? doc.gstin ?? '').trim().toUpperCase();
    const check = validateIndianGstin(targetGstin);
    if (overrideGstin !== undefined) {
      doc.gstin = targetGstin;
    }
    doc.gstinStatus = check.status;
    doc.gstinStateName = check.stateName;
    doc.gstinVerifiedAt = new Date().toISOString();
    await doc.save();

    await this.auditService?.record({
      tenantId: auth.tenantId,
      actorId: auth.userId,
      action: 'contact.gstin_verified',
      entityType: 'contact',
      entityId: doc._id.toString(),
      entityLabel: `${doc.company || doc.name} · ${targetGstin || 'NONE'}`,
      summary: `GSTIN verification (${check.status}): ${check.reason}`,
    });

    return {
      validation: check,
      contact: this.toDto(doc),
    };
  }

  async remove(auth: { userId: string; tenantId: string }, id: string) {
    if (!Types.ObjectId.isValid(id))
      throw new NotFoundException('Contact not found.');
    const ownerScope = await resolveOwnerScopeFilter(this.contactModel.db, auth);
    const doc = await this.contactModel
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
        action: 'contact.deleted',
        entityType: 'contact',
        entityId: id,
        entityLabel: `${doc.name}${doc.company ? ` (${doc.company})` : ''}`,
        summary: `Deleted B2B contact ${doc.name}`,
      });
    }
    return { success: true, id };
  }
}
