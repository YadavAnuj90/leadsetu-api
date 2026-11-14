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

export type TaskDocument = HydratedDocument<TaskItem>;

@Schema({ timestamps: true, collection: 'tasks' })
export class TaskItem {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  ownerId!: Types.ObjectId;

  @Prop({ required: true, trim: true })
  title!: string;

  @Prop({ trim: true, default: '' })
  description!: string;

  @Prop({
    default: 'high',
    enum: ['high', 'medium', 'low'],
  })
  priority!: 'high' | 'medium' | 'low';

  @Prop({
    default: 'pending',
    enum: ['pending', 'in_progress', 'done'],
    index: true,
  })
  status!: 'pending' | 'in_progress' | 'done';

  @Prop({
    default: 'whatsapp',
    enum: ['call', 'whatsapp', 'meeting', 'quote', 'followup'],
  })
  category!: 'call' | 'whatsapp' | 'meeting' | 'quote' | 'followup';

  @Prop({ default: '' })
  dueDate!: string;

  @Prop({ default: '' })
  relatedName!: string;

  @Prop({ default: '' })
  relatedCompany!: string;

  @Prop({ default: '' })
  relatedPhone!: string;
}

export const TaskItemSchema = SchemaFactory.createForClass(TaskItem);

export class CreateTaskDto {
  @ApiProperty({
    description: 'Actionable title of the follow-up task',
    example: 'Share revised 18% GST proforma quote for 500 units',
  })
  title!: string;

  @ApiPropertyOptional({
    description: 'Context or agenda for the follow-up',
    example: 'Include 12% bulk discount + Razorpay advance payment link on WhatsApp.',
  })
  description?: string;

  @ApiPropertyOptional({
    description: 'Urgency priority level',
    enum: ['high', 'medium', 'low'],
    default: 'high',
    example: 'high',
  })
  priority?: 'high' | 'medium' | 'low';

  @ApiPropertyOptional({
    description: 'Task completion status',
    enum: ['pending', 'in_progress', 'done'],
    default: 'pending',
    example: 'pending',
  })
  status?: 'pending' | 'in_progress' | 'done';

  @ApiPropertyOptional({
    description: 'Sales activity category',
    enum: ['call', 'whatsapp', 'meeting', 'quote', 'followup'],
    default: 'whatsapp',
    example: 'quote',
  })
  category?: 'call' | 'whatsapp' | 'meeting' | 'quote' | 'followup';

  @ApiPropertyOptional({
    description: 'Due date (YYYY-MM-DD)',
    example: '2026-11-10',
  })
  dueDate?: string;

  @ApiPropertyOptional({
    description: 'Related buyer / lead name',
    example: 'Rajesh Sharma',
  })
  relatedName?: string;

  @ApiPropertyOptional({
    description: 'Related buyer company name',
    example: 'RS Electricals Pvt. Ltd.',
  })
  relatedCompany?: string;

  @ApiPropertyOptional({
    description: 'Related buyer WhatsApp / mobile phone (+91)',
    example: '+91 98112 45678',
  })
  relatedPhone?: string;
}

export class UpdateTaskDto extends CreateTaskDto {}

