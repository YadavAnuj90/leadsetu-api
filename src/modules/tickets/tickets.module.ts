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

export type TicketCategory =
  | 'dispatch_delay'
  | 'warranty'
  | 'gst_correction'
  | 'installation'
  | 'general';
export type TicketPriority = 'low' | 'medium' | 'high' | 'urgent';
export type TicketStatus =
  | 'open'
  | 'in_progress'
  | 'waiting_client'
  | 'resolved'
  | 'closed';

export type TicketDocument = HydratedDocument<Ticket>;

@Schema({ timestamps: true, collection: 'tickets' })
export class Ticket {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  ownerId!: Types.ObjectId;

  @Prop({ required: true, trim: true, index: true })
  ticketNumber!: string;

  @Prop({ required: true, trim: true })
  subject!: string;

  @Prop({
    default: 'general',
    enum: ['dispatch_delay', 'warranty', 'gst_correction', 'installation', 'general'],
  })
  category!: TicketCategory;

  @Prop({ default: 'medium', enum: ['low', 'medium', 'high', 'urgent'] })
  priority!: TicketPriority;

  @Prop({
    default: 'open',
    enum: ['open', 'in_progress', 'waiting_client', 'resolved', 'closed'],
    index: true,
  })
  status!: TicketStatus;

  @Prop({ trim: true, default: '' })
  customerName!: string;

  @Prop({ trim: true, default: '' })
  company!: string;

  @Prop({ trim: true, default: '' })
  phone!: string;

  @Prop({ trim: true, default: '' })
  slaDueAt!: string;

  @Prop({ trim: true, default: '' })
  notes!: string;

  @Prop({ trim: true, default: '' })
  linkedInvoiceNumber!: string;
}

export const TicketSchema = SchemaFactory.createForClass(Ticket);

export class CreateTicketDto {
  @ApiProperty({ example: 'GSTIN State Code Update for INV-2026-004' })
  subject!: string;

  @ApiPropertyOptional({
    enum: ['dispatch_delay', 'warranty', 'gst_correction', 'installation', 'general'],
    default: 'general',
  })
  category?: TicketCategory;

  @ApiPropertyOptional({ enum: ['low', 'medium', 'high', 'urgent'], default: 'medium' })
  priority?: TicketPriority;

  @ApiPropertyOptional({
    enum: ['open', 'in_progress', 'waiting_client', 'resolved', 'closed'],
    default: 'open',
  })
  status?: TicketStatus;

  @ApiPropertyOptional({ example: 'Rajesh Sharma' })
  customerName?: string;

  @ApiPropertyOptional({ example: 'RS Electricals Pvt. Ltd.' })
  company?: string;

  @ApiPropertyOptional({ example: '+91 98112 45678' })
  phone?: string;

  @ApiPropertyOptional({ example: '2026-11-16' })
  slaDueAt?: string;

  @ApiPropertyOptional({ example: 'Client requested billing state correction.' })
  notes?: string;

  @ApiPropertyOptional({ example: 'LS-2026-104' })
  linkedInvoiceNumber?: string;
}

export type UpdateTicketDto = Partial<CreateTicketDto>;

interface AuthContext {
  userId: string;
  tenantId: string;
  email: string;
}

@Injectable()
export class TicketsService {
  constructor(
    @InjectModel(Ticket.name) private readonly ticketModel: Model<TicketDocument>,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    @Optional() private readonly auditService?: AuditService,
  ) {}

