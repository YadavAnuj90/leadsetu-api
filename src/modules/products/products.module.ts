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
import { resolveOwnerScopeFilter } from '../auth/identity.util';
import { AiBridgeService } from '../ai-bridge/ai-bridge.service';

export type ProductUnit = 'pcs' | 'box' | 'set' | 'kg' | 'mtr' | 'service' | 'license';
export type ProductDocument = HydratedDocument<ProductItem>;

@Schema({ timestamps: true, collection: 'products' })
export class ProductItem {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  ownerId!: Types.ObjectId;

  @Prop({ required: true, trim: true, uppercase: true, index: true })
  sku!: string;

  @Prop({ required: true, trim: true })
  name!: string;

  @Prop({ trim: true, default: 'Industrial Goods' })
  category!: string;

  @Prop({ trim: true, default: '850440' })
  hsnSac!: string;

  @Prop({
    default: 'pcs',
    enum: ['pcs', 'box', 'set', 'kg', 'mtr', 'service', 'license'],
  })
  unit!: ProductUnit;

  @Prop({ type: Number, required: true, default: 0 })
  unitPrice!: number;

  @Prop({ type: Number, default: 18 })
  gstRate!: number;

  @Prop({ type: Number, default: 1 })
  moq!: number;

  @Prop({ trim: true, default: '' })
  description!: string;

  @Prop({ trim: true, default: '' })
  brochureUrl!: string;

  @Prop({ type: Boolean, default: true })
  inStock!: boolean;
}

export const ProductSchema = SchemaFactory.createForClass(ProductItem);

export class CreateProductDto {
  @ApiPropertyOptional({ example: 'IND-STAB-150' })
  sku?: string;

  @ApiProperty({ example: 'Three-Phase Industrial Servo Voltage Stabilizer 150 KVA' })
  name!: string;

  @ApiPropertyOptional({ example: 'Power & Electrical' })
  category?: string;

  @ApiPropertyOptional({ example: '850440', default: '850440' })
  hsnSac?: string;

  @ApiPropertyOptional({
    enum: ['pcs', 'box', 'set', 'kg', 'mtr', 'service', 'license'],
    default: 'pcs',
  })
  unit?: ProductUnit;

  @ApiProperty({ example: 225000 })
  unitPrice!: number;

  @ApiPropertyOptional({ example: 18, enum: [0, 5, 12, 18, 28] })
  gstRate?: number;

  @ApiPropertyOptional({ example: 2, default: 1 })
  moq?: number;

  @ApiPropertyOptional({ example: 'Heavy-duty oil-cooled copper wound servo stabilizer with 2-year warranty.' })
  description?: string;

  @ApiPropertyOptional({ example: 'https://leadsetu.in/brochures/servo-150kva.pdf' })
  brochureUrl?: string;

  @ApiPropertyOptional({ default: true })
  inStock?: boolean;
}

export type UpdateProductDto = Partial<CreateProductDto>;

interface AuthContext {
  userId: string;
  tenantId: string;
  email: string;
}

@Injectable()
export class ProductsService {
  constructor(
    @InjectModel(ProductItem.name)
    private readonly productModel: Model<ProductDocument>,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    @Optional() private readonly auditService?: AuditService,
    @Optional() private readonly aiBridge?: AiBridgeService,
  ) {}

  async verifyAuth(authHeader?: string): Promise<AuthContext> {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Authorization token is required.');
    }
    const token = authHeader.slice(7).trim();
    const secret =
      this.configService.get<string>('JWT_SECRET') ||
      'leadsetu_super_secret_access_key_2026';
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

