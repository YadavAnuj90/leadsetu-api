import {
  BadRequestException,
  Body,
  Controller,
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
import { maskPhoneNumber, resolveOwnerScopeFilter } from '../auth/identity.util';
import { SuperAdminService } from '../super-admin/super-admin.service';

export type ConversationDocument = HydratedDocument<ConversationThread>;

export interface ChatMessage {
  id: string;
  direction: 'inbound' | 'outbound';
  content: string;
  senderName: string;
  status: 'sent' | 'delivered' | 'read';
  isAiDrafted?: boolean;
  createdAt: string;
}

@Schema({ timestamps: true, collection: 'conversations' })
export class ConversationThread {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', index: true })
  ownerId?: Types.ObjectId;

  @Prop({ required: true, trim: true })
  contactName!: string;

  @Prop({ trim: true, default: '' })
  company!: string;

  @Prop({ trim: true, default: '' })
  phone!: string;

  @Prop({ trim: true, default: 'Delhi-NCR' })
  city!: string;

  @Prop({
    default: 'whatsapp',
    enum: ['whatsapp', 'indiamart', 'email'],
  })
  channel!: 'whatsapp' | 'indiamart' | 'email';

  @Prop({
    default: 'open',
    enum: ['open', 'resolved'],
    index: true,
  })
  status!: 'open' | 'resolved';

  @Prop({ type: Number, default: 85 })
  aiScore!: number;

  @Prop({ type: Number, default: 0 })
  estimatedValue!: number;

  @Prop({ default: '' })
  aiSummary!: string;

  @Prop({ default: '' })
  aiSuggestedReply!: string;

  @Prop({ type: Array, default: [] })
  messages!: ChatMessage[];
}

export const ConversationThreadSchema =
  SchemaFactory.createForClass(ConversationThread);

export class SendInboxMessageSwaggerDto {
  @ApiProperty({
    description: 'Outbound WhatsApp / IndiaMART message content (English or Hinglish)',
    example:
      'Namaste Rajesh ji! 500 units par 12% bulk discount approve ho gaya hai. Sharing GST proforma invoice right away.',
  })
  content!: string;

  @ApiPropertyOptional({
    description: 'Whether this message was drafted using SetuAI Smart Reply',
    example: true,
    default: false,
  })
  isAiDrafted?: boolean;
}

export class UpdateInboxStatusSwaggerDto {
  @ApiProperty({
    description: 'Conversation resolution state',
    enum: ['open', 'resolved'],
    example: 'resolved',
  })
  status!: 'open' | 'resolved';
}

@Injectable()
export class InboxService {
  constructor(
    @InjectModel(ConversationThread.name)
    private readonly convModel: Model<ConversationDocument>,
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
      'whatsappCloud',
    );
    return {
      userId: payload.sub,
      tenantId: payload.tenantId,
      email: payload.email,
    };
  }

  private toDto(doc: ConversationDocument, maskPhones = false) {
    const raw = doc.toObject() as unknown as Record<string, unknown> & {
      createdAt?: Date;
      updatedAt?: Date;
    };
    const messages = doc.messages || [];
    const lastMsg = messages[messages.length - 1];
    return {
      id: doc._id.toString(),
      tenantId: doc.tenantId.toString(),
      contactName: doc.contactName,
      company: doc.company || '',
      phone: maskPhones ? maskPhoneNumber(doc.phone) : doc.phone || '',
      city: doc.city || 'Delhi-NCR',
      channel: doc.channel || 'whatsapp',
      status: doc.status || 'open',
      aiScore: doc.aiScore || 85,
      estimatedValue: doc.estimatedValue || 0,
      aiSummary: doc.aiSummary || '',
      aiSuggestedReply: doc.aiSuggestedReply || '',
      lastMessage: lastMsg?.content || '',
      lastMessageAt:
        lastMsg?.createdAt ||
        (raw.updatedAt
          ? new Date(raw.updatedAt).toISOString()
          : new Date().toISOString()),
      messages,
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
    query: { status?: string; channel?: string; search?: string },
  ) {
    const tenantObjectId = new Types.ObjectId(auth.tenantId);
    const ownerScope = await resolveOwnerScopeFilter(this.convModel.db, auth);
    const filter: Record<string, unknown> = {
      tenantId: tenantObjectId,
      ...ownerScope,
    };

    if (query.status && query.status !== 'all') filter.status = query.status;
    if (query.channel && query.channel !== 'all') filter.channel = query.channel;
    if (query.search?.trim()) {
      const regex = new RegExp(query.search.trim(), 'i');
      filter.$or = [
        { contactName: regex },
        { company: regex },
        { phone: regex },
      ];
    }

    const [docs, maskPhones] = await Promise.all([
      this.convModel.find(filter).sort({ updatedAt: -1 }).exec(),
      this.auditService
        ? this.auditService.shouldMaskViewerPhones(auth.tenantId, auth.userId)
        : Promise.resolve(false),
    ]);
    return {
      data: docs.map((d) => this.toDto(d, maskPhones)),
    };
  }

  async sendMessage(
    auth: { userId: string; tenantId: string; email: string },
    id: string,
    body: { content: string; isAiDrafted?: boolean },
  ) {
    if (!Types.ObjectId.isValid(id))
      throw new NotFoundException('Conversation not found.');
    if (!body.content?.trim())
      throw new BadRequestException('Message cannot be empty.');

    const ownerScope = await resolveOwnerScopeFilter(this.convModel.db, auth);
    const doc = await this.convModel
      .findOne({
        _id: new Types.ObjectId(id),
        tenantId: new Types.ObjectId(auth.tenantId),
        ...ownerScope,
      })
      .exec();
    if (!doc) throw new NotFoundException('Conversation not found.');

    await this.superAdminService?.consumeTenantQuota(auth.tenantId, 'whatsapp', 1);
    if (body.isAiDrafted) {
      await this.superAdminService?.consumeTenantQuota(auth.tenantId, 'ai', 1);
    }

    const newMsg: ChatMessage = {
      id: randomBytes(6).toString('hex'),
      direction: 'outbound',
      content: body.content.trim(),
      senderName: auth.email.split('@')[0],
      status: 'delivered',
      isAiDrafted: body.isAiDrafted || false,
      createdAt: new Date().toISOString(),
    };

    doc.messages = [...(doc.messages || []), newMsg];
    await doc.save();
    const maskPhones = this.auditService
      ? await this.auditService.shouldMaskViewerPhones(auth.tenantId, auth.userId)
      : false;
    return this.toDto(doc, maskPhones);
  }

  async updateStatus(
    auth: { userId: string; tenantId: string },
    id: string,
    status: 'open' | 'resolved',
  ) {
    if (!Types.ObjectId.isValid(id))
      throw new NotFoundException('Conversation not found.');
    const ownerScope = await resolveOwnerScopeFilter(this.convModel.db, auth);
    const doc = await this.convModel
      .findOne({
        _id: new Types.ObjectId(id),
        tenantId: new Types.ObjectId(auth.tenantId),
        ...ownerScope,
      })
      .exec();
    if (!doc) throw new NotFoundException('Conversation not found.');
    doc.status = status;
    await doc.save();
    const maskPhones = this.auditService
      ? await this.auditService.shouldMaskViewerPhones(auth.tenantId, auth.userId)
      : false;
    return this.toDto(doc, maskPhones);
  }
}

@ApiTags('6. Unified WhatsApp & AI Inbox')
@ApiBearerAuth('access-token')
@Controller('inbox')
export class InboxController {
  constructor(private readonly inboxService: InboxService) {}

  @Get()
  @ApiOperation({
    summary:
      'List all WhatsApp & IndiaMART buyer conversations with SetuAI summaries',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['all', 'open', 'resolved'],
    description: 'Filter threads by resolution status',
  })
  @ApiQuery({
    name: 'channel',
    required: false,
    enum: ['all', 'whatsapp', 'indiamart', 'email'],
    description: 'Filter threads by channel',
  })
  @ApiQuery({
    name: 'search',
    required: false,
    description: 'Search by buyer name, company, or phone',
  })
  @ApiResponse({
    status: 200,
    description: 'Returns `{ data: Conversation[] }`.',
  })
  async findAll(
    @Headers('authorization') authorization: string | undefined,
    @Query() query: { status?: string; channel?: string; search?: string },
  ) {
    const auth = await this.inboxService.verifyAuth(authorization);
    return this.inboxService.findAll(auth, query);
  }

  @Post(':id/messages')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Send an outbound message (or SetuAI Smart Reply) in a conversation thread',
  })
  @ApiParam({
    name: 'id',
    description: 'Unique conversation thread ID',
    example: 'thr_01a2b3c4d5e6',
  })
  @ApiBody({ type: SendInboxMessageSwaggerDto })
  @ApiResponse({ status: 201, description: 'Message appended to conversation.' })
  async sendMessage(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
    @Body() body: SendInboxMessageSwaggerDto,
  ) {
    const auth = await this.inboxService.verifyAuth(authorization);
    return this.inboxService.sendMessage(auth, id, body);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Toggle conversation thread status (`open` or `resolved`)',
  })
  @ApiParam({
    name: 'id',
    description: 'Unique conversation thread ID',
    example: 'thr_01a2b3c4d5e6',
  })
  @ApiBody({ type: UpdateInboxStatusSwaggerDto })
  @ApiResponse({ status: 200, description: 'Conversation status updated.' })
  async updateStatus(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
    @Body() body: UpdateInboxStatusSwaggerDto,
  ) {
    const auth = await this.inboxService.verifyAuth(authorization);
    return this.inboxService.updateStatus(auth, id, body.status);
  }
}

@Module({
  imports: [
    ConfigModule,
    MongooseModule.forFeature([
      { name: ConversationThread.name, schema: ConversationThreadSchema },
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
  controllers: [InboxController],
  providers: [InboxService],
  exports: [InboxService],
})
export class InboxModule {}