  async verifyAuth(authHeader?: string): Promise<AuthContext> {
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

  private toDto(doc: TicketDocument, maskPhones = false) {
    const raw = doc.toObject() as unknown as {
      createdAt?: Date;
      updatedAt?: Date;
    };
    const isResolved = doc.status === 'resolved' || doc.status === 'closed';
    const isSlaBreached =
      !isResolved &&
      Boolean(doc.slaDueAt) &&
      new Date(doc.slaDueAt).getTime() < Date.now() - 86400000;

    return {
      id: doc._id.toString(),
      tenantId: doc.tenantId.toString(),
      ownerId: doc.ownerId.toString(),
      ticketNumber: doc.ticketNumber,
      subject: doc.subject,
      category: doc.category,
      priority: doc.priority,
      status: doc.status,
      customerName: doc.customerName || '',
      company: doc.company || '',
      phone: maskPhones ? maskPhoneNumber(doc.phone) : doc.phone || '',
      slaDueAt: doc.slaDueAt || '',
      isSlaBreached,
      notes: doc.notes || '',
      linkedInvoiceNumber: doc.linkedInvoiceNumber || '',
      createdAt: raw.createdAt
        ? new Date(raw.createdAt).toISOString()
        : new Date().toISOString(),
      updatedAt: raw.updatedAt
        ? new Date(raw.updatedAt).toISOString()
        : new Date().toISOString(),
    };
  }

  async findAll(
    auth: AuthContext,
    query: { status?: string; priority?: string; search?: string },
  ) {
    const tenantObjectId = new Types.ObjectId(auth.tenantId);
    const filter: Record<string, unknown> = { tenantId: tenantObjectId };

    if (query.status && query.status !== 'all') {
      filter.status = query.status;
    }
    if (query.priority && query.priority !== 'all') {
      filter.priority = query.priority;
    }
    if (query.search?.trim()) {
      const rx = new RegExp(query.search.trim(), 'i');
      filter.$or = [
        { ticketNumber: rx },
        { subject: rx },
        { customerName: rx },
        { company: rx },
        { linkedInvoiceNumber: rx },
      ];
    }

    const [docs, allDocs, maskPhones] = await Promise.all([
      this.ticketModel.find(filter).sort({ createdAt: -1 }).exec(),
      this.ticketModel.find({ tenantId: tenantObjectId }).exec(),
      this.auditService
        ? this.auditService.shouldMaskViewerPhones(auth.tenantId, auth.userId)
        : Promise.resolve(false),
    ]);

    const mappedAll = allDocs.map((d) => this.toDto(d, maskPhones));
    return {
      data: docs.map((d) => this.toDto(d, maskPhones)),
      stats: {
        total: allDocs.length,
        openCount: allDocs.filter((t) =>
          ['open', 'in_progress', 'waiting_client'].includes(t.status),
        ).length,
        urgentCount: allDocs.filter(
          (t) =>
            (t.priority === 'urgent' || t.priority === 'high') &&
            !['resolved', 'closed'].includes(t.status),
        ).length,
        resolvedCount: allDocs.filter((t) =>
          ['resolved', 'closed'].includes(t.status),
        ).length,
        slaBreachedCount: mappedAll.filter((t) => t.isSlaBreached).length,
      },
    };
  }

  async create(auth: AuthContext, dto: CreateTicketDto) {
    if (!dto.subject?.trim()) {
      throw new BadRequestException('Ticket subject is required.');
    }

    const existingCount = await this.ticketModel
      .countDocuments({ tenantId: new Types.ObjectId(auth.tenantId) })
      .exec();
    const ticketNumber = `TKT-2026-${String(existingCount + 101)}`;
    const defaultSla = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);

    const doc = await this.ticketModel.create({
      tenantId: new Types.ObjectId(auth.tenantId),
      ownerId: new Types.ObjectId(auth.userId),
      ticketNumber,
      subject: dto.subject.trim(),
      category: dto.category || 'general',
      priority: dto.priority || 'medium',
      status: dto.status || 'open',
      customerName: dto.customerName?.trim() || '',
      company: dto.company?.trim() || '',
      phone: dto.phone?.trim() || '',
      slaDueAt: dto.slaDueAt || defaultSla,
      notes: dto.notes?.trim() || '',
      linkedInvoiceNumber: dto.linkedInvoiceNumber?.trim() || '',
    });

    await this.auditService?.record({
      tenantId: auth.tenantId,
      actorId: auth.userId,
      actorEmail: auth.email,
      action: 'ticket.created',
      entityType: 'ticket',
      entityId: doc._id.toString(),
      entityLabel: `${ticketNumber} · ${doc.subject}`,
      summary: `Opened SLA ticket ${ticketNumber} (${doc.priority.toUpperCase()} priority)`,
    });

    const maskPhones = this.auditService
      ? await this.auditService.shouldMaskViewerPhones(auth.tenantId, auth.userId)
      : false;
    return this.toDto(doc, maskPhones);
  }

  async update(auth: AuthContext, id: string, dto: UpdateTicketDto) {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Ticket not found.');
    }
    const doc = await this.ticketModel
      .findOne({
        _id: new Types.ObjectId(id),
        tenantId: new Types.ObjectId(auth.tenantId),
      })
      .exec();
    if (!doc) {
      throw new NotFoundException('Ticket not found.');
    }

    const prevStatus = doc.status;
    if (dto.subject !== undefined) doc.subject = dto.subject.trim();
    if (dto.category !== undefined) doc.category = dto.category;
    if (dto.priority !== undefined) doc.priority = dto.priority;
    if (dto.status !== undefined) doc.status = dto.status;
    if (dto.customerName !== undefined) doc.customerName = dto.customerName.trim();
    if (dto.company !== undefined) doc.company = dto.company.trim();
    if (dto.phone !== undefined) doc.phone = dto.phone.trim();
    if (dto.slaDueAt !== undefined) doc.slaDueAt = dto.slaDueAt;
    if (dto.notes !== undefined) doc.notes = dto.notes.trim();
    if (dto.linkedInvoiceNumber !== undefined) {
      doc.linkedInvoiceNumber = dto.linkedInvoiceNumber.trim();
    }

    await doc.save();

    if (dto.status && dto.status !== prevStatus) {
      await this.auditService?.record({
        tenantId: auth.tenantId,
        actorId: auth.userId,
        actorEmail: auth.email,
        action: 'ticket.status_changed',
        entityType: 'ticket',
        entityId: doc._id.toString(),
        entityLabel: `${doc.ticketNumber} · ${doc.subject}`,
        summary: `Ticket ${doc.ticketNumber} moved ${prevStatus} -> ${dto.status}`,
      });
    }

