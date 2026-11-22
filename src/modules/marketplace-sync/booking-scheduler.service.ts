import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { randomBytes } from 'crypto';
import { Tenant, TenantDocument } from '../auth/schemas/tenant.schema';
import { User, UserDocument } from '../auth/schemas/user.schema';
import { Lead, LeadDocument } from '../leads/schemas/lead.schema';
import {
  BookingAppointment,
  BookingAppointmentDocument,
  BookingAppointmentStatus,
} from './schemas/booking-appointment.schema';
import { normalizeIndianPhone } from '../auth/identity.util';
import { AuditService } from '../audit/audit.module';
import { LeadRoutingService } from '../lead-routing/lead-routing.service';
import { InboxService } from '../inbox/inbox.service';
import type { CreatePublicBookingDto } from './dto/marketplace-sync.dto';

function last10(raw?: string): string {
  const digits = String(raw || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

function buildPhoneSuffixRegex(phone10: string): string {
  return `${phone10.split('').join('\\D*')}\\D*$`;
}

function parseHmToMinutes(hm: string, fallback: number): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || '').trim());
  if (!m) return fallback;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return fallback;
  return h * 60 + min;
}

function formatMinutesLabel(totalMins: number): { time24: string; label12: string } {
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  const time24 = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const label12 = `${String(h12).padStart(2, '0')}:${String(m).padStart(2, '0')} ${ampm}`;
  return { time24, label12 };
}

function getIstDateYmd(date = new Date()): string {
  const istMs = date.getTime() + 5.5 * 3600_000;
  return new Date(istMs).toISOString().slice(0, 10);
}

function toIstSlotIso(dateYmd: string, time24: string): Date {
  const cleanTime = /^\d{2}:\d{2}$/.test(time24) ? time24 : '10:00';
  return new Date(`${dateYmd}T${cleanTime}:00+05:30`);
}