@Injectable()
export class TasksService {
  constructor(
    @InjectModel(TaskItem.name) private readonly taskModel: Model<TaskDocument>,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
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

  private toDto(doc: TaskDocument) {
    const raw = doc.toObject() as unknown as Record<string, unknown> & {
      createdAt?: Date;
      updatedAt?: Date;
    };
    return {
      id: doc._id.toString(),
      tenantId: doc.tenantId.toString(),
      title: doc.title,
      description: doc.description || '',
      priority: doc.priority || 'high',
      status: doc.status || 'pending',
      category: doc.category || 'whatsapp',
      dueDate: doc.dueDate || '',
      relatedName: doc.relatedName || '',
      relatedCompany: doc.relatedCompany || '',
      relatedPhone: doc.relatedPhone || '',
      createdAt: raw.createdAt
        ? new Date(raw.createdAt).toISOString()
        : new Date().toISOString(),
      updatedAt: raw.updatedAt
        ? new Date(raw.updatedAt).toISOString()
        : new Date().toISOString(),
    };
  }

  async findAll(
    auth: { tenantId: string },
    query: { status?: string; priority?: string; search?: string },
  ) {
    const tenantObjectId = new Types.ObjectId(auth.tenantId);
    const filter: Record<string, unknown> = { tenantId: tenantObjectId };

    if (query.status && query.status !== 'all') filter.status = query.status;
    if (query.priority && query.priority !== 'all')
      filter.priority = query.priority;
    if (query.search?.trim()) {
      const regex = new RegExp(query.search.trim(), 'i');
      filter.$or = [
        { title: regex },
        { relatedName: regex },
        { relatedCompany: regex },
      ];
    }

    const [docs, all] = await Promise.all([
      this.taskModel.find(filter).sort({ status: -1, createdAt: -1 }).exec(),
      this.taskModel.find({ tenantId: tenantObjectId }).exec(),
    ]);

    return {
      data: docs.map((d) => this.toDto(d)),
      stats: {
        total: all.length,
        pending: all.filter((t) => t.status !== 'done').length,
        highPriority: all.filter(
          (t) => t.priority === 'high' && t.status !== 'done',
        ).length,
        completed: all.filter((t) => t.status === 'done').length,
      },
    };
  }

  async create(auth: { userId: string; tenantId: string }, dto: CreateTaskDto) {
    if (!dto.title?.trim())
      throw new BadRequestException('Task title is required.');
    const doc = await this.taskModel.create({
      tenantId: new Types.ObjectId(auth.tenantId),
      ownerId: new Types.ObjectId(auth.userId),
      title: dto.title.trim(),
      description: dto.description?.trim() || '',
      priority: dto.priority || 'high',
      status: dto.status || 'pending',
      category: dto.category || 'whatsapp',
      dueDate:
        dto.dueDate ||
        new Date(Date.now() + 86400000).toISOString().slice(0, 10),
      relatedName: dto.relatedName?.trim() || '',
      relatedCompany: dto.relatedCompany?.trim() || '',
      relatedPhone: dto.relatedPhone?.trim() || '',
    });
    return this.toDto(doc);
  }

  async update(
    auth: { tenantId: string },
    id: string,
    dto: Partial<CreateTaskDto>,
  ) {
    if (!Types.ObjectId.isValid(id))
      throw new NotFoundException('Task not found.');
    const doc = await this.taskModel
      .findOne({
        _id: new Types.ObjectId(id),
        tenantId: new Types.ObjectId(auth.tenantId),
      })
      .exec();
    if (!doc) throw new NotFoundException('Task not found.');

    if (dto.title !== undefined) doc.title = dto.title.trim();
    if (dto.description !== undefined) doc.description = dto.description.trim();
    if (dto.priority !== undefined) doc.priority = dto.priority;
    if (dto.status !== undefined) doc.status = dto.status;
    if (dto.category !== undefined) doc.category = dto.category;
    if (dto.dueDate !== undefined) doc.dueDate = dto.dueDate;
    if (dto.relatedName !== undefined) doc.relatedName = dto.relatedName.trim();
    if (dto.relatedCompany !== undefined)
      doc.relatedCompany = dto.relatedCompany.trim();
    if (dto.relatedPhone !== undefined)
      doc.relatedPhone = dto.relatedPhone.trim();

    await doc.save();
    return this.toDto(doc);
  }

  async remove(auth: { tenantId: string }, id: string) {
    if (!Types.ObjectId.isValid(id))
      throw new NotFoundException('Task not found.');
    await this.taskModel
      .deleteOne({
        _id: new Types.ObjectId(id),
        tenantId: new Types.ObjectId(auth.tenantId),
      })
      .exec();
    return { success: true, id };
  }

  async seedSamples(auth: { userId: string; tenantId: string }) {
    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const samples: CreateTaskDto[] = [
      {
        title: 'Share revised 18% GST proforma quote for 500 units',
        description:
          'Include 12% bulk discount + Razorpay advance payment link on WhatsApp.',
        priority: 'high',
        status: 'pending',
        category: 'quote',
        dueDate: today,
        relatedName: 'Rajesh Sharma',
        relatedCompany: 'RS Electricals Pvt. Ltd.',
        relatedPhone: '+91 98112 45678',
      },
      {
        title: 'Confirm Thursday 11 AM site visit at Sector 62 Noida',
        description: 'Send Google Maps pin and 3D layout PDF via WhatsApp.',
        priority: 'high',
        status: 'in_progress',
        category: 'meeting',
        dueDate: today,
        relatedName: 'Priya Malhotra',
        relatedCompany: 'Malhotra Luxury Interiors',
        relatedPhone: '+91 98180 23451',
      },
      {
        title: 'Follow-up call on CNC sample testing feedback',
        description: 'Discuss annual rate contract and MOQ schedule.',
        priority: 'medium',
        status: 'pending',
        category: 'call',
        dueDate: tomorrow,
        relatedName: 'Vikramjit Singh',
        relatedCompany: 'Apex Auto Components',
        relatedPhone: '+91 99104 88712',
      },
      {
        title: 'Send dispatch tracking ID for Okhla warehouse order',
        description: '50% advance already received via Razorpay.',
        priority: 'low',
        status: 'done',
        category: 'whatsapp',
        dueDate: today,
        relatedName: 'Sandeep Bansal',
        relatedCompany: 'Bansal Steel & Infra',
        relatedPhone: '+91 98711 65090',
      },
    ];
    const created = [];
    for (const s of samples) {
      created.push(await this.create(auth, s));
    }
    return { count: created.length, data: created };
  }
}

@ApiTags('5. Tasks & Call Reminders')
@ApiBearerAuth('access-token')
@Controller('tasks')
export class TasksController {
  constructor(private readonly tasksService: TasksService) {}