    const maskPhones = this.auditService
      ? await this.auditService.shouldMaskViewerPhones(auth.tenantId, auth.userId)
      : false;
    return this.toDto(doc, maskPhones);
  }

  async remove(auth: AuthContext, id: string) {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Ticket not found.');
    }
    const doc = await this.ticketModel
      .findOneAndDelete({
        _id: new Types.ObjectId(id),
        tenantId: new Types.ObjectId(auth.tenantId),
      })
      .exec();

    if (doc) {
      await this.auditService?.record({
        tenantId: auth.tenantId,
        actorId: auth.userId,
        actorEmail: auth.email,
        action: 'ticket.deleted',
        entityType: 'ticket',
        entityId: id,
        entityLabel: `${doc.ticketNumber} · ${doc.subject}`,
        summary: `Deleted support ticket ${doc.ticketNumber}`,
      });
    }

    return { success: true, id };
  }

  async seedSampleTickets(auth: AuthContext) {
    const samples: CreateTicketDto[] = [
      {
        subject: 'Switchgear Dispatch Transporter E-Way Bill Verification',
        category: 'dispatch_delay',
        priority: 'urgent',
        status: 'in_progress',
        customerName: 'Rajesh Sharma',
        company: 'RS Electricals Pvt. Ltd.',
        phone: '+91 98112 45678',
        slaDueAt: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
        linkedInvoiceNumber: 'LS-2026-101',
        notes: 'Vehicle No. DL-1GC-4821 waiting for updated E-Way Bill Part-B.',
      },
      {
        subject: 'Update Buyer GSTIN & Place of Supply on Proforma',
        category: 'gst_correction',
        priority: 'high',
        status: 'open',
        customerName: 'Vikramjit Singh',
        company: 'Apex Auto Components',
        phone: '+91 99104 88712',
        slaDueAt: new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10),
        linkedInvoiceNumber: 'LS-2026-102',
        notes: 'Requested IGST billing for Gurugram plant (06 - Haryana).',
      },
      {
        subject: 'Rooftop Solar 50kW Site Commissioning Inspection',
        category: 'installation',
        priority: 'medium',
        status: 'resolved',
        customerName: 'Sandeep Bansal',
        company: 'Bansal Steel & Infra',
        phone: '+91 98711 65090',
        slaDueAt: new Date(Date.now() - 86400000).toISOString().slice(0, 10),
        notes: 'Engineer visited Okhla Phase III and signed off installation checklist.',
      },
    ];

    const created = [];
    for (const s of samples) {
      created.push(await this.create(auth, s));
    }
    return { count: created.length, data: created };
  }
}

@ApiTags('13. Support & SLA Tickets')
@ApiBearerAuth('access-token')
@Controller('tickets')
export class TicketsController {
  constructor(private readonly ticketsService: TicketsService) {}

  @Get()
  @ApiOperation({ summary: 'List customer support & dispatch SLA tickets' })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'priority', required: false })
  @ApiQuery({ name: 'search', required: false })
  @ApiResponse({ status: 200, description: 'Returns `{ data: Ticket[], stats }`.' })
  async list(
    @Headers('authorization') authorization: string | undefined,
    @Query() query: { status?: string; priority?: string; search?: string },
  ) {
    const auth = await this.ticketsService.verifyAuth(authorization);
    return this.ticketsService.findAll(auth, query);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a customer support / SLA ticket' })
  @ApiBody({ type: CreateTicketDto })
  async create(
    @Headers('authorization') authorization: string | undefined,
    @Body() dto: CreateTicketDto,
  ) {
    const auth = await this.ticketsService.verifyAuth(authorization);
    return this.ticketsService.create(auth, dto);
  }

  @Post('seed')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Seed sample Delhi-NCR dispatch & GST support tickets' })
  async seed(@Headers('authorization') authorization: string | undefined) {
    const auth = await this.ticketsService.verifyAuth(authorization);
    return this.ticketsService.seedSampleTickets(auth);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update ticket status, priority, or notes' })
  @ApiParam({ name: 'id', description: 'Ticket ObjectId' })
  async update(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
    @Body() dto: UpdateTicketDto,
  ) {
    const auth = await this.ticketsService.verifyAuth(authorization);
    return this.ticketsService.update(auth, id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a support ticket' })
  @ApiParam({ name: 'id', description: 'Ticket ObjectId' })
  async remove(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
  ) {
    const auth = await this.ticketsService.verifyAuth(authorization);
    return this.ticketsService.remove(auth, id);
  }
}

@Module({
  imports: [
    ConfigModule,
    MongooseModule.forFeature([{ name: Ticket.name, schema: TicketSchema }]),
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
  controllers: [TicketsController],
  providers: [TicketsService],
  exports: [TicketsService],
})
export class TicketsModule {}
