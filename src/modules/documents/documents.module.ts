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
  ApiTags,
} from '@nestjs/swagger';
import { HydratedDocument, Model, Types } from 'mongoose';
import { randomBytes } from 'crypto';
import { AuditService } from '../audit/audit.module';
import { SuperAdminService } from '../super-admin/super-admin.service';

export type DocumentCategory =
  | 'gst_certificate'
  | 'company_profile'
  | 'brochure'
  | 'contract'
  | 'customer_document';

export type CrmDocumentRecord = HydratedDocument<CrmDocument>;

@Schema({ timestamps: true, collection: 'documents' })
export class CrmDocument {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  ownerId!: Types.ObjectId;

  @Prop({ required: true, trim: true, index: true })
  docCode!: string;

  @Prop({ required: true, trim: true })
  title!: string;

  @Prop({
    default: 'company_profile',
    enum: [
      'gst_certificate',
      'company_profile',
      'brochure',
      'contract',
      'customer_document',
    ],
    index: true,
  })
  category!: DocumentCategory;

  @Prop({ trim: true, default: '' })
  description!: string;

  @Prop({ trim: true, default: '' })
  documentNumber!: string;

  @Prop({ trim: true, default: '' })
  linkedCustomerName!: string;

  @Prop({ trim: true, default: '' })
  linkedContactId!: string;

  @Prop({ trim: true, default: '' })
  issueDate!: string;

  @Prop({ trim: true, default: '' })
  expiryDate!: string;

  @Prop({ type: [String], default: [] })
  tags!: string[];

  @Prop({ trim: true, default: '' })
  fileName!: string;

  @Prop({ trim: true, default: 'application/pdf' })
  mimeType!: string;

  @Prop({ type: Number, default: 0 })
  fileSizeBytes!: number;

  @Prop({ default: '' })
  fileDataUrl!: string;

  @Prop({ trim: true, default: '' })
  externalUrl!: string;

  @Prop({ trim: true, unique: true, sparse: true })
  shareToken?: string;

  @Prop({ type: Boolean, default: true })
  isVerified!: boolean;

  @Prop({ trim: true, default: '' })
  uploadedByName!: string;
}

export const CrmDocumentSchema = SchemaFactory.createForClass(CrmDocument);

export class CreateCrmDocumentDto {
  @ApiProperty({ example: 'GST Registration Certificate (Form GST REG-06)' })
  title!: string;

  @ApiProperty({
    enum: [
      'gst_certificate',
      'company_profile',
      'brochure',
      'contract',
      'customer_document',
    ],
    example: 'gst_certificate',
  })
  category!: DocumentCategory;

  @ApiPropertyOptional({
    example: 'Official UP State GST certificate for Noida Electronic City branch.',
  })
  description?: string;

  @ApiPropertyOptional({ example: '09AABCL2026F1Z9' })
  documentNumber?: string;

  @ApiPropertyOptional({ example: 'RS Electricals Pvt. Ltd.' })
  linkedCustomerName?: string;

  @ApiPropertyOptional({ example: '672e1a2b3c4d5e6f7a8b9c0d' })
  linkedContactId?: string;

  @ApiPropertyOptional({ example: '2026-04-01' })
  issueDate?: string;

  @ApiPropertyOptional({ example: '2027-03-31' })
  expiryDate?: string;

  @ApiPropertyOptional({ example: ['GSTIN', 'Compliance', 'Noida'] })
  tags?: string[];

  @ApiPropertyOptional({ example: 'leadsetu-gst-reg-06.pdf' })
  fileName?: string;

  @ApiPropertyOptional({ example: 'application/pdf' })
  mimeType?: string;

  @ApiPropertyOptional({ example: 245000 })
  fileSizeBytes?: number;

  @ApiPropertyOptional({
    description: 'Base64 Data URL of the uploaded file (up to 5 MB)',
  })
  fileDataUrl?: string;

  @ApiPropertyOptional({
    example: 'https://drive.google.com/file/d/example/view',
  })
  externalUrl?: string;

  @ApiPropertyOptional({ default: true })
  isVerified?: boolean;
}

export class UpdateCrmDocumentDto {
  @ApiPropertyOptional()
  title?: string;

  @ApiPropertyOptional({
    enum: [
      'gst_certificate',
      'company_profile',
      'brochure',
      'contract',
      'customer_document',
    ],
  })
  category?: DocumentCategory;