  private toDto(doc: ProductDocument) {
    const raw = doc.toObject() as unknown as {
      createdAt?: Date;
      updatedAt?: Date;
    };
    const unitPrice = Number(doc.unitPrice) || 0;
    const gstRate = Number(doc.gstRate) || 0;
    const priceWithGst = Math.round(unitPrice * (1 + gstRate / 100));

    return {
      id: doc._id.toString(),
      tenantId: doc.tenantId.toString(),
      sku: doc.sku,
      name: doc.name,
      category: doc.category || 'Industrial Goods',
      hsnSac: doc.hsnSac || '998314',
      unit: doc.unit || 'pcs',
      unitPrice,
      gstRate,
      priceWithGst,
      moq: doc.moq || 1,
      description: doc.description || '',
      brochureUrl: doc.brochureUrl || '',
      inStock: doc.inStock ?? true,
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
    query: { search?: string; category?: string; gstRate?: string },
  ) {
    const tenantObjectId = new Types.ObjectId(auth.tenantId);
    const ownerScope = await resolveOwnerScopeFilter(this.productModel.db, auth);
    const baseScope: Record<string, unknown> = {
      tenantId: tenantObjectId,
      ...ownerScope,
    };
    const filter: Record<string, unknown> = { ...baseScope };

    if (query.category && query.category !== 'all') {
      filter.category = query.category;
    }
    if (query.gstRate && query.gstRate !== 'all') {
      filter.gstRate = Number(query.gstRate);
    }
    if (query.search?.trim()) {
      const rx = new RegExp(query.search.trim(), 'i');
      filter.$or = [
        { name: rx },
        { sku: rx },
        { hsnSac: rx },
        { category: rx },
        { description: rx },
      ];
    }

    const [docs, all] = await Promise.all([
      this.productModel.find(filter).sort({ createdAt: -1 }).exec(),
      this.productModel.find(baseScope).exec(),
    ]);

    const categories = Array.from(
      new Set(all.map((p) => p.category || 'Industrial Goods')),
    );

    return {
      data: docs.map((d) => this.toDto(d)),
      categories,
      stats: {
        totalSkus: all.length,
        inStockCount: all.filter((p) => p.inStock !== false).length,
        categoriesCount: categories.length,
        avgUnitValue:
          all.length > 0
            ? Math.round(
                all.reduce((s, p) => s + (Number(p.unitPrice) || 0), 0) /
                  all.length,
              )
            : 0,
      },
    };
  }

  async create(auth: AuthContext, dto: CreateProductDto) {
    if (!dto.name?.trim()) {
      throw new BadRequestException('Product / service name is required.');
    }
    const existingCount = await this.productModel
      .countDocuments({ tenantId: new Types.ObjectId(auth.tenantId) })
      .exec();
    const sku =
      dto.sku?.trim().toUpperCase() ||
      `LS-SKU-${String(existingCount + 101)}`;
    const rate = [0, 5, 12, 18, 28].includes(Number(dto.gstRate))
      ? Number(dto.gstRate)
      : 18;

    const doc = await this.productModel.create({
      tenantId: new Types.ObjectId(auth.tenantId),
      ownerId: new Types.ObjectId(auth.userId),
      sku,
      name: dto.name.trim(),
      category: dto.category?.trim() || 'Industrial Goods',
      hsnSac: dto.hsnSac?.trim() || '998314',
      unit: dto.unit || 'pcs',
      unitPrice: Math.max(0, Number(dto.unitPrice) || 0),
      gstRate: rate,
      moq: Math.max(1, Number(dto.moq) || 1),
      description: dto.description?.trim() || '',
      brochureUrl: dto.brochureUrl?.trim() || '',
      inStock: dto.inStock ?? true,
    });

    await this.auditService?.record({
      tenantId: auth.tenantId,
      actorId: auth.userId,
      actorEmail: auth.email,
      action: 'product.created',
      entityType: 'invoice',
      entityId: doc._id.toString(),
      entityLabel: `${doc.sku} · ${doc.name}`,
      summary: `Added catalog SKU ${doc.sku} (${doc.name}) at ₹${doc.unitPrice.toLocaleString('en-IN')} (${doc.gstRate}% GST)`,
    });

    this.aiBridge
      ?.syncTenantKnowledgeIndex(auth.tenantId, auth.userId)
      .catch(() => {});

    return this.toDto(doc);
  }

  async update(auth: AuthContext, id: string, dto: UpdateProductDto) {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Product not found.');
    }
    const ownerScope = await resolveOwnerScopeFilter(this.productModel.db, auth);
    const doc = await this.productModel
      .findOne({
        _id: new Types.ObjectId(id),
        tenantId: new Types.ObjectId(auth.tenantId),
        ...ownerScope,
      })
      .exec();
    if (!doc) throw new NotFoundException('Product not found.');

    if (dto.sku !== undefined) doc.sku = dto.sku.trim().toUpperCase();
    if (dto.name !== undefined) doc.name = dto.name.trim();
    if (dto.category !== undefined) doc.category = dto.category.trim();
    if (dto.hsnSac !== undefined) doc.hsnSac = dto.hsnSac.trim();
    if (dto.unit !== undefined) doc.unit = dto.unit;
    if (dto.unitPrice !== undefined)
      doc.unitPrice = Math.max(0, Number(dto.unitPrice) || 0);
    if (
      dto.gstRate !== undefined &&
      [0, 5, 12, 18, 28].includes(Number(dto.gstRate))
    ) {
      doc.gstRate = Number(dto.gstRate);
    }
    if (dto.moq !== undefined) doc.moq = Math.max(1, Number(dto.moq) || 1);
    if (dto.description !== undefined) doc.description = dto.description.trim();
    if (dto.brochureUrl !== undefined) doc.brochureUrl = dto.brochureUrl.trim();
    if (dto.inStock !== undefined) doc.inStock = Boolean(dto.inStock);

    await doc.save();
    this.aiBridge
      ?.syncTenantKnowledgeIndex(auth.tenantId, auth.userId)
      .catch(() => {});
    return this.toDto(doc);
  }

