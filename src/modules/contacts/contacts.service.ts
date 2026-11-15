import {
  BadRequestException,
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
import { maskPhoneNumber } from '../auth/identity.util';
import { CreateContactDto } from './dto/contacts.dto';

export type ContactDocument = HydratedDocument<Contact>;

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
    default: 'customer',
    enum: ['customer', 'prospect', 'partner', 'vendor'],
  })
  type!: 'customer' | 'prospect' | 'partner' | 'vendor';

  @Prop({ type: Number, default: 0 })
  lifetimeValue!: number;

  @Prop({ type: [String], default: [] })
  tags!: string[];

  @Prop({ default: '' })
  notes!: string;
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

  private toDto(doc: ContactDocument, maskPhones = false) {
    const raw = doc.toObject() as unknown as Record<string, unknown> & {
      createdAt?: Date;
      updatedAt?: Date;
    };
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
      type: doc.type || 'customer',
      lifetimeValue: doc.lifetimeValue || 0,
      tags: doc.tags || [],
      notes: doc.notes || '',
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
    query: { search?: string; type?: string },
  ) {
    const tenantObjectId = new Types.ObjectId(auth.tenantId);
    const filter: Record<string, unknown> = { tenantId: tenantObjectId };

    if (query.type && query.type !== 'all') {
      filter.type = query.type;
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

    const [docs, all, maskPhones] = await Promise.all([
      this.contactModel.find(filter).sort({ createdAt: -1 }).exec(),
      this.contactModel.find({ tenantId: tenantObjectId }).exec(),
      this.auditService
        ? this.auditService.shouldMaskViewerPhones(auth.tenantId, auth.userId)
        : Promise.resolve(false),
    ]);

    return {
      data: docs.map((d) => this.toDto(d, maskPhones)),
      stats: {
        total: all.length,
        customers: all.filter((c) => c.type === 'customer').length,
        prospects: all.filter((c) => c.type === 'prospect').length,
        totalLtv: all.reduce((s, c) => s + (Number(c.lifetimeValue) || 0), 0),
      },
    };
  }

  async findOne(auth: { userId: string; tenantId: string }, id: string) {
    if (!Types.ObjectId.isValid(id))
      throw new NotFoundException('Contact not found.');
    const doc = await this.contactModel
      .findOne({
        _id: new Types.ObjectId(id),
        tenantId: new Types.ObjectId(auth.tenantId),
      })
      .exec();
    if (!doc) throw new NotFoundException('Contact not found.');
    const maskPhones = this.auditService
      ? await this.auditService.shouldMaskViewerPhones(auth.tenantId, auth.userId)
      : false;
    return this.toDto(doc, maskPhones);
  }

  async create(
    auth: { userId: string; tenantId: string },
    dto: CreateContactDto,
  ) {
    if (!dto.name?.trim())
      throw new BadRequestException('Contact name is required.');
    const doc = await this.contactModel.create({
      tenantId: new Types.ObjectId(auth.tenantId),
      ownerId: new Types.ObjectId(auth.userId),
      name: dto.name.trim(),
      company: dto.company?.trim() || '',
      designation: dto.designation?.trim() || '',
      phone: dto.phone?.trim() || '',
      email: dto.email?.trim().toLowerCase() || '',
      city: dto.city?.trim() || 'New Delhi',
      gstin: dto.gstin?.trim().toUpperCase() || '',
      type: dto.type || 'customer',
      lifetimeValue: Number(dto.lifetimeValue) || 0,
      tags: Array.isArray(dto.tags) ? dto.tags : [],
      notes: dto.notes?.trim() || '',
    });
    return this.toDto(doc);
  }

  async update(
    auth: { tenantId: string },
    id: string,
    dto: Partial<CreateContactDto>,
  ) {
    if (!Types.ObjectId.isValid(id))
      throw new NotFoundException('Contact not found.');
    const doc = await this.contactModel
      .findOne({
        _id: new Types.ObjectId(id),
        tenantId: new Types.ObjectId(auth.tenantId),
      })
      .exec();
    if (!doc) throw new NotFoundException('Contact not found.');

    if (dto.name !== undefined) doc.name = dto.name.trim();
    if (dto.company !== undefined) doc.company = dto.company.trim();
    if (dto.designation !== undefined)
      doc.designation = dto.designation.trim();
    if (dto.phone !== undefined) doc.phone = dto.phone.trim();
    if (dto.email !== undefined) doc.email = dto.email.trim().toLowerCase();
    if (dto.city !== undefined) doc.city = dto.city.trim();
    if (dto.gstin !== undefined) doc.gstin = dto.gstin.trim().toUpperCase();
    if (dto.type !== undefined) doc.type = dto.type;
    if (dto.lifetimeValue !== undefined)
      doc.lifetimeValue = Number(dto.lifetimeValue) || 0;
    if (dto.tags !== undefined) doc.tags = dto.tags;
    if (dto.notes !== undefined) doc.notes = dto.notes.trim();

    await doc.save();
    return this.toDto(doc);
  }

  async remove(auth: { userId: string; tenantId: string }, id: string) {
    if (!Types.ObjectId.isValid(id))
      throw new NotFoundException('Contact not found.');
    const doc = await this.contactModel
      .findOneAndDelete({
        _id: new Types.ObjectId(id),
        tenantId: new Types.ObjectId(auth.tenantId),
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

  async seedSamples(auth: { userId: string; tenantId: string }) {
    const samples: CreateContactDto[] = [
      {
        name: 'Rajesh Sharma',
        company: 'RS Electricals Pvt. Ltd.',
        designation: 'Managing Director',
        phone: '+91 98112 45678',
        email: 'rajesh@rselectricals.in',
        city: 'Karol Bagh, New Delhi',
        gstin: '07AABCR1234F1Z5',
        type: 'customer',
        lifetimeValue: 1250000,
        tags: ['VIP Buyer', 'GST Registered'],
        notes: 'Prefers WhatsApp proforma invoices before dispatch.',
      },
      {
        name: 'Priya Malhotra',
        company: 'Malhotra Luxury Interiors',
        designation: 'Principal Architect',
        phone: '+91 98180 23451',
        email: 'priya@malhotrainteriors.com',
        city: 'Sector 62, Noida',
        gstin: '09AAECM5678G1Z2',
        type: 'prospect',
        lifetimeValue: 380000,
        tags: ['Noida Commercial', 'Architect'],
        notes: 'Looking for recurring modular furniture vendor.',
      },
      {
        name: 'Vikramjit Singh',
        company: 'Apex Auto Components',
        designation: 'Head of Procurement',
        phone: '+91 99104 88712',
        email: 'vikram@apexauto.in',
        city: 'Udyog Vihar, Gurugram',
        gstin: '06AABCA9012H1Z8',
        type: 'customer',
        lifetimeValue: 1840000,
        tags: ['Annual AMC', 'Tier-1 OEM'],
        notes: '30-day credit cycle approved.',
      },
      {
        name: 'Sandeep Bansal',
        company: 'Bansal Steel & Infra',
        designation: 'Director',
        phone: '+91 98711 65090',
        email: 'sandeep@bansalinfra.in',
        city: 'Okhla Phase III, New Delhi',
        gstin: '07AABCB3456J1Z1',
        type: 'partner',
        lifetimeValue: 2400000,
        tags: ['Strategic Partner', 'Okhla Hub'],
        notes: 'Refers 3-4 industrial buyers every quarter.',
      },
    ];
    const created = [];
    for (const s of samples) {
      created.push(await this.create(auth, s));
    }
    return { count: created.length, data: created };
  }
}