  @Get()
  @ApiOperation({
    summary: 'List all follow-up tasks & call reminders with completion KPIs',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['all', 'pending', 'in_progress', 'done'],
    description: 'Filter tasks by completion status',
  })
  @ApiQuery({
    name: 'priority',
    required: false,
    enum: ['all', 'high', 'medium', 'low'],
    description: 'Filter tasks by priority',
  })
  @ApiQuery({
    name: 'search',
    required: false,
    description: 'Search by task title, buyer name, or company',
  })
  @ApiResponse({
    status: 200,
    description: 'Returns `{ data: Task[], stats: TasksStats }`.',
  })
  async findAll(
    @Headers('authorization') authorization: string | undefined,
    @Query() query: { status?: string; priority?: string; search?: string },
  ) {
    const auth = await this.tasksService.verifyAuth(authorization);
    return this.tasksService.findAll(auth, query);
  }

  @Post('seed')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Seed 4 sample sales follow-up & site visit tasks',
  })
  @ApiResponse({ status: 201, description: '4 sample tasks created.' })
  async seed(@Headers('authorization') authorization: string | undefined) {
    const auth = await this.tasksService.verifyAuth(authorization);
    return this.tasksService.seedSamples(auth);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a new sales follow-up or call reminder task',
  })
  @ApiBody({ type: CreateTaskDto })
  @ApiResponse({ status: 201, description: 'Task created.' })
  async create(
    @Headers('authorization') authorization: string | undefined,
    @Body() dto: CreateTaskDto,
  ) {
    const auth = await this.tasksService.verifyAuth(authorization);
    return this.tasksService.create(auth, dto);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update task details or toggle completion status (`pending` / `done`)',
  })
  @ApiParam({
    name: 'id',
    description: 'MongoDB ObjectId of the task',
    example: '672e1a2b3c4d5e6f7a8b9c0d',
  })
  @ApiBody({ type: UpdateTaskDto })
  @ApiResponse({ status: 200, description: 'Task updated.' })
  async update(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
    @Body() dto: UpdateTaskDto,
  ) {
    const auth = await this.tasksService.verifyAuth(authorization);
    return this.tasksService.update(auth, id, dto);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Delete a follow-up task by ID',
  })
  @ApiParam({
    name: 'id',
    description: 'MongoDB ObjectId of the task',
    example: '672e1a2b3c4d5e6f7a8b9c0d',
  })
  @ApiResponse({ status: 200, description: 'Task deleted.' })
  async remove(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
  ) {
    const auth = await this.tasksService.verifyAuth(authorization);
    return this.tasksService.remove(auth, id);
  }
}

@Module({
  imports: [
    ConfigModule,
    MongooseModule.forFeature([
      { name: TaskItem.name, schema: TaskItemSchema },
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
  controllers: [TasksController],
  providers: [TasksService],
  exports: [TasksService],
})
export class TasksModule {}
