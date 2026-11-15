import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectModel, Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { HydratedDocument, Model, Types } from 'mongoose';
import { CreateTaskDto } from './dto/tasks.dto';

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