  @ApiPropertyOptional()
  description?: string;

  @ApiPropertyOptional()
  documentNumber?: string;

  @ApiPropertyOptional()
  linkedCustomerName?: string;

  @ApiPropertyOptional()
  linkedContactId?: string;

  @ApiPropertyOptional()
  issueDate?: string;

  @ApiPropertyOptional()
  expiryDate?: string;

  @ApiPropertyOptional()
  tags?: string[];

  @ApiPropertyOptional()
  externalUrl?: string;

  @ApiPropertyOptional()
  isVerified?: boolean;
}

function buildSampleCertificateHtmlDataUrl(params: {
  heading: string;
  subHeading: string;
  docNumber: string;
  bodyLines: string[];
}): string {
  const html = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>${params.heading}</title>
<style>
  body { font-family: Arial, sans-serif; margin: 36px; color: #0f172a; line-height: 1.6; }
  .box { border: 2px solid #1e3a8a; border-radius: 12px; padding: 28px; max-width: 720px; }
  .tag { color: #2563eb; font-weight: bold; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; }
  h1 { margin: 8px 0 4px; font-size: 22px; color: #0B192C; }
  .ref { font-family: monospace; background: #eff6ff; padding: 6px 10px; border-radius: 6px; display: inline-block; margin: 8px 0 18px; font-weight: bold; }
  li { margin-bottom: 6px; }
</style>
</head>
<body>
  <div class="box">
    <div class="tag">${params.subHeading}</div>
    <h1>${params.heading}</h1>
    <div class="ref">Ref / ID: ${params.docNumber}</div>
    <ul>${params.bodyLines.map((l) => `<li>${l}</li>`).join('')}</ul>
    <p style="margin-top:24px;font-size:12px;color:#64748b;">Verified in Leadsetu CRM Document Center · Noida Electronic City, Uttar Pradesh</p>
  </div>
</body>
</html>`;
  return `data:text/html;base64,${Buffer.from(html, 'utf8').toString('base64')}`;
}

@Injectable()
export class DocumentsService {
  constructor(
    @InjectModel(CrmDocument.name)
    private readonly documentModel: Model<CrmDocumentRecord>,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    @Optional() private readonly auditService?: AuditService,
    @Optional() private readonly superAdminService?: SuperAdminService,
  ) {}

  async verifyAuth(authHeader?: string) {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Authorization token is required.');
    }
    const token = authHeader.slice(7).trim();
    const secret =
      this.configService.get<string>('JWT_SECRET') ||
      'leadsetu_super_secret_access_key_2026_delhi_ncr';
    let payload: { sub: string; tenantId: string; email: string; name?: string };
    try {
      payload = await this.jwtService.verifyAsync<{
        sub: string;
        tenantId: string;
        email: string;
        name?: string;
      }>(token, { secret });
    } catch {
      throw new UnauthorizedException('Invalid or expired session.');
    }
    await this.superAdminService?.assertFeatureEnabled(
      payload.tenantId,
      'documentVault',
    );
    return {
      userId: payload.sub,
      tenantId: payload.tenantId,
      email: payload.email,
      name: payload.name || payload.email,
    };
  }

  private toDto(doc: CrmDocumentRecord, includeDataUrl = false) {
    const raw = doc.toObject() as unknown as Record<string, unknown> & {
      createdAt?: Date;
      updatedAt?: Date;
    };
    const fileDataUrl = String(doc.fileDataUrl || '');
    const externalUrl = String(doc.externalUrl || '');
    return {
      id: doc._id.toString(),
      tenantId: doc.tenantId.toString(),
      docCode: doc.docCode,
      title: doc.title,
      category: doc.category,
      description: doc.description || '',
      documentNumber: doc.documentNumber || '',
      linkedCustomerName: doc.linkedCustomerName || '',
      linkedContactId: doc.linkedContactId || '',
      issueDate: doc.issueDate || '',
      expiryDate: doc.expiryDate || '',
      tags: Array.isArray(doc.tags) ? doc.tags : [],
      fileName: doc.fileName || '',
      mimeType: doc.mimeType || 'application/pdf',
      fileSizeBytes: Number(doc.fileSizeBytes) || 0,
      hasFileData: Boolean(fileDataUrl),
      fileDataUrl: includeDataUrl ? fileDataUrl : undefined,
      externalUrl,
      shareToken: doc.shareToken || '',
      isVerified: doc.isVerified !== false,
      uploadedByName: doc.uploadedByName || '',
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
    query: { search?: string; category?: string; customer?: string },
  ) {
    const tenantObjectId = new Types.ObjectId(auth.tenantId);
    const filter: Record<string, unknown> = { tenantId: tenantObjectId };

    if (query.category && query.category !== 'all') {
      filter.category = query.category;
    }
    if (query.customer?.trim()) {
      filter.linkedCustomerName = new RegExp(query.customer.trim(), 'i');
    }
    if (query.search?.trim()) {
      const rx = new RegExp(query.search.trim(), 'i');
      filter.$or = [
        { title: rx },
        { docCode: rx },
        { documentNumber: rx },
        { linkedCustomerName: rx },
        { description: rx },
        { fileName: rx },
        { tags: rx },
      ];
    }

    const [docs, all] = await Promise.all([
      this.documentModel.find(filter).sort({ createdAt: -1 }).exec(),
      this.documentModel
        .find({ tenantId: tenantObjectId })
        .select('-fileDataUrl')
        .exec(),
    ]);

    const nowMs = Date.now();
    const soonMs = nowMs + 30 * 86400000;
    let expiringSoonCount = 0;
    for (const d of all) {
      if (d.expiryDate) {
        const expMs = new Date(d.expiryDate).getTime();
        if (Number.isFinite(expMs) && expMs >= nowMs - 7 * 86400000 && expMs <= soonMs) {
          expiringSoonCount += 1;
        }
      }
    }

    return {
      data: docs.map((d) => this.toDto(d, false)),
      stats: {
        totalCount: all.length,
        gstCount: all.filter((d) => d.category === 'gst_certificate').length,
        profileCount: all.filter((d) => d.category === 'company_profile').length,
        brochureCount: all.filter((d) => d.category === 'brochure').length,
        contractCount: all.filter((d) => d.category === 'contract').length,
        customerCount: all.filter((d) => d.category === 'customer_document').length,
        expiringSoonCount,
        totalStorageBytes: all.reduce(
          (sum, d) => sum + (Number(d.fileSizeBytes) || 0),
          0,
        ),
      },
    };
  }

  async findOne(auth: { userId: string; tenantId: string }, id: string) {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Document not found.');
    }
    const doc = await this.documentModel
      .findOne({
        _id: new Types.ObjectId(id),
        tenantId: new Types.ObjectId(auth.tenantId),
      })
      .exec();
    if (!doc) throw new NotFoundException('Document not found.');
    return this.toDto(doc, true);
  }

  async create(
    auth: { userId: string; tenantId: string; email: string; name?: string },
    dto: CreateCrmDocumentDto,
  ) {
    if (!dto.title?.trim()) {
      throw new BadRequestException('Document title is required.');
    }

    const validCategories: DocumentCategory[] = [
      'gst_certificate',
      'company_profile',
      'brochure',
      'contract',
      'customer_document',
    ];
    const category: DocumentCategory = validCategories.includes(dto.category)
      ? dto.category
      : 'customer_document';

    const fileDataUrl = String(dto.fileDataUrl || '').trim();
    const externalUrl = String(dto.externalUrl || '').trim();
    if (!fileDataUrl && !externalUrl) {
      throw new BadRequestException(
        'Please upload a file or provide an external document link.',
      );
    }

    if (fileDataUrl.length > 8 * 1024 * 1024) {
      throw new BadRequestException(
        'Uploaded file is too large. Please keep files under 5 MB.',
      );
    }

    const tenantObjectId = new Types.ObjectId(auth.tenantId);
    const count = await this.documentModel.countDocuments({
      tenantId: tenantObjectId,
    });
    const docCode = `DOC-2026-${String(1001 + count).padStart(4, '0')}`;

    const doc = await this.documentModel.create({
      tenantId: tenantObjectId,
      ownerId: new Types.ObjectId(auth.userId),
      docCode,
      title: dto.title.trim(),
      category,
      description: dto.description?.trim() || '',
      documentNumber: dto.documentNumber?.trim().toUpperCase() || '',
      linkedCustomerName: dto.linkedCustomerName?.trim() || '',
      linkedContactId: dto.linkedContactId?.trim() || '',
      issueDate: dto.issueDate?.trim() || new Date().toISOString().slice(0, 10),
      expiryDate: dto.expiryDate?.trim() || '',
      tags: Array.isArray(dto.tags)
        ? dto.tags.map((t) => String(t).trim()).filter(Boolean)
        : [],
      fileName:
        dto.fileName?.trim() ||
        `${docCode.toLowerCase()}.${category === 'brochure' ? 'pdf' : 'html'}`,
      mimeType: dto.mimeType?.trim() || 'application/pdf',
      fileSizeBytes: Math.max(0, Number(dto.fileSizeBytes) || fileDataUrl.length),
      fileDataUrl,
      externalUrl,
      shareToken: `lsd_${randomBytes(8).toString('hex')}`,
      isVerified: dto.isVerified !== false,
      uploadedByName: auth.name || auth.email || 'Workspace User',
    });

    await this.auditService?.record({
      tenantId: auth.tenantId,
      actorId: auth.userId,
      actorEmail: auth.email,
      action: 'document.uploaded',
      entityType: 'document',
      entityId: doc._id.toString(),
      entityLabel: `${doc.docCode} · ${doc.title}`,
      summary: `Uploaded ${doc.category} document "${doc.title}" (${doc.docCode})`,
    });

    return this.toDto(doc, false);
  }

  async update(
    auth: { userId: string; tenantId: string; email: string },
    id: string,
    dto: UpdateCrmDocumentDto,
  ) {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Document not found.');
    }
    const doc = await this.documentModel
      .findOne({
        _id: new Types.ObjectId(id),
        tenantId: new Types.ObjectId(auth.tenantId),
      })
      .exec();
    if (!doc) throw new NotFoundException('Document not found.');

    if (dto.title !== undefined) doc.title = dto.title.trim();
    if (dto.category !== undefined) doc.category = dto.category;
    if (dto.description !== undefined) doc.description = dto.description.trim();
    if (dto.documentNumber !== undefined)
      doc.documentNumber = dto.documentNumber.trim().toUpperCase();
    if (dto.linkedCustomerName !== undefined)
      doc.linkedCustomerName = dto.linkedCustomerName.trim();
    if (dto.linkedContactId !== undefined)
      doc.linkedContactId = dto.linkedContactId.trim();
    if (dto.issueDate !== undefined) doc.issueDate = dto.issueDate.trim();
    if (dto.expiryDate !== undefined) doc.expiryDate = dto.expiryDate.trim();
    if (dto.tags !== undefined)
      doc.tags = dto.tags.map((t) => String(t).trim()).filter(Boolean);
    if (dto.externalUrl !== undefined) doc.externalUrl = dto.externalUrl.trim();
    if (dto.isVerified !== undefined) doc.isVerified = dto.isVerified;

    await doc.save();

    await this.auditService?.record({
      tenantId: auth.tenantId,
      actorId: auth.userId,
      actorEmail: auth.email,
      action: 'document.updated',
      entityType: 'document',
      entityId: doc._id.toString(),
      entityLabel: `${doc.docCode} · ${doc.title}`,
      summary: `Updated metadata on document "${doc.title}"`,
    });

    return this.toDto(doc, false);
  }

  async remove(
    auth: { userId: string; tenantId: string; email: string },
    id: string,
  ) {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Document not found.');
    }
    const doc = await this.documentModel
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
        action: 'document.deleted',
        entityType: 'document',
        entityId: id,
        entityLabel: `${doc.docCode} · ${doc.title}`,
        summary: `Removed document "${doc.title}" (${doc.docCode})`,
      });
    }
    return { success: true, id };
  }

  async seedSamples(auth: {
    userId: string;
    tenantId: string;
    email: string;
    name?: string;
  }) {
    const samples: CreateCrmDocumentDto[] = [
      {
        title: 'GST Registration Certificate (Form GST REG-06)',
        category: 'gst_certificate',
        description:
          'Active Uttar Pradesh CGST/SGST registration certificate for Noida Electronic City HQ. Ready for vendor onboarding.',
        documentNumber: '09AABCL2026F1Z9',
        issueDate: '2024-04-01',
        tags: ['GSTIN', 'Vendor Onboarding', 'Tax Compliance'],
        fileName: 'Leadsetu-GST-REG06-Certificate.html',
        mimeType: 'text/html',
        fileSizeBytes: 24800,
        fileDataUrl: buildSampleCertificateHtmlDataUrl({
          heading: 'Form GST REG-06 — Certificate of Registration',
          subHeading: 'Government of India · Goods & Services Tax',
          docNumber: '09AABCL2026F1Z9',
          bodyLines: [
            'Legal Name: Leadsetu Technologies Pvt. Ltd.',
            'Principal Place of Business: Sector 62, Noida Electronic City, Gautam Buddha Nagar, UP – 201309',
            'Constitution of Business: Private Limited Company',
            'Date of Liability: 01/04/2024 · Status: ACTIVE',
          ],
        }),
        isVerified: true,
      },
      {
        title: 'Company Profile, Bank Mandate & Cancelled Cheque Pack',
        category: 'company_profile',
        description:
          'Corporate capability deck with HDFC Bank NEFT/RTGS mandate, PAN card details, and MSME Udyam number.',
        documentNumber: 'UDYAM-UP-28-0045120',
        issueDate: '2026-01-15',
        tags: ['Company Profile', 'NEFT Mandate', 'MSME'],
        fileName: 'Leadsetu-Corporate-Profile-2026.html',
        mimeType: 'text/html',
        fileSizeBytes: 38400,
        fileDataUrl: buildSampleCertificateHtmlDataUrl({
          heading: 'Leadsetu Corporate Profile & Vendor Onboarding Dossier',
          subHeading: 'Corporate Credentials & Bank Mandate',
          docNumber: 'UDYAM-UP-28-0045120',
          bodyLines: [
            'PAN: AABCL2026F · TAN: DELI04821E · MSME Udyam Registered',
            'Bank: HDFC Bank Ltd., Noida Electronic City Branch',
            'Account No: 50200088515208 · IFSC: HDFC0001245',
            'Core Offerings: B2B Industrial Automation, Servo Stabilizers & Annual AMC',
          ],
        }),
        isVerified: true,
      },
      {
        title: '2026 Industrial Servo Stabilizer & Switchgear Brochure',
        category: 'brochure',
        description:
          'Technical datasheet covering 50 KVA – 500 KVA Three-Phase Servo Stabilizers, LT Panels, HSN codes & warranty terms.',
        documentNumber: 'BRO-IND-2026-V4',
        issueDate: '2026-05-10',
        tags: ['Brochure', 'HSN 850440', 'Product Specs'],
        fileName: 'Industrial-Servo-Brochure-2026.html',
        mimeType: 'text/html',
        fileSizeBytes: 51200,
        fileDataUrl: buildSampleCertificateHtmlDataUrl({
          heading: 'Industrial Servo Voltage Stabilizer & LT Switchgear Brochure',
          subHeading: 'Product Technical Catalogue · 2026 Edition',
          docNumber: 'BRO-IND-2026-V4',
          bodyLines: [
            'Model Range: 50 KVA to 500 KVA Air / Oil Cooled (HSN 850440)',
            'Input Voltage Range: 300V – 480V AC · Output Accuracy: ±1%',
            'Efficiency: >98.5% with Automatic Bypass & Surge Protection',
            'Standard Warranty: 36 Months On-Site Service across Delhi-NCR & Pan-India',
          ],
        }),
        isVerified: true,
      },
      {
        title: 'Master Supply & Annual AMC Contract — Apex Auto Components',
        category: 'contract',
        description:
          'Signed 12-month preventive maintenance SLA and fixed-rate spare parts supply contract.',
        documentNumber: 'MSA-2026-APEX-09',
        linkedCustomerName: 'Apex Auto Components Ltd.',
        issueDate: '2026-11-01',
        expiryDate: new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10),
        tags: ['Contract', 'AMC', 'SLA Signed'],
        fileName: 'MSA-Contract-Apex-Auto.html',
        mimeType: 'text/html',
        fileSizeBytes: 42100,
        fileDataUrl: buildSampleCertificateHtmlDataUrl({
          heading: 'Master Supply & Preventive Maintenance Agreement (AMC)',
          subHeading: 'Executed B2B Commercial Contract',
          docNumber: 'MSA-2026-APEX-09',
          bodyLines: [
            'Client: Apex Auto Components Ltd. (Gurugram, Haryana)',
            'GSTIN: 06AABCA9012H1Z8 · Quarterly Preventive Visits Included',
            'SLA Response Time: 4 Hours Priority Dispatch in NCR',
            'Payment Terms: 30% Advance, 70% within 15 days of Invoice',
          ],
        }),
        isVerified: true,
      },
      {
        title: 'Buyer GSTIN, Signed NDA & PO #8841 — RS Electricals',
        category: 'customer_document',
        description:
          'Customer KYC packet containing signed NDA, verified Delhi GSTIN certificate, and Purchase Order copy.',
        documentNumber: 'PO-RS-2026-8841',
        linkedCustomerName: 'RS Electricals & Switchgear Pvt. Ltd.',
        issueDate: '2026-11-08',
        tags: ['Customer PO', 'NDA', 'Buyer KYC'],
        fileName: 'RS-Electricals-KYC-and-PO-8841.html',
        mimeType: 'text/html',
        fileSizeBytes: 31900,
        fileDataUrl: buildSampleCertificateHtmlDataUrl({
          heading: 'Customer Purchase Order & Verified Buyer KYC Packet',
          subHeading: 'Customer Document · RS Electricals & Switchgear Pvt. Ltd.',
          docNumber: 'PO-RS-2026-8841',
          bodyLines: [
            'Buyer Legal Name: RS Electricals & Switchgear Pvt. Ltd.',
            'Buyer GSTIN: 07AABCR1234F1Z5 (Karol Bagh, New Delhi)',
            'Contact Person: Rajesh Sharma (+91 98112 45678)',
            'Order Value: ₹4,50,000 + 18% IGST · Authorized Signatory Verified',
          ],
        }),
        isVerified: true,
      },
    ];

    const created = [];
    for (const item of samples) {
      created.push(await this.create(auth, item));
    }
    return { count: created.length, data: created };
  }
}

@ApiTags('14. Document Center & Compliance Vault')
@ApiBearerAuth('access-token')
@Controller('documents')
export class DocumentsController {
  constructor(private readonly documentsService: DocumentsService) {}

  @Get()
  @ApiOperation({
    summary:
      'List all stored documents (GST Certificates, Company Profiles, Brochures, Contracts, Customer Docs)',
  })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({
    name: 'category',
    required: false,
    enum: [
      'all',
      'gst_certificate',
      'company_profile',
      'brochure',
      'contract',
      'customer_document',
    ],
  })
  @ApiQuery({ name: 'customer', required: false })
  async findAll(
    @Headers('authorization') authorization: string | undefined,
    @Query() query: { search?: string; category?: string; customer?: string },
  ) {
    const auth = await this.documentsService.verifyAuth(authorization);
    return this.documentsService.findAll(auth, query);
  }

  @Post('seed')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Seed 5 sample B2B documents across GST Certificate, Company Profile, Brochure, Contract & Customer Docs',
  })
  async seed(@Headers('authorization') authorization: string | undefined) {
    const auth = await this.documentsService.verifyAuth(authorization);
    return this.documentsService.seedSamples(auth);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get full document including downloadable file content' })
  @ApiParam({ name: 'id' })
  async findOne(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
  ) {
    const auth = await this.documentsService.verifyAuth(authorization);
    return this.documentsService.findOne(auth, id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Upload or link a new document in the Document Center' })
  @ApiBody({ type: CreateCrmDocumentDto })
  async create(
    @Headers('authorization') authorization: string | undefined,
    @Body() dto: CreateCrmDocumentDto,
  ) {
    const auth = await this.documentsService.verifyAuth(authorization);
    return this.documentsService.create(auth, dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update document metadata, expiry, tags, or verification status' })
  @ApiBody({ type: UpdateCrmDocumentDto })
  async update(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
    @Body() dto: UpdateCrmDocumentDto,
  ) {
    const auth = await this.documentsService.verifyAuth(authorization);
    return this.documentsService.update(auth, id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a document from the Document Center' })
  async remove(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
  ) {
    const auth = await this.documentsService.verifyAuth(authorization);
    return this.documentsService.remove(auth, id);
  }
}

@Module({
  imports: [
    ConfigModule,
    MongooseModule.forFeature([
      { name: CrmDocument.name, schema: CrmDocumentSchema },
    ]),
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
  controllers: [DocumentsController],
  providers: [DocumentsService],
  exports: [DocumentsService],
})
export class DocumentsModule {}