  async remove(auth: AuthContext, id: string) {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Product not found.');
    }
    const ownerScope = await resolveOwnerScopeFilter(this.productModel.db, auth);
    await this.productModel
      .deleteOne({
        _id: new Types.ObjectId(id),
        tenantId: new Types.ObjectId(auth.tenantId),
        ...ownerScope,
      })
      .exec();
    return { success: true, id };
  }
}

@ApiTags('14. Product & HSN Catalog')
@ApiBearerAuth('access-token')
@Controller('products')
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Get()
  @ApiOperation({ summary: 'List workspace Product & HSN/SAC Price Catalog' })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'category', required: false })
  @ApiQuery({ name: 'gstRate', required: false })
  async list(
    @Headers('authorization') authorization: string | undefined,
    @Query() query: { search?: string; category?: string; gstRate?: string },
  ) {
    const auth = await this.productsService.verifyAuth(authorization);
    return this.productsService.findAll(auth, query);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Add a Product / Service SKU with HSN/SAC & GST slab' })
  @ApiBody({ type: CreateProductDto })
  async create(
    @Headers('authorization') authorization: string | undefined,
    @Body() dto: CreateProductDto,
  ) {
    const auth = await this.productsService.verifyAuth(authorization);
    return this.productsService.create(auth, dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a catalog SKU, price, or stock flag' })
  @ApiParam({ name: 'id', description: 'Unique product SKU record ID' })
  async update(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
    @Body() dto: UpdateProductDto,
  ) {
    const auth = await this.productsService.verifyAuth(authorization);
    return this.productsService.update(auth, id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a catalog SKU' })
  @ApiParam({ name: 'id', description: 'Unique product SKU record ID' })
  async remove(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
  ) {
    const auth = await this.productsService.verifyAuth(authorization);
    return this.productsService.remove(auth, id);
  }
}

@Module({
  imports: [
    ConfigModule,
    MongooseModule.forFeature([{ name: ProductItem.name, schema: ProductSchema }]),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret:
          config.get<string>('JWT_SECRET') ||
          'leadsetu_super_secret_access_key_2026',
      }),
    }),
  ],
  controllers: [ProductsController],
  providers: [ProductsService],
  exports: [ProductsService],
})
export class ProductsModule {}