function formatIcsUtc(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

export function sanitizeBookingSlug(raw: string, fallbackPrefix = 'demo'): string {
  const clean = String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return clean || `${fallbackPrefix}-${randomBytes(3).toString('hex')}`;
}

export function buildDefaultBookingScheduler(tenantName: string, accountId?: string) {
  return {
    enabled: true,
    slug: sanitizeBookingSlug(`${tenantName || 'leadsetu'}-${accountId || 'book'}`),
    title: 'Book a Live Product Demo & GST Quotation Call',
    subtitle: `Pick a convenient slot with ${tenantName || 'our team'} for instant pricing, catalog walkthrough & WhatsApp confirmation.`,
    durationMinutes: 30,
    bufferMinutes: 0,
    workingDays: [1, 2, 3, 4, 5, 6],
    startHour: '10:00',
    endHour: '19:00',
    meetingType: 'video_call' as const,
    confirmationWhatsappEnabled: true,
    reminder1HrEnabled: true,
    totalBookingsCount: 0,
  };
}

@Injectable()
export class BookingSchedulerService {
  constructor(
    @InjectModel(BookingAppointment.name)
    private readonly bookingModel: Model<BookingAppointmentDocument>,
    @InjectModel(Tenant.name)
    private readonly tenantModel: Model<TenantDocument>,
    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>,
    @InjectModel(Lead.name)
    private readonly leadModel: Model<LeadDocument>,
    @Optional() private readonly auditService?: AuditService,
    @Optional() private readonly leadRoutingService?: LeadRoutingService,
    @Optional() private readonly inboxService?: InboxService,
  ) {}

  private async resolveTenantBySlug(slug: string) {
    const cleanSlug = sanitizeBookingSlug(slug, '');
    if (!cleanSlug) throw new NotFoundException('Booking calendar not found.');
    const tenant = await this.tenantModel
      .findOne({ 'leadConnectors.bookingScheduler.slug': cleanSlug })
      .lean();
    if (!tenant) {
      throw new NotFoundException('Booking calendar link not found or inactive.');
    }
    const defaults = buildDefaultBookingScheduler(
      tenant.companyName || tenant.name,
      tenant.accountId,
    );
    const cfg = {
      ...defaults,
      ...(tenant.leadConnectors?.bookingScheduler || {}),
      slug: cleanSlug,
    };
    if (cfg.enabled === false) {
      throw new NotFoundException('This booking calendar is currently paused by the business.');
    }
    return { tenant, cfg };
  }

  async getPublicSchedulerInfo(slug: string, dateYmdRaw?: string) {
    const { tenant, cfg } = await this.resolveTenantBySlug(slug);
    const dateYmd =
      /^\d{4}-\d{2}-\d{2}$/.test(String(dateYmdRaw || '').trim())
        ? String(dateYmdRaw).trim()
        : getIstDateYmd();

    const dayDate = toIstSlotIso(dateYmd, '12:00');
    const dayOfWeek = dayDate.getUTCDay(); // 0=Sun..6=Sat
    const workingDays =
      Array.isArray(cfg.workingDays) && cfg.workingDays.length > 0
        ? cfg.workingDays
        : [1, 2, 3, 4, 5, 6];

    const startMins = parseHmToMinutes(cfg.startHour || '10:00', 600);
    const endMins = parseHmToMinutes(cfg.endHour || '19:00', 1140);
    const duration = Math.max(15, Math.min(120, Number(cfg.durationMinutes || 30)));
    const buffer = Math.max(0, Math.min(30, Number(cfg.bufferMinutes || 0)));
    const step = duration + buffer;

    const existing = await this.bookingModel
      .find({
        tenantId: tenant._id,
        dateYmd,
        status: { $in: ['confirmed', 'completed'] },
      })
      .select('slotStartIso')
      .lean();
    const takenStarts = new Set(existing.map((b) => b.slotStartIso));

    const slots: Array<{
      time24: string;
      label: string;
      slotStartIso: string;
      slotEndIso: string;
      available: boolean;
    }> = [];

    const nowMs = Date.now() + 5 * 60_000; // at least 5 mins ahead
    if (workingDays.includes(dayOfWeek)) {
      for (let m = startMins; m + duration <= endMins; m += step) {
        const { time24, label12 } = formatMinutesLabel(m);
        const startDt = toIstSlotIso(dateYmd, time24);
        const endDt = new Date(startDt.getTime() + duration * 60_000);
        const slotStartIso = startDt.toISOString();
        const isAvailable =
          startDt.getTime() > nowMs && !takenStarts.has(slotStartIso);
        slots.push({
          time24,
          label: label12,
          slotStartIso,
          slotEndIso: endDt.toISOString(),
          available: isAvailable,
        });
      }
    }

    return {
      slug: cfg.slug,
      companyName: String(tenant.companyName || tenant.name || 'Leadsetu Business').trim(),
      logoUrl: tenant.logoUrl || '',
      city: tenant.city || 'India',
      title: cfg.title,
      subtitle: cfg.subtitle,
      durationMinutes: duration,
      meetingType: cfg.meetingType || 'video_call',
      workingDays,
      startHour: cfg.startHour || '10:00',
      endHour: cfg.endHour || '19:00',
      dateYmd,
      slots,
    };
  }

  async createPublicBooking(slug: string, dto: CreatePublicBookingDto) {
    const { tenant, cfg } = await this.resolveTenantBySlug(slug);
    const tenantIdStr = String(tenant._id);
    const guestName = String(dto.guestName || '').trim();
    const guestPhoneRaw = String(dto.guestPhone || '').trim();
    const guestPhone = normalizeIndianPhone(guestPhoneRaw) || guestPhoneRaw;
    const guestEmail = String(dto.guestEmail || '').trim().toLowerCase();
    const guestCompany = String(dto.guestCompany || '').trim();
    const topic =
      String(dto.topic || '').trim() ||
      'Product Demo & Quotation Consultation';
    const dateYmd = String(dto.dateYmd || '').trim();
    const time24 = String(dto.slotTime24 || '').trim();

    if (!guestName || !guestPhone) {
      throw new BadRequestException('Full name and WhatsApp mobile number are required.');
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateYmd) || !/^\d{2}:\d{2}$/.test(time24)) {
      throw new BadRequestException('Valid booking date and time slot are required.');
    }

    const duration = Math.max(15, Math.min(120, Number(cfg.durationMinutes || 30)));
    const startDt = toIstSlotIso(dateYmd, time24);
    if (Number.isNaN(startDt.getTime()) || startDt.getTime() <= Date.now()) {
      throw new BadRequestException('Selected booking slot is in the past.');
    }
    const endDt = new Date(startDt.getTime() + duration * 60_000);
    const slotStartIso = startDt.toISOString();
    const slotEndIso = endDt.toISOString();
    const mins =
      Number(time24.slice(0, 2)) * 60 + Number(time24.slice(3, 5));
    const { label12 } = formatMinutesLabel(mins);

    const conflict = await this.bookingModel
      .findOne({
        tenantId: tenant._id,
        dateYmd,
        slotStartIso,
        status: { $in: ['confirmed', 'completed'] },
      })
      .lean();
    if (conflict) {
      throw new ConflictException(
        'This time slot was just reserved. Please select another available slot.',
      );
    }

    // Resolve round-robin/territory assignee
    const fallbackOwner = await this.userModel
      .findOne({ tenantId: tenant._id, isActive: { $ne: false } })
      .sort({ _id: 1 })
      .lean();
    let assignedUserId = fallbackOwner ? String(fallbackOwner._id) : '';
    let assignedRepName = fallbackOwner?.name || 'Sales Specialist';
    let assignedRepEmail = fallbackOwner?.email || 'team@leadsetu.in';

    if (this.leadRoutingService) {
      try {
        const routed = await this.leadRoutingService.resolveAssigneeForLead(
          tenantIdStr,
          {
            city: tenant.city || 'Delhi-NCR',
            source: 'website',
            estimatedValue: 0,
            leadName: guestName,
            commit: true,
          },
        );
        assignedUserId = routed.assignedUserId || assignedUserId;
        assignedRepName = routed.assignedUserName || assignedRepName;
        assignedRepEmail = routed.assignedUserEmail || assignedRepEmail;
      } catch {
        // Fallback to active owner
      }
    }

    // Create or match existing Lead
    const phone10 = last10(guestPhone);
    const dupOr: Array<Record<string, unknown>> = [];
    if (phone10.length === 10) {
      dupOr.push({ phone: { $regex: buildPhoneSuffixRegex(phone10) } });
    }
    if (guestEmail) dupOr.push({ email: guestEmail });

    let leadDoc =
      dupOr.length > 0
        ? await this.leadModel
            .findOne({ tenantId: tenant._id, $or: dupOr })
            .sort({ updatedAt: -1 })
        : null;

    const nowIso = new Date().toISOString();
    if (leadDoc) {
      leadDoc.activities.unshift({
        id: randomBytes(6).toString('hex'),
        type: 'note',
        description: `Booked ${duration}m consultation on ${dateYmd} at ${label12} (${topic}) via Booking Scheduler.`,
        authorName: 'Leadsetu Booking Scheduler',
        createdAt: nowIso,
      });
      await leadDoc.save();
    } else if (Types.ObjectId.isValid(assignedUserId)) {
      leadDoc = await this.leadModel.create({
        tenantId: tenant._id,
        ownerId: new Types.ObjectId(assignedUserId),
        name: guestName,
        accountKind: guestCompany ? 'business' : 'consumer',
        company: guestCompany,
        phone: guestPhone,
        email: guestEmail,
        city: tenant.city || 'India',
        source: 'website',
        status: 'qualified',
        tags: ['Booking Scheduler', 'High Intent'],
        notes: `Booked ${duration}m slot on ${dateYmd} at ${label12} IST. Topic: ${topic}`,
        aiScore: 88,
        aiLabel: 'Hot',
        aiInsight: `Self-booked ${duration}m appointment for ${dateYmd} ${label12} IST via public scheduler.`,
        aiNextAction: `Conduct ${cfg.meetingType === 'phone_call' ? 'phone' : 'video'} call at ${label12} on ${dateYmd}.`,
        aiScoredAt: nowIso,
        activities: [
          {
            id: randomBytes(6).toString('hex'),
            type: 'created',
            description: `Self-booked ${duration}m appointment for ${dateYmd} at ${label12} IST -> Assigned to ${assignedRepName}.`,
            authorName: 'Leadsetu Booking Scheduler',
            createdAt: nowIso,
          },
        ],
      });
    }

    // Create Task inside tasks collection
    let createdTaskId = '';
    if (Types.ObjectId.isValid(assignedUserId)) {
      const taskRes = await this.leadModel.db.collection('tasks').insertOne({
        tenantId: tenant._id,
        ownerId: new Types.ObjectId(assignedUserId),
        title: `Demo / Appointment: ${guestName} (${label12} IST)`,
        description: `${topic}${guestCompany ? ` · ${guestCompany}` : ''} · Auto-booked via /book/${cfg.slug}`,
        priority: 'high',
        status: 'pending',
        category: 'meeting',
        dueDate: dateYmd,
        relatedName: guestName,
        relatedCompany: guestCompany,
        relatedPhone: guestPhone,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      createdTaskId = String(taskRes.insertedId);
    }

    const bookingRef = `BK-${dateYmd.replace(/-/g, '').slice(2)}-${randomBytes(2).toString('hex').toUpperCase()}`;
    let confirmationSent = false;
    const companyName = String(
      tenant.companyName || tenant.name || 'Leadsetu Partner',
    ).trim();

    if (
      cfg.confirmationWhatsappEnabled !== false &&
      this.inboxService &&
      leadDoc &&
      Types.ObjectId.isValid(assignedUserId)
    ) {
      const modeLabel =
        cfg.meetingType === 'phone_call'
          ? 'Phone Consultation'
          : cfg.meetingType === 'in_person'
            ? 'In-Person Meeting'
            : 'Video Demo Call';
      const msg = `Namaste ${guestName} ji! Your *${modeLabel}* with *${companyName}* (${assignedRepName}) is confirmed:\n\n• Ref: *${bookingRef}*\n• Date: *${dateYmd}*\n• Time: *${label12} IST* (${duration} mins)\n• Topic: ${topic}\n\nWe will remind you 1 hour before the call. Reply here anytime to reschedule!`;
      try {
        const waRes = await this.inboxService.dispatchAutomatedWhatsApp({
          tenantId: tenantIdStr,
          userId: assignedUserId,
          actorName: 'Leadsetu Booking Scheduler',
          linkedEntityType: 'lead',
          linkedEntityId: String(leadDoc._id),
          contactName: guestName,
          company: guestCompany || companyName,
          phone: guestPhone,
          city: tenant.city || 'India',
          messageBody: msg,
          sendMode: 'text',
          timelineMarker: `Booking Confirmed (${bookingRef}) for ${dateYmd} ${label12} IST`,
        });
        confirmationSent = !waRes.skippedDnd && waRes.status !== 'failed';
      } catch {
        confirmationSent = false;
      }
    }

    const appointment = await this.bookingModel.create({
      tenantId: tenant._id,
      slug: cfg.slug,
      bookingRef,
      assignedRepId: Types.ObjectId.isValid(assignedUserId)
        ? new Types.ObjectId(assignedUserId)
        : undefined,
      assignedRepName,
      leadId: leadDoc?._id,
      taskId: createdTaskId,
      guestName,
      guestPhone,
      guestEmail,
      guestCompany,
      topic,
      dateYmd,
      slotLabel: label12,
      slotStartIso,
      slotEndIso,
      meetingType: cfg.meetingType || 'video_call',
      status: 'confirmed',
      confirmationSent,
      reminder1HrSent: false,
      noShowNudgeSent: false,
    });

    await this.tenantModel.updateOne(
      { _id: tenant._id },
      {
        $inc: { 'leadConnectors.bookingScheduler.totalBookingsCount': 1 },
      },
    );

    await this.auditService?.record({
      tenantId: tenantIdStr,
      actorId: assignedUserId || tenantIdStr,
      actorName: 'Booking Scheduler',
      actorEmail: assignedRepEmail,
      action: 'booking.appointment_created',
      entityType: 'lead',
      entityId: String(leadDoc?._id || appointment._id),
      entityLabel: `${bookingRef} · ${guestName}`,
      summary: `Booked ${duration}m slot on ${dateYmd} ${label12} IST with ${guestName} -> Assigned to ${assignedRepName}`,
    });

    const icsContent = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Leadsetu CRM//Booking Scheduler//EN',
      'BEGIN:VEVENT',
      `UID:${bookingRef}@leadsetu.in`,
      `DTSTAMP:${formatIcsUtc(new Date())}`,
      `DTSTART:${formatIcsUtc(startDt)}`,
      `DTEND:${formatIcsUtc(endDt)}`,
      `SUMMARY:${companyName} — ${cfg.title}`,
      `DESCRIPTION:Ref ${bookingRef} | Topic: ${topic} | Specialist: ${assignedRepName}`,
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');

    return {
      id: String(appointment._id),
      bookingRef,
      companyName,
      assignedRepName,
      dateYmd,
      slotLabel: label12,
      slotStartIso,
      slotEndIso,
      durationMinutes: duration,
      meetingType: appointment.meetingType,
      confirmationSent,
      leadId: leadDoc ? String(leadDoc._id) : '',
      taskId: createdTaskId,
      icsContent,
    };
  }

  async listTenantBookings(tenantId: string) {
    const rows = await this.bookingModel
      .find({ tenantId: new Types.ObjectId(tenantId) })
      .sort({ slotStartIso: -1 })
      .limit(30)
      .lean();
    return rows.map((b) => ({
      id: String(b._id),
      bookingRef: b.bookingRef,
      slug: b.slug,
      guestName: b.guestName,
      guestPhone: b.guestPhone,
      guestEmail: b.guestEmail,
      guestCompany: b.guestCompany,
      topic: b.topic,
      dateYmd: b.dateYmd,
      slotLabel: b.slotLabel,
      slotStartIso: b.slotStartIso,
      slotEndIso: b.slotEndIso,
      assignedRepName: b.assignedRepName,
      meetingType: b.meetingType,
      status: b.status,
      confirmationSent: Boolean(b.confirmationSent),
      reminder1HrSent: Boolean(b.reminder1HrSent),
      noShowNudgeSent: Boolean(b.noShowNudgeSent),
      leadId: b.leadId ? String(b.leadId) : '',
    }));
  }

  async updateBookingStatus(
    tenantId: string,
    actorId: string,
    bookingId: string,
    status: BookingAppointmentStatus,
    sendRecoveryWhatsApp = true,
  ) {
    if (!Types.ObjectId.isValid(bookingId)) {
      throw new BadRequestException('Invalid booking ID.');
    }
    const booking = await this.bookingModel.findOne({
      _id: new Types.ObjectId(bookingId),
      tenantId: new Types.ObjectId(tenantId),
    });
    if (!booking) throw new NotFoundException('Appointment not found.');

    booking.status = status;
    let nudgeSent = false;

    if (
      status === 'no_show' &&
      sendRecoveryWhatsApp &&
      this.inboxService &&
      booking.leadId
    ) {
      const tenant = await this.tenantModel.findById(booking.tenantId).lean();
      const companyName = String(
        tenant?.companyName || tenant?.name || 'our team',
      ).trim();
      const msg = `Namaste ${booking.guestName} ji! Looks like we missed connecting at ${booking.slotLabel} IST today (${booking.bookingRef}). No worries — pick another slot in 1 click at our ${companyName} calendar (/book/${booking.slug}) or reply with a convenient time!`;
      try {
        const res = await this.inboxService.dispatchAutomatedWhatsApp({
          tenantId,
          userId: String(booking.assignedRepId || actorId),
          actorName: 'No-Show Recovery Bot',
          linkedEntityType: 'lead',
          linkedEntityId: String(booking.leadId),
          contactName: booking.guestName,
          company: booking.guestCompany || companyName,
          phone: booking.guestPhone,
          messageBody: msg,
          sendMode: 'text',
          timelineMarker: `No-Show WhatsApp Recovery sent for ${booking.bookingRef}`,
        });
        nudgeSent = !res.skippedDnd && res.status !== 'failed';
        if (nudgeSent) booking.noShowNudgeSent = true;
      } catch {
        nudgeSent = false;
      }
    }

    await booking.save();
    return {
      id: String(booking._id),
      bookingRef: booking.bookingRef,
      status: booking.status,
      nudgeSent,
    };
  }

  /** Called every 60s by MarketplaceSyncService to send 1-hour WhatsApp reminders. */
  async processDueOneHourReminders() {
    if (!this.inboxService) return;
    const now = Date.now();
    const minIso = new Date(now + 5 * 60_000).toISOString();
    const maxIso = new Date(now + 65 * 60_000).toISOString();

    const due = await this.bookingModel
      .find({
        status: 'confirmed',
        reminder1HrSent: false,
        slotStartIso: { $gte: minIso, $lte: maxIso },
      })
      .limit(20)
      .exec();

    for (const appt of due) {
      const lock = await this.bookingModel.updateOne(
        { _id: appt._id, reminder1HrSent: false },
        { $set: { reminder1HrSent: true } },
      );
      if (lock.modifiedCount === 0) continue;

      const tenant = await this.tenantModel.findById(appt.tenantId).lean();
      if (tenant?.leadConnectors?.bookingScheduler?.reminder1HrEnabled === false) {
        continue;
      }
      if (!appt.leadId || !appt.assignedRepId) continue;

      const companyName = String(
        tenant?.companyName || tenant?.name || 'Leadsetu Partner',
      ).trim();
      const msg = `Reminder: Namaste ${appt.guestName} ji! Your *${companyName}* call with ${appt.assignedRepName} starts shortly at *${appt.slotLabel} IST* (Ref: ${appt.bookingRef}). Reply if you need to reschedule.`;
      try {
        await this.inboxService.dispatchAutomatedWhatsApp({
          tenantId: String(appt.tenantId),
          userId: String(appt.assignedRepId),
          actorName: '1-Hr Appointment Reminder',
          linkedEntityType: 'lead',
          linkedEntityId: String(appt.leadId),
          contactName: appt.guestName,
          company: appt.guestCompany || companyName,
          phone: appt.guestPhone,
          messageBody: msg,
          sendMode: 'text',
          timelineMarker: `1-Hr WhatsApp Reminder sent for ${appt.bookingRef}`,
        });
      } catch {
        // Ignore single notification error cleanly
      }
    }
  }
}
