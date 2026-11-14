import {
  BadRequestException,
  Body,
  Controller,
  Delete,
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
import { AuditService } from '../audit/audit.module';
import { maskPhoneNumber } from '../auth/identity.util';

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

export class CreateContactDto {
  @ApiProperty({
    description: 'Full name of the B2B contact / decision-maker',
    example: 'Rajesh Sharma',
  })
  name!: string;

  @ApiPropertyOptional({
    description: 'Registered company / business name',
    example: 'RS Electricals Pvt. Ltd.',
  })
  company?: string;

  @ApiPropertyOptional({
    description: 'Job title / designation',
    example: 'Managing Director',
  })
  designation?: string;

  @ApiPropertyOptional({
    description: 'WhatsApp / mobile phone number (+91)',
    example: '+91 98112 45678',
  })
  phone?: string;

  @ApiPropertyOptional({
    description: 'Work email address',
    example: 'rajesh@rselectricals.in',
  })
  email?: string;

  @ApiPropertyOptional({
    description: 'City / industrial hub',
    example: 'Noida Electronic City',
    default: 'New Delhi',
  })
  city?: string;

  @ApiPropertyOptional({
    description: '15-digit Indian GSTIN tax identification number',
    example: '09AABCR1234F1Z5',
  })
  gstin?: string;

  @ApiPropertyOptional({
    description: 'B2B account relationship type',
    enum: ['customer', 'prospect', 'partner', 'vendor'],
    default: 'customer',
    example: 'customer',
  })
  type?: 'customer' | 'prospect' | 'partner' | 'vendor';

  @ApiPropertyOptional({
    description: 'Cumulative Lifetime Value (LTV) in INR (₹)',
    example: 1250000,
    default: 0,
  })
  lifetimeValue?: number;

  @ApiPropertyOptional({
    description: 'Account classification tags',
    type: [String],
    example: ['VIP Buyer', 'GST Registered'],
  })
  tags?: string[];

  @ApiPropertyOptional({
    description: 'Account notes & billing preferences',
    example: 'Prefers WhatsApp proforma invoices before dispatch.',
  })
  notes?: string;
}

export class UpdateContactDto extends CreateContactDto {}

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

@ApiTags('4. Contacts & GST Directory')
@ApiBearerAuth('access-token')
@Controller('contacts')
export class ContactsController {
  constructor(private readonly contactsService: ContactsService) {}

  @Get()
  @ApiOperation({
    summary: 'List all B2B contacts, GSTIN records & cumulative LTV stats',
  })
  @ApiQuery({
    name: 'search',
    required: false,
    description: 'Search by contact name, company, 15-digit GSTIN, phone, or city',
    example: '07AABCR',
  })
  @ApiQuery({
    name: 'type',
    required: false,
    enum: ['all', 'customer', 'prospect', 'partner', 'vendor'],
    description: 'Filter by B2B account type',
  })
  @ApiResponse({
    status: 200,
    description: 'Returns `{ data: Contact[], stats: ContactsStats }`.',
  })
  async findAll(
    @Headers('authorization') authorization: string | undefined,
    @Query() query: { search?: string; type?: string },
  ) {
    const auth = await this.contactsService.verifyAuth(authorization);
    return this.contactsService.findAll(auth, query);
  }

  @Post('seed')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Seed 4 sample Delhi-NCR B2B contacts with verified GSTIN numbers',
  })
  @ApiResponse({ status: 201, description: '4 sample contacts created.' })
  async seed(@Headers('authorization') authorization: string | undefined) {
    const auth = await this.contactsService.verifyAuth(authorization);
    return this.contactsService.seedSamples(auth);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get 360° profile for a single B2B contact by ID',
  })
  @ApiParam({
    name: 'id',
    description: 'MongoDB ObjectId of the contact',
    example: '672e1a2b3c4d5e6f7a8b9c0d',
  })
  @ApiResponse({ status: 200, description: 'Contact profile returned.' })
  async findOne(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
  ) {
    const auth = await this.contactsService.verifyAuth(authorization);
    return this.contactsService.findOne(auth, id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a new B2B contact & GST account record',
  })
  @ApiBody({ type: CreateContactDto })
  @ApiResponse({ status: 201, description: 'Contact created.' })
  async create(
    @Headers('authorization') authorization: string | undefined,
    @Body() dto: CreateContactDto,
  ) {
    const auth = await this.contactsService.verifyAuth(authorization);
    return this.contactsService.create(auth, dto);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update B2B contact details, GSTIN, or Lifetime Value',
  })
  @ApiParam({
    name: 'id',
    description: 'MongoDB ObjectId of the contact',
    example: '672e1a2b3c4d5e6f7a8b9c0d',
  })
  @ApiBody({ type: UpdateContactDto })
  @ApiResponse({ status: 200, description: 'Contact updated.' })
  async update(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
    @Body() dto: UpdateContactDto,
  ) {
    const auth = await this.contactsService.verifyAuth(authorization);
    return this.contactsService.update(auth, id, dto);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Delete a contact from the directory',
  })
  @ApiParam({
    name: 'id',
    description: 'MongoDB ObjectId of the contact',
    example: '672e1a2b3c4d5e6f7a8b9c0d',
  })
  @ApiResponse({ status: 200, description: 'Contact deleted.' })
  async remove(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
  ) {
    const auth = await this.contactsService.verifyAuth(authorization);
    return this.contactsService.remove(auth, id);
  }
}

@Module({
  imports: [
    ConfigModule,
    MongooseModule.forFeature([{ name: Contact.name, schema: ContactSchema }]),
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
  controllers: [ContactsController],
  providers: [ContactsService],
  exports: [ContactsService],
})
export class ContactsModule {}
