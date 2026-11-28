import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Model, Types } from 'mongoose';
import {
  CustomField,
  CustomFieldDocument,
  CustomFieldEntity,
  CustomFieldType,
} from './schemas/custom-field.schema';
import {
  ApplyCustomFieldPresetDto,
  CreateCustomFieldDto,
  ReorderCustomFieldsDto,
  UpdateCustomFieldDto,
} from './dto/custom-field.dto';

export interface CustomFieldAuthContext {
  userId: string;
  tenantId: string;
  email: string;
  role: string;
}

const VALID_ENTITIES: CustomFieldEntity[] = ['lead', 'contact', 'deal'];
const VALID_TYPES: CustomFieldType[] = [
  'text',
  'number',
  'dropdown',
  'date',
  'checkbox',
];

const INDUSTRY_PRESETS: Record<
  ApplyCustomFieldPresetDto['preset'],
  Array<Omit<CreateCustomFieldDto, 'key'> & { key: string }>
> = {
  manufacturing_b2b: [
    {
      entity: 'lead',
      key: 'moq',
      label: 'MOQ (Min Order Qty)',
      type: 'number',
      placeholder: 'e.g. 500',
      showInCard: true,
    },
    {
      entity: 'lead',
      key: 'plant_location',
      label: 'Plant / Factory Location',
      type: 'text',
      placeholder: 'e.g. Bhiwadi / Noida Phase-II',
      showInCard: true,
    },
    {
      entity: 'contact',
      key: 'credit_days',
      label: 'Approved Credit Days',
      type: 'dropdown',
      options: ['Advance', 'Net 15 Days', 'Net 30 Days', 'Net 45 Days', 'Net 60 Days'],
      showInCard: true,
    },
    {
      entity: 'deal',
      key: 'dispatch_mode',
      label: 'Dispatch Mode',
      type: 'dropdown',
      options: ['Ex-Works', 'FOR Destination', 'Part-Load Transport', 'Courier'],
      showInCard: true,
    },
  ],
  pharma_medical: [
    {
      entity: 'contact',
      key: 'drug_license_no',
      label: 'Drug License No.',
      type: 'text',
      placeholder: 'e.g. DL-20B-112940',
      required: true,
      showInCard: true,
    },
    {
      entity: 'lead',
      key: 'cold_chain_required',
      label: 'Cold Chain Required',
      type: 'checkbox',
      showInCard: true,
    },
    {
      entity: 'deal',
      key: 'required_delivery_date',
      label: 'Required Delivery Date',
      type: 'date',
      showInCard: true,
    },
  ],
  wholesale_distribution: [
    {
      entity: 'contact',
      key: 'beat_day',
      label: 'Sales Beat Day',
      type: 'dropdown',
      options: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
      showInCard: true,
    },
    {
      entity: 'lead',
      key: 'monthly_offtake_inr',
      label: 'Monthly Offtake Potential (INR)',
      type: 'number',
      placeholder: 'e.g. 150000',
      showInCard: true,
    },
    {
      entity: 'deal',
      key: 'scheme_applied',
      label: 'Trade Scheme Applied',
      type: 'checkbox',
      showInCard: true,
    },
  ],
  real_estate: [
    {
      entity: 'lead',
      key: 'budget_bracket',
      label: 'Budget Bracket',
      type: 'dropdown',
      options: ['Under ₹50L', '₹50L – ₹1Cr', '₹1Cr – ₹3Cr', '₹3Cr+'],
      showInCard: true,
    },
    {
      entity: 'lead',
      key: 'preferred_visit_date',
      label: 'Site Visit Date',
      type: 'date',
      showInCard: true,
    },
    {
      entity: 'deal',
      key: 'loan_preapproved',
      label: 'Home/Commercial Loan Pre-Approved',
      type: 'checkbox',
      showInCard: true,
    },
  ],
};

function slugifyFieldKey(raw: string): string {
  const slug = raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  return slug || `field_${Date.now().toString(36)}`;
}

