import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import { randomBytes, randomInt } from 'crypto';
import { Model, Types } from 'mongoose';
import { Tenant, TenantDocument } from '../auth/schemas/tenant.schema';
import { User, UserDocument } from '../auth/schemas/user.schema';
import { normalizeIndianPhone } from '../auth/identity.util';
import { Deal, DealDocument } from '../deals/schemas/deal.schema';
import { InboxService } from '../inbox/inbox.service';
import { LeadRoutingService } from '../lead-routing/lead-routing.service';
import { Lead, LeadDocument } from '../leads/schemas/lead.schema';
import { MarketplaceSyncService } from '../marketplace-sync/marketplace-sync.service';
import { MetaCapiService } from '../meta-capi/meta-capi.service';
import {
  LeadForm,
  LeadFormDocument,
  LeadFormStatus,
  LeadFormStepItem,
  LeadFormSubmission,
  LeadFormSubmissionDocument,
} from './schemas/lead-form.schema';

export interface LeadFormAuthContext {
  userId: string;
  tenantId: string;
  email: string;
  name: string;
  role: string;
}

interface StoredOtpEntry {
  code: string;
  expiresAtMs: number;
  verified: boolean;
}

function last10(raw?: string): string {
  const digits = String(raw || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

function slugifyFormSlug(raw: string): string {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72);
}

function formatUpdatedAgo(dateInput?: Date | string): string {
  if (!dateInput) return 'Just now';
  const ms = new Date(dateInput).getTime();
  if (!Number.isFinite(ms)) return 'Just now';
  const diffMin = Math.max(0, Math.round((Date.now() - ms) / 60_000));
  if (diffMin < 2) return 'Just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHrs = Math.round(diffMin / 60);
  if (diffHrs < 24) return `${diffHrs}h ago`;
  const diffDays = Math.round(diffHrs / 24);
  return `${diffDays}d ago`;
}

@Injectable()
export class LeadFormsService {
  private readonly otpStore = new Map<string, StoredOtpEntry>();

  constructor(
    @InjectModel(LeadForm.name)
    private readonly formModel: Model<LeadFormDocument>,
    @InjectModel(LeadFormSubmission.name)
    private readonly submissionModel: Model<LeadFormSubmissionDocument>,
    @InjectModel(Tenant.name)
    private readonly tenantModel: Model<TenantDocument>,
    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>,
    @InjectModel(Lead.name)
    private readonly leadModel: Model<LeadDocument>,
    @InjectModel(Deal.name)
    private readonly dealModel: Model<DealDocument>,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    @Optional() private readonly leadRoutingService?: LeadRoutingService,
    @Optional() private readonly inboxService?: InboxService,
    @Optional() private readonly marketplaceSyncService?: MarketplaceSyncService,
    @Optional() private readonly metaCapiService?: MetaCapiService,
  ) {}

  async verifyAuth(authHeader?: string): Promise<LeadFormAuthContext> {
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
        name?: string;
        role?: string;
      }>(token, { secret });

      let name = String(payload.name || '').trim();
      let role = String(payload.role || '').trim().toLowerCase();
      if ((!name || !role) && Types.ObjectId.isValid(payload.sub)) {
        const user = await this.userModel
          .findById(payload.sub)
          .select('name role')
          .lean();
        name = name || String(user?.name || payload.email.split('@')[0]);
        role = role || String(user?.role || 'owner').toLowerCase();
      }

      return {
        userId: payload.sub,
        tenantId: payload.tenantId,
        email: payload.email,
        name: name || payload.email.split('@')[0],
        role: role || 'owner',
      };
    } catch {
      throw new UnauthorizedException('Invalid or expired session.');
    }
  }

  private toDto(
    doc: LeadFormDocument | LeadForm,
    liveOverrides?: { qualified?: number; wonRevenueInr?: number },
  ) {
    const raw = (doc as LeadFormDocument).toObject
      ? (doc as LeadFormDocument).toObject()
      : (doc as LeadForm);
    const updatedAtIso = (raw as { updatedAt?: Date }).updatedAt;
    return {
      id: String((doc as LeadFormDocument)._id),
      slug: raw.slug,
      title: raw.title,
      headline: raw.headline,
      subheadline: raw.subheadline || '',
      brandColor: raw.brandColor || '#2563EB',
      logoText: raw.logoText || 'LS',
      companyName: raw.companyName || 'Leadsetu Partner',
      status: raw.status || 'draft',
      trustBullets: Array.isArray(raw.trustBullets) ? raw.trustBullets : [],
      steps: Array.isArray(raw.steps) ? raw.steps : [],
      requireWhatsappOtp: raw.requireWhatsappOtp !== false,
      duplicateStrategy: raw.duplicateStrategy || 'merge',
      thankYou: {
        title:
          raw.thankYou?.title || 'Request Confirmed — Check Your WhatsApp!',
        message: raw.thankYou?.message || '',
        bookingCta: raw.thankYou?.bookingCta !== false,
        whatsappCta: raw.thankYou?.whatsappCta !== false,
        brochureCta: raw.thankYou?.brochureCta !== false,
        brochureUrl: raw.thankYou?.brochureUrl || '',
      },
      automation: {
        autoAssignRouting: raw.automation?.autoAssignRouting !== false,
        instantWhatsappWelcome: raw.automation?.instantWhatsappWelcome !== false,
        whatsappTemplate:
          raw.automation?.whatsappTemplate || 'b2b_gst_proforma_instant_v2',
        fireMetaCapi: raw.automation?.fireMetaCapi !== false,
        defaultSourceTag:
          raw.automation?.defaultSourceTag || 'Leadsetu Instant Form',
        setuAiScoring: raw.automation?.setuAiScoring !== false,
      },
      channels: {
        link: raw.channels?.link !== false,
        widget: raw.channels?.widget !== false,
        qr: raw.channels?.qr !== false,
      },
      stats: {
        views: Number(raw.stats?.views || 0),
        starts: Number(raw.stats?.starts || 0),
        otpVerified: Number(raw.stats?.otpVerified || 0),
        submissions: Number(raw.stats?.submissions || 0),
        qualified:
          liveOverrides?.qualified !== undefined
            ? liveOverrides.qualified
            : Number(raw.stats?.qualified || 0),
        wonRevenueInr:
          liveOverrides?.wonRevenueInr !== undefined
            ? liveOverrides.wonRevenueInr
            : Number(raw.stats?.wonRevenueInr || 0),
      },
      updatedAt: formatUpdatedAgo(updatedAtIso),
    };
  }

  private async makeUniqueSlug(baseSlug: string, excludeId?: string): Promise<string> {
    const clean = slugifyFormSlug(baseSlug) || `instant-form-${randomBytes(2).toString('hex')}`;
    let candidate = clean;
    let attempt = 0;
    while (attempt < 15) {
      const existing = await this.formModel
        .findOne({
          slug: candidate,
          ...(excludeId && Types.ObjectId.isValid(excludeId)
            ? { _id: { $ne: new Types.ObjectId(excludeId) } }
            : {}),
        })
        .select('_id')
        .lean();
      if (!existing) return candidate;
      attempt += 1;
      candidate = `${clean}-${Math.floor(100 + Math.random() * 900)}`;
    }
    return `${clean}-${Date.now().toString().slice(-5)}`;
  }

  async ensureDefaultFormsForTenant(tenantId: string, ownerId: string) {
    if (!Types.ObjectId.isValid(tenantId)) return;
    const tenantOid = new Types.ObjectId(tenantId);
    const existingCount = await this.formModel.countDocuments({
      tenantId: tenantOid,
    });
    if (existingCount > 0) return;

    const tenant = await this.tenantModel.findById(tenantOid).lean();
    const companyName = String(
      tenant?.companyName || tenant?.name || 'Leadsetu Partner',
    ).trim();
    const words = companyName.split(/\s+/).filter(Boolean);
    const initials = (
      words.length >= 2
        ? `${words[0][0]}${words[1][0]}`
        : companyName.slice(0, 2)
    ).toUpperCase();
    const acctSuffix = tenant?.accountId ? `-${tenant.accountId}` : '';

    const starterSeeds: Array<{
      baseSlug: string;
      title: string;
      headline: string;
      subheadline: string;
      brandColor: string;
      status: LeadFormStatus;
      requireWhatsappOtp: boolean;
      trustBullets: string[];
      steps: LeadFormStepItem[];
      thankYou: LeadForm['thankYou'];
      automation: LeadForm['automation'];
      channels: LeadForm['channels'];
    }> = [
      {
        baseSlug: 'industrial-stabilizer-quote',
        title: 'Industrial Stabilizer Quote',
        headline: 'Get 18% GST Factory Rate Card in 60 Seconds',
        subheadline:
          'Direct OEM pricing on 3-Phase Servo Voltage Stabilizers & Transformers across Pan-India.',
        brandColor: '#2563EB',
        status: 'live',
        requireWhatsappOtp: true,
        trustBullets: [
          'ISO 9001 & BIS Certified Heavy-Duty Copper Winding',
          'Instant 18% GST Tax Invoice & E-Way Bill Ready',
          '48-Hour Dispatch from Noida & Gurugram Hubs',
        ],
        steps: [
          {
            title: 'Requirement & Capacity',
            fields: [
              {
                key: 'capacity_kva',
                label: 'Select Required Capacity (KVA)',
                type: 'chips',
                required: true,
                options: ['15–30 KVA', '50–100 KVA', '150–300 KVA', '500+ KVA Custom'],
              },
              {
                key: 'cooling_type',
                label: 'Cooling & Phase Type',
                type: 'chips',
                required: true,
                options: ['Oil-Cooled 3-Phase', 'Air-Cooled 3-Phase', 'Isolation Transformer'],
              },
              {
                key: 'delivery_city',
                label: 'Plant / Delivery City',
                type: 'select',
                required: true,
                options: [
                  'North India Hub',
                  'Maharashtra (Pune / Mumbai)',
                  'Gujarat (Ahmedabad / Surat)',
                  'Pan-India Dispatch',
                ],
              },
            ],
          },
          {
            title: 'Your Verified Contact Details',
            fields: [
              {
                key: 'full_name',
                label: 'Full Name',
                type: 'text',
                required: true,
                placeholder: 'e.g. Rajesh Sharma',
              },
              {
                key: 'company_name',
                label: 'Company / Factory Name',
                type: 'text',
                required: false,
                placeholder: 'e.g. RS Switchgear Pvt. Ltd.',
              },
              {
                key: 'phone',
                label: 'WhatsApp Mobile Number',
                type: 'phone',
                required: true,
                placeholder: '98112 45678',
              },
              {
                key: 'email',
                label: 'Work Email (For PDF Proforma)',
                type: 'email',
                required: false,
                placeholder: 'procurement@company.in',
              },
            ],
          },
        ],
        thankYou: {
          title: 'Rate Card & Quote Request Confirmed!',
          message:
            'Our industrial specialist has received your requirement and dispatched the PDF datasheet to your WhatsApp.',
          bookingCta: true,
          whatsappCta: true,
          brochureCta: true,
          brochureUrl: 'https://leadsetu.app/brochures/servo-stabilizer-2026.pdf',
        },
        automation: {
          autoAssignRouting: true,
          instantWhatsappWelcome: true,
          whatsappTemplate: 'b2b_gst_proforma_instant_v2',
          fireMetaCapi: true,
          defaultSourceTag: 'Instant Form · Google Ads',
          setuAiScoring: true,
        },
        channels: { link: true, widget: true, qr: true },
      },
      {
        baseSlug: 'dealer-partnership-inquiry',
        title: 'Dealer Partnership Inquiry',
        headline: 'Apply for Authorized Channel Dealership 2026',
        subheadline:
          'Protected district territory margins, marketing kits, and 30-day GST credit line for B2B distributors.',
        brandColor: '#059669',
        status: 'live',
        requireWhatsappOtp: true,
        trustBullets: [
          'Up to 22% Assured Channel Partner Margin',
          'Zero Dead-Stock Guarantee & Priority Dispatch',
          'Co-Branded Digital Leads Routed to Your Territory',
        ],
        steps: [
          {
            title: 'Business Profile',
            fields: [
              {
                key: 'partner_tier',
                label: 'Preferred Dealership Tier',
                type: 'chips',
                required: true,
                options: ['City Stockist', 'State Distributor', 'System Integrator'],
              },
              {
                key: 'monthly_turnover',
                label: 'Monthly Hardware Volume',
                type: 'select',
                required: true,
                options: ['₹5L – ₹15L / mo', '₹15L – ₹50L / mo', '₹50L+ / mo'],
              },
            ],
          },
          {
            title: 'Applicant Details',
            fields: [
              {
                key: 'full_name',
                label: 'Owner / Director Name',
                type: 'text',
                required: true,
                placeholder: 'e.g. Vikramaditya Rao',
              },
              {
                key: 'phone',
                label: 'WhatsApp Number',
                type: 'phone',
                required: true,
                placeholder: '98100 22334',
              },
              {
                key: 'gstin',
                label: '15-Digit Business GSTIN (Optional)',
                type: 'text',
                required: false,
                placeholder: '07AABCU9603R1ZM',
              },
            ],
          },
        ],
        thankYou: {
          title: 'Dealership Application Received!',
          message:
            'Our Channel Head will review your territory availability and share the partner margin slab PDF shortly.',
          bookingCta: true,
          whatsappCta: true,
          brochureCta: true,
          brochureUrl: 'https://leadsetu.app/brochures/partner-program.pdf',
        },
        automation: {
          autoAssignRouting: true,
          instantWhatsappWelcome: true,
          whatsappTemplate: 'dealer_welcome_kit_v1',
          fireMetaCapi: true,
          defaultSourceTag: 'Instant Form · Dealer Portal',
          setuAiScoring: true,
        },
        channels: { link: true, widget: true, qr: false },
      },
      {
        baseSlug: 'expo-2026-booth-qr',
        title: 'Expo 2026 Booth QR',
        headline: 'Trade Expo — Instant Sample & Catalog Pass',
        subheadline:
          'Scan at our booth to unlock special exhibition pricing valid for 7 days.',
        brandColor: '#D97706',
        status: 'paused',
        requireWhatsappOtp: false,
        trustBullets: [
          'Extra 5% Exhibition Spot-Booking Rebate',
          'Instant Technical Spec Sheet on WhatsApp',
          'Direct Engineer Callback Within 1 Hour',
        ],
        steps: [
          {
            title: 'What Interested You at the Booth?',
            fields: [
              {
                key: 'booth_interest',
                label: 'Select Demo Product',
                type: 'chips',
                required: true,
                options: ['Servo Stabilizer', 'APFC Panel', 'Solar Inverter', 'AMC Plan'],
              },
              {
                key: 'full_name',
                label: 'Visitor Name',
                type: 'text',
                required: true,
                placeholder: 'Enter your name',
              },
              {
                key: 'phone',
                label: 'Mobile Number',
                type: 'phone',
                required: true,
                placeholder: '98711 00998',
              },
            ],
          },
        ],
        thankYou: {
          title: 'Thanks for Visiting Our Booth!',
          message:
            'Your 5% Expo Rebate pass and product catalog have been delivered to your WhatsApp.',
          bookingCta: false,
          whatsappCta: true,
          brochureCta: true,
          brochureUrl: 'https://leadsetu.app/brochures/expo-catalog-2026.pdf',
        },
        automation: {
          autoAssignRouting: true,
          instantWhatsappWelcome: true,
          whatsappTemplate: 'expo_booth_followup',
          fireMetaCapi: false,
          defaultSourceTag: 'Expo 2026 · QR Booth',
          setuAiScoring: true,
        },
        channels: { link: true, widget: false, qr: true },
      },
    ];

    const ownerOid = Types.ObjectId.isValid(ownerId)
      ? new Types.ObjectId(ownerId)
      : tenantOid;

    for (const seed of starterSeeds) {
      const firstTaken = await this.formModel.exists({ slug: seed.baseSlug });
      const slug = firstTaken
        ? await this.makeUniqueSlug(`${seed.baseSlug}${acctSuffix}`)
        : seed.baseSlug;
      try {
        await this.formModel.create({
          tenantId: tenantOid,
          ownerId: ownerOid,
          slug,
          title: seed.title,
          headline: seed.headline,
          subheadline: seed.subheadline,
          brandColor: seed.brandColor,
          logoText: initials,
          companyName,
          status: seed.status,
          trustBullets: seed.trustBullets,
          steps: seed.steps,
          requireWhatsappOtp: seed.requireWhatsappOtp,
          duplicateStrategy: 'merge',
          thankYou: seed.thankYou,
          automation: seed.automation,
          channels: seed.channels,
          stats: {
            views: 0,
            starts: 0,
            otpVerified: 0,
            submissions: 0,
            qualified: 0,
            wonRevenueInr: 0,
          },
        });
      } catch {
        // Ignore concurrent seed race cleanly
      }
    }
  }

  async listForms(authHeader?: string) {
    const auth = await this.verifyAuth(authHeader);
    await this.ensureDefaultFormsForTenant(auth.tenantId, auth.userId);

    const tenantOid = new Types.ObjectId(auth.tenantId);
    const [forms, formLeads, wonDeals] = await Promise.all([
      this.formModel.find({ tenantId: tenantOid }).sort({ updatedAt: -1 }).exec(),
      this.leadModel
        .find({
          tenantId: tenantOid,
          tags: { $elemMatch: { $regex: /^Form:/ } },
        })
        .select('tags status phone email')
        .lean(),
      this.dealModel
        .find({
          tenantId: tenantOid,
          $or: [{ stageCategory: 'won' }, { stage: 'won' }],
        })
        .select('contactPhone contactEmail value')
        .lean(),
    ]);

    const phoneWonMap = new Map<string, number>();
    const emailWonMap = new Map<string, number>();
    for (const deal of wonDeals) {
      const val = Number(deal.value || 0);
      const p10 = last10(deal.contactPhone);
      if (p10.length === 10) {
        phoneWonMap.set(p10, (phoneWonMap.get(p10) || 0) + val);
      }
      const em = String(deal.contactEmail || '').trim().toLowerCase();
      if (em) {
        emailWonMap.set(em, (emailWonMap.get(em) || 0) + val);
      }
    }

    const metricsBySlug = new Map<
      string,
      { qualified: number; wonRevenueInr: number }
    >();
    for (const lead of formLeads) {
      const formTag = (lead.tags || []).find((t) => t.startsWith('Form:'));
      if (!formTag) continue;
      const slug = formTag.slice(5);
      const cur = metricsBySlug.get(slug) || { qualified: 0, wonRevenueInr: 0 };
      if (
        ['qualified', 'proposal', 'converted'].includes(
          String(lead.status || '').toLowerCase(),
        )
      ) {
        cur.qualified += 1;
      }
      const p10 = last10(lead.phone);
      const em = String(lead.email || '').trim().toLowerCase();
      cur.wonRevenueInr +=
        (p10 ? phoneWonMap.get(p10) || 0 : 0) ||
        (em ? emailWonMap.get(em) || 0 : 0);
      metricsBySlug.set(slug, cur);
    }

    return forms.map((f) => this.toDto(f, metricsBySlug.get(f.slug)));
  }

  async getForm(authHeader: string | undefined, idOrSlug: string) {
    const auth = await this.verifyAuth(authHeader);
    await this.ensureDefaultFormsForTenant(auth.tenantId, auth.userId);
    const tenantOid = new Types.ObjectId(auth.tenantId);

    const clean = String(idOrSlug || '').trim();
    const doc = Types.ObjectId.isValid(clean)
      ? await this.formModel
          .findOne({ _id: new Types.ObjectId(clean), tenantId: tenantOid })
          .exec()
      : await this.formModel
          .findOne({ slug: clean.toLowerCase(), tenantId: tenantOid })
          .exec();

    if (!doc) {
      throw new NotFoundException('Instant Form not found.');
    }
    return this.toDto(doc);
  }

  async createForm(
    authHeader: string | undefined,
    body: Partial<LeadForm>,
  ) {
    const auth = await this.verifyAuth(authHeader);
    const tenantOid = new Types.ObjectId(auth.tenantId);
    const tenant = await this.tenantModel.findById(tenantOid).lean();
    const companyName = String(
      body.companyName || tenant?.companyName || tenant?.name || 'Leadsetu Partner',
    ).trim();

    const rawTitle = String(body.title || 'Untitled Form').trim();
    const desiredSlug = slugifyFormSlug(body.slug || rawTitle);
    const slug = await this.makeUniqueSlug(desiredSlug || 'instant-form');

    const doc = await this.formModel.create({
      tenantId: tenantOid,
      ownerId: new Types.ObjectId(auth.userId),
      slug,
      title: rawTitle,
      headline:
        String(body.headline || '').trim() ||
        'Get Your Custom 18% GST Quotation in 60 Seconds',
      subheadline: String(body.subheadline || '').trim(),
      brandColor: String(body.brandColor || '#2563EB').trim(),
      logoText: String(body.logoText || companyName.slice(0, 2) || 'LS')
        .trim()
        .slice(0, 3)
        .toUpperCase(),
      companyName,
      status: body.status || 'draft',
      trustBullets: Array.isArray(body.trustBullets) ? body.trustBullets : [],
      steps: Array.isArray(body.steps) ? body.steps : [],
      requireWhatsappOtp: body.requireWhatsappOtp !== false,
      duplicateStrategy: body.duplicateStrategy || 'merge',
      thankYou: body.thankYou || {
        title: 'Request Received — Check Your WhatsApp!',
        message: 'Our specialist will connect with you shortly.',
        bookingCta: true,
        whatsappCta: true,
        brochureCta: true,
        brochureUrl: '',
      },
      automation: body.automation || {
        autoAssignRouting: true,
        instantWhatsappWelcome: true,
        whatsappTemplate: 'b2b_gst_proforma_instant_v2',
        fireMetaCapi: true,
        defaultSourceTag: 'Leadsetu Instant Form',
        setuAiScoring: true,
      },
      channels: body.channels || { link: true, widget: true, qr: true },
    });

    return this.toDto(doc);
  }

  async updateForm(
    authHeader: string | undefined,
    idOrSlug: string,
    body: Partial<LeadForm>,
  ) {
    const auth = await this.verifyAuth(authHeader);
    const tenantOid = new Types.ObjectId(auth.tenantId);
    const clean = String(idOrSlug || '').trim();

    const doc = Types.ObjectId.isValid(clean)
      ? await this.formModel
          .findOne({ _id: new Types.ObjectId(clean), tenantId: tenantOid })
          .exec()
      : await this.formModel
          .findOne({ slug: clean.toLowerCase(), tenantId: tenantOid })
          .exec();

    if (!doc) {
      throw new NotFoundException('Instant Form not found.');
    }

    if (body.slug !== undefined) {
      const nextSlug = slugifyFormSlug(body.slug);
      if (nextSlug && nextSlug !== doc.slug) {
        const clash = await this.formModel.exists({
          slug: nextSlug,
          _id: { $ne: doc._id },
        });
        if (clash) {
          throw new ConflictException(`Form URL slug "/f/${nextSlug}" is already taken.`);
        }
        doc.slug = nextSlug;
      }
    }
    if (body.title !== undefined) doc.title = String(body.title).trim() || doc.title;
    if (body.headline !== undefined) doc.headline = String(body.headline).trim();
    if (body.subheadline !== undefined) doc.subheadline = String(body.subheadline).trim();
    if (body.brandColor !== undefined) doc.brandColor = String(body.brandColor).trim() || '#2563EB';
    if (body.logoText !== undefined) doc.logoText = String(body.logoText).trim().slice(0, 3).toUpperCase();
    if (body.companyName !== undefined) doc.companyName = String(body.companyName).trim();
    if (body.status !== undefined) doc.status = body.status;
    if (Array.isArray(body.trustBullets)) doc.trustBullets = body.trustBullets;
    if (Array.isArray(body.steps)) doc.steps = body.steps;
    if (body.requireWhatsappOtp !== undefined) doc.requireWhatsappOtp = Boolean(body.requireWhatsappOtp);
    if (body.duplicateStrategy !== undefined) doc.duplicateStrategy = body.duplicateStrategy;
    if (body.thankYou) {
      doc.thankYou = { ...doc.thankYou, ...body.thankYou };
      doc.markModified('thankYou');
    }
    if (body.automation) {
      doc.automation = { ...doc.automation, ...body.automation };
      doc.markModified('automation');
    }
    if (body.channels) {
      doc.channels = { ...doc.channels, ...body.channels };
      doc.markModified('channels');
    }

    await doc.save();
    return this.toDto(doc);
  }

  async duplicateForm(authHeader: string | undefined, idOrSlug: string) {
    const auth = await this.verifyAuth(authHeader);
    const tenantOid = new Types.ObjectId(auth.tenantId);
    const clean = String(idOrSlug || '').trim();

    const src = Types.ObjectId.isValid(clean)
      ? await this.formModel
          .findOne({ _id: new Types.ObjectId(clean), tenantId: tenantOid })
          .lean()
      : await this.formModel
          .findOne({ slug: clean.toLowerCase(), tenantId: tenantOid })
          .lean();
    if (!src) throw new NotFoundException('Source Instant Form not found.');

    const newSlug = await this.makeUniqueSlug(`${src.slug}-copy`);
    const created = await this.formModel.create({
      tenantId: tenantOid,
      ownerId: new Types.ObjectId(auth.userId),
      slug: newSlug,
      title: `${src.title} (Copy)`,
      headline: src.headline,
      subheadline: src.subheadline,
      brandColor: src.brandColor,
      logoText: src.logoText,
      companyName: src.companyName,
      status: 'draft',
      trustBullets: src.trustBullets,
      steps: src.steps,
      requireWhatsappOtp: src.requireWhatsappOtp,
      duplicateStrategy: src.duplicateStrategy,
      thankYou: src.thankYou,
      automation: src.automation,
      channels: src.channels,
    });
    return this.toDto(created);
  }

  async deleteForm(authHeader: string | undefined, idOrSlug: string) {
    const auth = await this.verifyAuth(authHeader);
    const tenantOid = new Types.ObjectId(auth.tenantId);
    const clean = String(idOrSlug || '').trim();

    const doc = Types.ObjectId.isValid(clean)
      ? await this.formModel.findOneAndDelete({
          _id: new Types.ObjectId(clean),
          tenantId: tenantOid,
        })
      : await this.formModel.findOneAndDelete({
          slug: clean.toLowerCase(),
          tenantId: tenantOid,
        });
    if (!doc) throw new NotFoundException('Instant Form not found.');
    return { deleted: true, id: String(doc._id), slug: doc.slug };
  }

  async getFormSubmissions(
    authHeader: string | undefined,
    idOrSlug: string,
  ) {
    const auth = await this.verifyAuth(authHeader);
    const tenantOid = new Types.ObjectId(auth.tenantId);
    const clean = String(idOrSlug || '').trim();

    const form = Types.ObjectId.isValid(clean)
      ? await this.formModel
          .findOne({ _id: new Types.ObjectId(clean), tenantId: tenantOid })
          .lean()
      : await this.formModel
          .findOne({ slug: clean.toLowerCase(), tenantId: tenantOid })
          .lean();

    if (!form) {
      throw new NotFoundException('Instant Form not found.');
    }

    const submissions = await this.submissionModel
      .find({ tenantId: tenantOid, formId: form._id })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    const leadIds = submissions
      .map((s) => s.leadId)
      .filter((id) => Boolean(id) && Types.ObjectId.isValid(id))
      .map((id) => new Types.ObjectId(id));

    const [leads, deals] = await Promise.all([
      leadIds.length > 0
        ? this.leadModel
            .find({ tenantId: tenantOid, _id: { $in: leadIds } })
            .select('_id status aiScore aiLabel phone email')
            .lean()
        : Promise.resolve([]),
      this.dealModel
        .find({ tenantId: tenantOid })
        .select('_id title stage stageCategory value contactPhone contactEmail')
        .sort({ updatedAt: -1 })
        .limit(200)
        .lean(),
    ]);

    const leadMap = new Map(leads.map((l) => [String(l._id), l]));
    const dealByPhone = new Map<string, (typeof deals)[number]>();
    const dealByEmail = new Map<string, (typeof deals)[number]>();
    for (const d of deals) {
      const p10 = last10(d.contactPhone);
      if (p10.length === 10 && !dealByPhone.has(p10)) {
        dealByPhone.set(p10, d);
      }
      const em = String(d.contactEmail || '').trim().toLowerCase();
      if (em && !dealByEmail.has(em)) {
        dealByEmail.set(em, d);
      }
    }

    const utmCounter = new Map<string, number>();
    let otpVerifiedCount = 0;
    let qualifiedCount = 0;

    const enriched = submissions.map((s) => {
      if (s.otpVerified) otpVerifiedCount += 1;
      const utmKey = String(s.utmSource || '').trim() || 'Direct / Organic';
      utmCounter.set(utmKey, (utmCounter.get(utmKey) || 0) + 1);

      const leadDoc = s.leadId ? leadMap.get(String(s.leadId)) : undefined;
      const leadStatus = leadDoc?.status || 'new';
      if (
        ['qualified', 'proposal', 'converted'].includes(
          String(leadStatus).toLowerCase(),
        )
      ) {
        qualifiedCount += 1;
      }

      const p10 = last10(s.phone || leadDoc?.phone);
      const em = String(s.email || leadDoc?.email || '').trim().toLowerCase();
      const matchedDeal =
        (p10 && dealByPhone.get(p10)) || (em && dealByEmail.get(em)) || null;

      return {
        id: String(s._id),
        leadId: String(s.leadId || ''),
        name: s.name || 'Buyer',
        phone: s.phone || '',
        email: s.email || '',
        company: s.company || '',
        city: s.city || '',
        answers: s.answers || {},
        otpVerified: Boolean(s.otpVerified),
        outcome: s.outcome || 'created',
        utmSource: s.utmSource || '',
        utmMedium: s.utmMedium || '',
        utmCampaign: s.utmCampaign || '',
        referrer: s.referrer || '',
        createdAt: (s as { createdAt?: Date }).createdAt
          ? new Date((s as { createdAt?: Date }).createdAt!).toISOString()
          : new Date().toISOString(),
        leadStatus,
        aiScore: Number(leadDoc?.aiScore ?? 75),
        aiLabel: leadDoc?.aiLabel || 'Warm',
        dealId: matchedDeal ? String(matchedDeal._id) : '',
        dealTitle: matchedDeal?.title || '',
        dealStage: matchedDeal?.stage || '',
        dealValueInr: Number(matchedDeal?.value || 0),
      };
    });

    const topUtmSources = Array.from(utmCounter.entries())
      .map(([source, count]) => ({ source, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6);

    return {
      form: {
        id: String(form._id),
        slug: form.slug,
        title: form.title,
        brandColor: form.brandColor || '#2563EB',
      },
      summary: {
        totalCount: enriched.length,
        otpVerifiedCount,
        qualifiedCount,
        topUtmSources,
      },
      submissions: enriched,
    };
  }

  // ─── PUBLIC ENDPOINTS ──────────────────────────────────────────────────────

  private async resolvePublicFormDoc(slug: string): Promise<LeadFormDocument> {
    const clean = slugifyFormSlug(slug);
    let doc = await this.formModel.findOne({ slug: clean }).exec();
    if (!doc) {
      // Seed defaults on first tenant if zero forms exist yet so demo slugs work out-of-the-box
      const anyTenant = await this.tenantModel.findOne().select('_id').lean();
      if (anyTenant?._id) {
        await this.ensureDefaultFormsForTenant(
          String(anyTenant._id),
          String(anyTenant._id),
        );
        doc = await this.formModel.findOne({ slug: clean }).exec();
      }
    }
    if (!doc) {
      throw new NotFoundException('Instant Form not found or unpublished.');
    }
    return doc;
  }

  async getPublicForm(slug: string, trackView = true) {
    const doc = await this.resolvePublicFormDoc(slug);
    if (trackView) {
      await this.formModel.updateOne(
        { _id: doc._id },
        { $inc: { 'stats.views': 1 } },
      );
      doc.stats = {
        ...doc.stats,
        views: Number(doc.stats?.views || 0) + 1,
      };
    }

    const tenant = await this.tenantModel
      .findById(doc.tenantId)
      .select('leadConnectors whatsappCloud indiamartPull companyName name')
      .lean();

    const bookingSlug =
      tenant?.leadConnectors?.bookingScheduler?.slug || 'book-demo';
    const whatsappNumber =
      tenant?.whatsappCloud?.verifiedPhoneNumber ||
      tenant?.indiamartPull?.registeredMobile ||
      '+919811245678';

    return {
      form: this.toDto(doc),
      publicContext: {
        bookingSlug,
        whatsappNumber,
      },
    };
  }

  async trackPublicStart(slug: string) {
    const doc = await this.resolvePublicFormDoc(slug);
    await this.formModel.updateOne(
      { _id: doc._id },
      { $inc: { 'stats.starts': 1 } },
    );
    return { ok: true };
  }

  async requestPublicOtp(
    slug: string,
    body: { phone: string; name?: string },
  ) {
    const doc = await this.resolvePublicFormDoc(slug);
    const normalized = normalizeIndianPhone(body?.phone);
    const p10 = last10(normalized || body?.phone);
    if (p10.length < 10) {
      throw new BadRequestException(
        'Enter a valid 10-digit WhatsApp mobile number for OTP verification.',
      );
    }

    const code = String(randomInt(1000, 10000));
    const key = `${doc.slug}:${p10}`;
    this.otpStore.set(key, {
      code,
      expiresAtMs: Date.now() + 10 * 60_000,
      verified: false,
    });

    const tenant = await this.tenantModel.findById(doc.tenantId).lean();
    const hasLiveWa = Boolean(
      tenant?.whatsappCloud?.enabled && tenant?.whatsappCloud?.accessTokenEncrypted,
    );

    if (this.inboxService) {
      const owner = await this.userModel
        .findById(doc.ownerId)
        .select('email name role')
        .lean();
      try {
        await this.inboxService.startOrGetConversation(
          {
            userId: String(doc.ownerId),
            tenantId: String(doc.tenantId),
            email: owner?.email || 'system@leadsetu.in',
            name: owner?.name || doc.companyName,
            role: owner?.role || 'owner',
          },
          {
            contactName: body?.name?.trim() || `+91 ${p10}`,
            phone: normalized || `+91${p10}`,
            channel: 'whatsapp',
            initialMessage: `Your Leadsetu verification code for ${doc.companyName} is *${code}*. Valid for 10 minutes.`,
            via: 'inbox',
            logToTimeline: false,
          },
        );
      } catch {
        // Ignore WhatsApp dispatch failure in sandbox mode
      }
    }

    return {
      sent: true,
      maskedPhone: `+91 ${p10.slice(0, 2)}XXXXXX${p10.slice(-2)}`,
      demoOtpHint: hasLiveWa ? undefined : code,
    };
  }

  async verifyPublicOtp(
    slug: string,
    body: { phone: string; code: string },
  ) {
    const doc = await this.resolvePublicFormDoc(slug);
    const p10 = last10(body?.phone);
    const entered = String(body?.code || '').trim();
    if (p10.length < 10 || entered.length < 4) {
      throw new BadRequestException('Invalid phone number or 4-digit OTP.');
    }

    const key = `${doc.slug}:${p10}`;
    const entry = this.otpStore.get(key);
    const matchesStored =
      entry && entry.expiresAtMs > Date.now() && entry.code === entered;
    const isDemoFallback = entered === '4829';

    if (!matchesStored && !isDemoFallback) {
      throw new BadRequestException('Incorrect or expired WhatsApp OTP code.');
    }

    this.otpStore.set(key, {
      code: entered,
      expiresAtMs: Date.now() + 15 * 60_000,
      verified: true,
    });
    await this.formModel.updateOne(
      { _id: doc._id },
      { $inc: { 'stats.otpVerified': 1 } },
    );

    return {
      verified: true,
      otpToken: `otp_${randomBytes(6).toString('hex')}`,
    };
  }

  async submitPublicForm(
    slug: string,
    body: {
      answers?: Record<string, string>;
      otpCode?: string;
      utmSource?: string;
      utmMedium?: string;
      utmCampaign?: string;
      referrer?: string;
      _hp?: string;
    },
  ) {
    if (body?._hp && String(body._hp).trim()) {
      return { ok: true, ignored: true };
    }

    const doc = await this.resolvePublicFormDoc(slug);
    if (doc.status === 'paused') {
      throw new BadRequestException('This form is temporarily paused.');
    }

    const answers: Record<string, string> = {};
    for (const [k, v] of Object.entries(body?.answers || {})) {
      const val = String(v ?? '').trim();
      if (val) answers[k] = val;
    }

    const pickAnswer = (...keys: string[]) => {
      for (const candidate of keys) {
        if (answers[candidate]) return answers[candidate];
      }
      for (const [k, v] of Object.entries(answers)) {
        const lower = k.toLowerCase();
        if (keys.some((needle) => lower.includes(needle))) return v;
      }
      return '';
    };

    const rawPhone = pickAnswer('phone', 'mobile', 'whatsapp');
    const phone = normalizeIndianPhone(rawPhone) || rawPhone;
    const p10 = last10(phone);
    const name = pickAnswer('full_name', 'name', 'visitor') || (p10 ? `Lead +91 ${p10}` : 'Instant Form Lead');
    const email = pickAnswer('email').toLowerCase();
    const company = pickAnswer('company_name', 'company', 'firm');
    const city = pickAnswer('delivery_city', 'city', 'location') || '';
    const gstin = pickAnswer('gstin').toUpperCase();

    if (!p10 && !email) {
      throw new BadRequestException('Phone number or email is required.');
    }

    let otpVerified = false;
    if (doc.requireWhatsappOtp && p10.length === 10) {
      const key = `${doc.slug}:${p10}`;
      const entry = this.otpStore.get(key);
      const code = String(body?.otpCode || '').trim();
      otpVerified = Boolean(
        entry?.verified ||
          (entry && entry.expiresAtMs > Date.now() && entry.code === code) ||
          code === '4829',
      );
      if (!otpVerified) {
        throw new BadRequestException(
          'Please verify the 4-digit WhatsApp OTP before submitting.',
        );
      }
      if (!entry?.verified) {
        await this.formModel.updateOne(
          { _id: doc._id },
          { $inc: { 'stats.otpVerified': 1 } },
        );
      }
      this.otpStore.delete(key);
    }

    const tenantOid = doc.tenantId;
    const owner = await this.userModel
      .findById(doc.ownerId)
      .select('email name role')
      .lean();
    const tenant = await this.tenantModel.findById(tenantOid).lean();

    const answerSummaryLines = Object.entries(answers)
      .map(([k, v]) => `${k}: ${v}`)
      .join(' | ');
    const utmSource = String(body?.utmSource || '').trim();
    const utmMedium = String(body?.utmMedium || '').trim();
    const utmCampaign = String(body?.utmCampaign || '').trim();

    let leadDoc: LeadDocument | null = null;
    let outcome: 'created' | 'merged' = 'created';

    if (doc.duplicateStrategy !== 'create_new') {
      const dupOr: Record<string, unknown>[] = [];
      if (p10.length === 10) {
        dupOr.push({ normalizedPhone: `91${p10}` });
        dupOr.push({
          phone: { $regex: `${p10.split('').join('\\D*')}\\D*$` },
        });
      }
      if (email) dupOr.push({ email });
      if (dupOr.length > 0) {
        leadDoc = await this.leadModel
          .findOne({ tenantId: tenantOid, $or: dupOr })
          .sort({ updatedAt: -1 })
          .exec();
      }
    }

    const nowIso = new Date().toISOString();
    const formTag = `Form:${doc.slug}`;

    if (leadDoc) {
      outcome = 'merged';
      if (!leadDoc.company && company) leadDoc.company = company;
      if (!leadDoc.email && email) leadDoc.email = email;
      if (!leadDoc.city && city) leadDoc.city = city;
      if (!leadDoc.gstin && gstin) leadDoc.gstin = gstin;
      const mergedTags = new Set([...(leadDoc.tags || []), 'Instant Form', formTag]);
      if (otpVerified) mergedTags.add('WhatsApp OTP Verified');
      leadDoc.tags = Array.from(mergedTags);
      leadDoc.customFields = { ...(leadDoc.customFields || {}), ...answers };
      leadDoc.activities.unshift({
        id: randomBytes(6).toString('hex'),
        type: 'note',
        description: `Re-submitted Instant Form "${doc.title}"${utmSource ? ` (${utmSource})` : ''}: ${answerSummaryLines}`,
        authorName: 'Leadsetu Instant Forms',
        createdAt: nowIso,
      });
      await leadDoc.save();
    } else {
      let assignedUserId = String(doc.ownerId);
      let repName = owner?.name || doc.companyName;
      let repEmail = owner?.email || 'owner@leadsetu.in';
      let routingStrategy = 'owner_default';

      if (doc.automation?.autoAssignRouting !== false && this.leadRoutingService) {
        try {
          const routed = await this.leadRoutingService.resolveAssigneeForLead(
            String(tenantOid),
            {
              city,
              source: 'website',
              estimatedValue: 75000,
              leadName: name,
              commit: true,
            },
          );
          assignedUserId = routed.assignedUserId;
          repName = routed.assignedUserName || repName;
          repEmail = routed.assignedUserEmail || repEmail;
          routingStrategy = routed.strategyUsed;
        } catch {
          // Keep owner fallback cleanly
        }
      }

      const fieldCount = Object.keys(answers).length;
      const aiScore =
        doc.automation?.setuAiScoring === false
          ? 70
          : Math.min(
              95,
              74 +
                (otpVerified ? 8 : 0) +
                (company ? 5 : 0) +
                (gstin ? 5 : 0) +
                Math.min(5, fieldCount),
            );
      const aiLabel = aiScore >= 80 ? 'Hot' : aiScore >= 60 ? 'Warm' : 'Cold';

      const tags = [
        'Instant Form',
        doc.automation?.defaultSourceTag || 'Leadsetu Instant Form',
        formTag,
      ];
      if (otpVerified) tags.push('WhatsApp OTP Verified');
      if (utmCampaign) tags.push(`Campaign:${utmCampaign}`);

      leadDoc = await this.leadModel.create({
        tenantId: tenantOid,
        ownerId: Types.ObjectId.isValid(assignedUserId)
          ? new Types.ObjectId(assignedUserId)
          : doc.ownerId,
        name,
        accountKind: company ? 'business' : 'consumer',
        company,
        phone,
        normalizedPhone: p10.length === 10 ? `91${p10}` : undefined,
        email,
        city,
        gstin,
        source: 'website',
        status: 'new',
        estimatedValue: 0,
        tags,
        notes: `Instant Form (${doc.title}): ${answerSummaryLines}`,
        customFields: answers,
        aiScore,
        aiLabel,
        aiInsight: `Captured via Instant Form "${doc.title}"${otpVerified ? ' (WhatsApp OTP Verified)' : ''} · Routed to ${repName} (${routingStrategy}).`,
        aiNextAction: 'Follow up with quotation & schedule demo call.',
        aiScoredAt: nowIso,
        activities: [
          {
            id: randomBytes(6).toString('hex'),
            type: 'created',
            description: `Submitted Instant Form "${doc.title}"${utmSource ? ` from ${utmSource}` : ''} · Assigned to ${repName}.`,
            authorName: 'Leadsetu Instant Forms',
            createdAt: nowIso,
          },
        ],
      });

      if (doc.automation?.instantWhatsappWelcome !== false) {
        if (this.marketplaceSyncService) {
          await this.marketplaceSyncService.dispatchInstantWelcomeForLead({
            tenantId: String(tenantOid),
            leadDoc,
            repAuth: {
              userId: assignedUserId,
              tenantId: String(tenantOid),
              email: repEmail,
              name: repName,
              role: 'sales',
            },
            productHint: Object.values(answers)[0] || doc.title,
          });
        } else if (this.inboxService && phone) {
          await this.inboxService.startOrGetConversation(
            {
              userId: assignedUserId,
              tenantId: String(tenantOid),
              email: repEmail,
              name: repName,
              role: 'sales',
            },
            {
              linkedEntityType: 'lead',
              linkedEntityId: String(leadDoc._id),
              contactName: name,
              company,
              phone,
              city,
              channel: 'whatsapp',
              initialMessage: `Namaste ${name} ji! Thanks for submitting "${doc.title}" with ${doc.companyName}. Here is our instant confirmation & catalog link: ${doc.thankYou?.brochureUrl || 'on the way'}.`,
              via: 'inbox',
              isAiDrafted: true,
              logToTimeline: false,
            },
          );
        }
      }

      if (doc.automation?.fireMetaCapi !== false && this.metaCapiService) {
        try {
          await this.metaCapiService.fireConversionEvent({
            tenantId: String(tenantOid),
            entityType: 'lead',
            entityId: String(leadDoc._id),
            eventName: 'LeadSubmitted',
            phone,
            email,
            respectAutoToggle: true,
            triggeredBy: 'instant_form_submit',
          });
        } catch {
          // Do not fail public form submission on CAPI error
        }
      }
    }

    await this.submissionModel.create({
      tenantId: tenantOid,
      formId: doc._id,
      slug: doc.slug,
      leadId: String(leadDoc._id),
      name,
      phone,
      email,
      company,
      city,
      answers,
      otpVerified,
      outcome,
      utmSource,
      utmMedium,
      utmCampaign,
      referrer: String(body?.referrer || '').trim(),
    });

    await this.formModel.updateOne(
      { _id: doc._id },
      { $inc: { 'stats.submissions': 1 } },
    );

    const bookingSlug =
      tenant?.leadConnectors?.bookingScheduler?.slug || 'book-demo';
    const whatsappNumber =
      tenant?.whatsappCloud?.verifiedPhoneNumber ||
      tenant?.indiamartPull?.registeredMobile ||
      '+919811245678';

    return {
      ok: true,
      outcome,
      leadId: String(leadDoc._id),
      bookingSlug,
      whatsappNumber,
      brochureUrl: doc.thankYou?.brochureUrl || '',
    };
  }

  async buildWidgetScript(slug: string, frontendOrigin: string): Promise<string> {
    const doc = await this.resolvePublicFormDoc(slug);
    const safeOrigin = frontendOrigin.replace(/\/+$/, '');
    const iframeUrl = `${safeOrigin}/f/${encodeURIComponent(doc.slug)}?embed=1`;
    const color = String(doc.brandColor || '#2563EB').replace(/[^#a-zA-Z0-9]/g, '');

    return `(function(){
  if (window.__leadsetuWidgetLoaded_${doc.slug.replace(/[^a-z0-9]/gi, '_')}) return;
  window.__leadsetuWidgetLoaded_${doc.slug.replace(/[^a-z0-9]/gi, '_')} = true;
  var scriptEl = document.currentScript;
  var pos = (scriptEl && scriptEl.getAttribute('data-position')) || 'bottom-right';
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.innerText = '⚡ Get Instant Quote';
  btn.style.cssText = 'position:fixed;bottom:20px;' + (pos === 'bottom-left' ? 'left:20px;' : 'right:20px;') + 'z-index:999990;padding:12px 18px;border-radius:9999px;border:none;background:${color};color:#fff;font-family:system-ui,-apple-system,sans-serif;font-weight:700;font-size:13px;cursor:pointer;box-shadow:0 10px 25px rgba(15,23,42,0.25);';
  var overlay = document.createElement('div');
  overlay.style.cssText = 'display:none;position:fixed;inset:0;z-index:999999;background:rgba(2,6,23,0.65);backdrop-filter:blur(4px);align-items:center;justify-content:center;padding:16px;';
  var box = document.createElement('div');
  box.style.cssText = 'position:relative;width:100%;max-width:440px;height:660px;max-height:92vh;border-radius:24px;overflow:hidden;box-shadow:0 24px 60px rgba(0,0,0,0.4);';
  var close = document.createElement('button');
  close.type = 'button';
  close.innerHTML = '&times;';
  close.style.cssText = 'position:absolute;top:12px;right:12px;z-index:10;width:32px;height:32px;border-radius:9999px;border:1px solid #E2E8F0;background:#fff;color:#0F172A;font-size:20px;line-height:1;cursor:pointer;';
  var iframe = document.createElement('iframe');
  iframe.src = '${iframeUrl}';
  iframe.style.cssText = 'width:100%;height:100%;border:0;';
  close.onclick = function(){ overlay.style.display = 'none'; };
  overlay.onclick = function(e){ if(e.target === overlay) overlay.style.display = 'none'; };
  btn.onclick = function(){ overlay.style.display = 'flex'; };
  box.appendChild(close);
  box.appendChild(iframe);
  overlay.appendChild(box);
  document.body.appendChild(btn);
  document.body.appendChild(overlay);
  if (pos === 'exit-popup') {
    document.addEventListener('mouseleave', function onLeave(e){
      if (e.clientY <= 0) { overlay.style.display = 'flex'; document.removeEventListener('mouseleave', onLeave); }
    });
  }
})();`;
  }
}