@Injectable()
export class CustomFieldsService {
  constructor(
    @InjectModel(CustomField.name)
    private readonly customFieldModel: Model<CustomFieldDocument>,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  async verifyAuth(authHeader?: string): Promise<CustomFieldAuthContext> {
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
        role?: string;
      }>(token, { secret });
      return {
        userId: payload.sub,
        tenantId: payload.tenantId,
        email: payload.email,
        role: payload.role || 'owner',
      };
    } catch {
      throw new UnauthorizedException('Invalid or expired session.');
    }
  }

  private assertCanConfigure(auth: CustomFieldAuthContext) {
    if (auth.role !== 'owner' && auth.role !== 'admin') {
      throw new ForbiddenException(
        'Only Workspace Owners or Admins can create, edit, or delete custom fields.',
      );
    }
  }

  private toDto(doc: CustomFieldDocument) {
    const raw = doc.toObject() as unknown as Record<string, unknown> & {
      createdAt?: Date;
      updatedAt?: Date;
    };
    return {
      id: doc._id.toString(),
      tenantId: doc.tenantId.toString(),
      entity: doc.entity,
      key: doc.key,
      label: doc.label,
      type: doc.type,
      options: Array.isArray(doc.options) ? doc.options : [],
      required: Boolean(doc.required),
      placeholder: doc.placeholder || '',
      defaultValue: doc.defaultValue ?? null,
      showInCard: doc.showInCard ?? true,
      order: Number(doc.order || 0),
      isActive: doc.isActive ?? true,
      createdAt: raw.createdAt
        ? new Date(raw.createdAt).toISOString()
        : new Date().toISOString(),
      updatedAt: raw.updatedAt
        ? new Date(raw.updatedAt).toISOString()
        : new Date().toISOString(),
    };
  }

  async listFields(
    auth: CustomFieldAuthContext,
    entity?: string,
    includeInactive = false,
  ) {
    const filter: Record<string, unknown> = {
      tenantId: new Types.ObjectId(auth.tenantId),
    };
    if (entity && VALID_ENTITIES.includes(entity as CustomFieldEntity)) {
      filter.entity = entity;
    }
    if (!includeInactive) {
      filter.isActive = true;
    }

    const docs = await this.customFieldModel
      .find(filter)
      .sort({ entity: 1, order: 1, createdAt: 1 })
      .exec();

    return {
      data: docs.map((d) => this.toDto(d)),
    };
  }

  async createField(auth: CustomFieldAuthContext, dto: CreateCustomFieldDto) {
    this.assertCanConfigure(auth);

    if (!VALID_ENTITIES.includes(dto.entity)) {
      throw new BadRequestException('Entity must be one of lead, contact, or deal.');
    }
    const label = dto.label?.trim();
    if (!label) {
      throw new BadRequestException('Custom field label is required.');
    }
    const type: CustomFieldType = VALID_TYPES.includes(dto.type) ? dto.type : 'text';

    const options =
      type === 'dropdown'
        ? (Array.isArray(dto.options) ? dto.options : [])
            .map((o) => String(o).trim())
            .filter(Boolean)
        : [];
    if (type === 'dropdown' && options.length === 0) {
      throw new BadRequestException(
        'Dropdown custom fields require at least one choice option.',
      );
    }

    const tenantObjectId = new Types.ObjectId(auth.tenantId);
    const existingForEntity = await this.customFieldModel
      .find({ tenantId: tenantObjectId, entity: dto.entity })
      .select({ key: 1, order: 1 })
      .exec();

    const usedKeys = new Set(existingForEntity.map((f) => f.key));
    const baseKey = slugifyFieldKey(dto.key || label);
    let key = baseKey;
    let suffix = 2;
    while (usedKeys.has(key)) {
      key = `${baseKey}_${suffix}`;
      suffix += 1;
    }

    const maxOrder = existingForEntity.reduce(
      (max, f) => Math.max(max, Number(f.order || 0)),
      -1,
    );

    const doc = await this.customFieldModel.create({
      tenantId: tenantObjectId,
      entity: dto.entity,
      key,
      label,
      type,
      options,
      required: Boolean(dto.required),
      placeholder: dto.placeholder?.trim() || '',
      defaultValue: dto.defaultValue ?? null,
      showInCard: dto.showInCard ?? true,
      order: maxOrder + 1,
      isActive: true,
    });

    return this.toDto(doc);
  }

  async applyPreset(auth: CustomFieldAuthContext, dto: ApplyCustomFieldPresetDto) {
    this.assertCanConfigure(auth);
    const items = INDUSTRY_PRESETS[dto.preset];
    if (!items) {
      throw new BadRequestException('Unknown industry preset.');
    }

    const tenantObjectId = new Types.ObjectId(auth.tenantId);
    const created: ReturnType<CustomFieldsService['toDto']>[] = [];
    let skippedCount = 0;

    for (const item of items) {
      const exists = await this.customFieldModel
        .findOne({ tenantId: tenantObjectId, entity: item.entity, key: item.key })
        .exec();
      if (exists) {
        skippedCount += 1;
        continue;
      }
      const res = await this.createField(auth, item);
      created.push(res);
    }

    return {
      createdCount: created.length,
      skippedCount,
      data: created,
    };
  }

  async updateField(
    auth: CustomFieldAuthContext,
    id: string,
    dto: UpdateCustomFieldDto,
  ) {
    this.assertCanConfigure(auth);
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Custom field not found.');
    }

    const doc = await this.customFieldModel
      .findOne({
        _id: new Types.ObjectId(id),
        tenantId: new Types.ObjectId(auth.tenantId),
      })
      .exec();
    if (!doc) {
      throw new NotFoundException('Custom field not found.');
    }

    if (dto.label !== undefined) {
      const clean = dto.label.trim();
      if (!clean) throw new BadRequestException('Field label cannot be empty.');
      doc.label = clean;
    }
    if (dto.type !== undefined && VALID_TYPES.includes(dto.type)) {
      doc.type = dto.type;
    }
    if (dto.options !== undefined) {
      doc.options = dto.options.map((o) => String(o).trim()).filter(Boolean);
    }
    if (doc.type === 'dropdown' && (!doc.options || doc.options.length === 0)) {
      throw new BadRequestException(
        'Dropdown custom fields require at least one option.',
      );
    }
    if (dto.required !== undefined) doc.required = Boolean(dto.required);
    if (dto.placeholder !== undefined) doc.placeholder = dto.placeholder.trim();
    if (dto.defaultValue !== undefined) doc.defaultValue = dto.defaultValue;
    if (dto.showInCard !== undefined) doc.showInCard = Boolean(dto.showInCard);
    if (dto.isActive !== undefined) doc.isActive = Boolean(dto.isActive);
    if (dto.order !== undefined) doc.order = Number(dto.order) || 0;

    await doc.save();
    return this.toDto(doc);
  }

  async reorderFields(
    auth: CustomFieldAuthContext,
    dto: ReorderCustomFieldsDto,
  ) {
    this.assertCanConfigure(auth);
    if (!VALID_ENTITIES.includes(dto.entity)) {
      throw new BadRequestException('Entity must be lead, contact, or deal.');
    }

    const tenantObjectId = new Types.ObjectId(auth.tenantId);
    const ids = Array.isArray(dto.orderedIds) ? dto.orderedIds : [];
    for (let i = 0; i < ids.length; i += 1) {
      const id = ids[i];
      if (!Types.ObjectId.isValid(id)) continue;
      await this.customFieldModel
        .updateOne(
          {
            _id: new Types.ObjectId(id),
            tenantId: tenantObjectId,
            entity: dto.entity,
          },
          { $set: { order: i } },
        )
        .exec();
    }

    return this.listFields(auth, dto.entity, true);
  }

  async deleteField(auth: CustomFieldAuthContext, id: string) {
    this.assertCanConfigure(auth);
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Custom field not found.');
    }
    const res = await this.customFieldModel
      .deleteOne({
        _id: new Types.ObjectId(id),
        tenantId: new Types.ObjectId(auth.tenantId),
      })
      .exec();
    if (!res.deletedCount) {
      throw new NotFoundException('Custom field not found.');
    }
    return { deleted: true, id };
  }

  /**
   * Normalizes incoming custom field key-value pairs against the tenant's active
   * schema for `entity`, preserving existing saved keys when updating partially.
   */
  async sanitizeEntityValues(
    tenantId: string,
    entity: CustomFieldEntity,
    incoming?: Record<string, unknown>,
    existing?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const base: Record<string, unknown> =
      existing && typeof existing === 'object' ? { ...existing } : {};

    if (!incoming || typeof incoming !== 'object') {
      return base;
    }

    const defs = await this.customFieldModel
      .find({
        tenantId: new Types.ObjectId(tenantId),
        entity,
        isActive: true,
      })
      .exec();
    const defMap = new Map(defs.map((d) => [d.key, d]));

    for (const [key, rawVal] of Object.entries(incoming)) {
      const def = defMap.get(key);
      if (!def) {
        if (rawVal === null || rawVal === undefined || rawVal === '') {
          delete base[key];
        } else if (
          typeof rawVal === 'string' ||
          typeof rawVal === 'number' ||
          typeof rawVal === 'boolean'
        ) {
          base[key] = rawVal;
        }
        continue;
      }

      if (rawVal === null || rawVal === undefined || rawVal === '') {
        if (def.type === 'checkbox') {
          base[key] = false;
        } else {
          delete base[key];
        }
        continue;
      }

      if (def.type === 'number') {
        const parsed = Number(rawVal);
        if (Number.isFinite(parsed)) {
          base[key] = parsed;
        }
      } else if (def.type === 'checkbox') {
        base[key] =
          typeof rawVal === 'boolean'
            ? rawVal
            : rawVal === 'true' || rawVal === '1' || rawVal === 1;
      } else if (def.type === 'dropdown') {
        const clean = String(rawVal).trim();
        if (def.options.length === 0 || def.options.includes(clean)) {
          base[key] = clean;
        }
      } else {
        base[key] = String(rawVal).trim();
      }
    }

    return base;
  }
}
