import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Connection, Types } from 'mongoose';

export type TimelineEntityType = 'lead' | 'contact' | 'deal';

export type TimelineEventCategory =
  | 'whatsapp'
  | 'calls'
  | 'invoices'
  | 'tasks'
  | 'tickets'
  | 'deals'
  | 'notes';

export interface Timeline360Event {
  id: string;
  category: TimelineEventCategory;
  sourceModule:
    | 'lead'
    | 'contact'
    | 'deal'
    | 'inbox'
    | 'calls'
    | 'invoices'
    | 'tasks'
    | 'tickets';
  title: string;
  description: string;
  actorName: string;
  badgeText?: string;
  amountInr?: number;
  linkHref?: string;
  occurredAt: string;
}

export interface Customer360TimelineResponse {
  entityType: TimelineEntityType;
  entityId: string;
  customer: {
    name: string;
    company: string;
    phone: string;
    normalizedPhone: string;
    email: string;
    city: string;
  };
  linkedEntities: {
    leads: Array<{ id: string; name: string; status: string; source: string }>;
    contacts: Array<{ id: string; name: string; company: string; type: string }>;
    deals: Array<{ id: string; title: string; stage: string; value: number }>;
  };
  summary: {
    totalEvents: number;
    whatsappCount: number;
    callsCount: number;
    invoicesCount: number;
    tasksCount: number;
    ticketsCount: number;
    notesCount: number;
    totalInvoicedInr: number;
    totalPaidInr: number;
  };
  events: Timeline360Event[];
}

function extractLast10PhoneDigits(raw?: string | null): string {
  const digits = String(raw || '').replace(/\D+/g, '');
  return digits.length >= 10 ? digits.slice(-10) : '';
}

@Injectable()
export class TimelineService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
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
        name?: string;
      }>(token, { secret });
      return {
        userId: payload.sub,
        tenantId: payload.tenantId,
        email: payload.email,
        name: payload.name || payload.email.split('@')[0],
      };
    } catch {
      throw new UnauthorizedException('Invalid or expired session.');
    }
  }

  private resolveCollectionName(entityType: TimelineEntityType): string {
    if (entityType === 'contact') return 'contacts';
    if (entityType === 'deal') return 'deals';
    return 'leads';
  }

  /**
   * Builds a unified Customer 360 Timeline aggregating touchpoints across:
   * leads, contacts, deals, conversations (WhatsApp), calls, tasks, tickets, and invoices.
   */
  async getCustomer360Timeline(
    auth: { userId: string; tenantId: string },
    entityType: TimelineEntityType,
    entityId: string,
    categoryFilter?: string,
  ): Promise<Customer360TimelineResponse> {
    if (!Types.ObjectId.isValid(entityId)) {
      throw new BadRequestException('Invalid record ID.');
    }
    const tenantOid = new Types.ObjectId(auth.tenantId);
    const recordOid = new Types.ObjectId(entityId);
    const db = this.connection.db;
    if (!db) {
      throw new NotFoundException('Database connection unavailable.');
    }

    const primaryCol = db.collection(this.resolveCollectionName(entityType));
    const rootDoc = await primaryCol.findOne({
      _id: recordOid,
      tenantId: tenantOid,
    });

    if (!rootDoc) {
      throw new NotFoundException(`${entityType} record not found.`);
    }

    const rawPhone = String(
      rootDoc.phone || rootDoc.contactPhone || rootDoc.normalizedPhone || '',
    ).trim();
    const last10 = extractLast10PhoneDigits(rawPhone);
    const normalizedPhone = last10 ? `+91${last10}` : '';
    const phoneRegex = last10
      ? new RegExp(`${last10.split('').join('\\D*')}\\D*$`)
      : null;

    const customerName = String(
      rootDoc.name || rootDoc.contactName || rootDoc.title || 'Customer',
    ).trim();
    const companyName = String(rootDoc.company || '').trim();
    const customerEmail = String(
      rootDoc.email || rootDoc.contactEmail || '',
    )
      .trim()
      .toLowerCase();
    const customerCity = String(rootDoc.city || 'Delhi-NCR').trim();

    // Build cross-collection matcher by phone, email, or explicit ID links
    const buildOrConditions = (
      phoneFields: string[],
      idFields: string[],
      emailFields: string[] = [],
    ) => {
      const orList: Record<string, unknown>[] = [];
      for (const idF of idFields) {
        if (idF === '_id') {
          orList.push({ _id: recordOid });
        } else {
          orList.push({ [idF]: entityId });
          orList.push({ [idF]: recordOid });
        }
      }
      if (normalizedPhone) {
        orList.push({ normalizedPhone });
      }
      if (phoneRegex) {
        for (const pf of phoneFields) {
          orList.push({ [pf]: { $regex: phoneRegex } });
        }
      }
      if (customerEmail) {
        for (const ef of emailFields) {
          orList.push({ [ef]: customerEmail });
        }
      }
      return orList;
    };

    const [
      matchedLeads,
      matchedContacts,
      matchedDeals,
      matchedConvs,
      matchedCalls,
      matchedTasks,
      matchedTickets,
      matchedInvoices,
    ] = await Promise.all([
      db
        .collection('leads')
        .find({
          tenantId: tenantOid,
          $or: buildOrConditions(
            ['phone'],
            entityType === 'lead' ? ['_id'] : ['convertedContactId'],
            ['email'],
          ),
        })
        .sort({ createdAt: -1 })
        .limit(10)
        .toArray(),
      db
        .collection('contacts')
        .find({
          tenantId: tenantOid,
          $or: buildOrConditions(
            ['phone'],
            entityType === 'contact' ? ['_id'] : [],
            ['email'],
          ),
        })
        .sort({ createdAt: -1 })
        .limit(10)
        .toArray(),
      db
        .collection('deals')
        .find({
          tenantId: tenantOid,
          $or: buildOrConditions(
            ['contactPhone'],
            entityType === 'deal' ? ['_id'] : ['leadId', 'contactId'],
            ['contactEmail'],
          ),
        })
        .sort({ createdAt: -1 })
        .limit(10)
        .toArray(),
      db
        .collection('conversations')
        .find({
          tenantId: tenantOid,
          $or: buildOrConditions(['phone'], ['linkedEntityId']),
        })
        .sort({ updatedAt: -1 })
        .limit(10)
        .toArray(),
      db
        .collection('calls')
        .find({
          tenantId: tenantOid,
          $or: buildOrConditions(['phone', 'customerPhone'], ['leadId', 'entityId']),
        })
        .sort({ createdAt: -1 })
        .limit(20)
        .toArray()
        .catch(() => []),
      db
        .collection('tasks')
        .find({
          tenantId: tenantOid,
          $or: [
            ...buildOrConditions(['relatedPhone'], ['relatedEntityId']),
            ...(customerName
              ? [{ relatedName: customerName }]
              : []),
          ],
        })
        .sort({ createdAt: -1 })
        .limit(20)
        .toArray()
        .catch(() => []),
      db
        .collection('tickets')
        .find({
          tenantId: tenantOid,
          $or: buildOrConditions(['phone'], ['linkedContactId']),
        })
        .sort({ createdAt: -1 })
        .limit(20)
        .toArray()
        .catch(() => []),
      db
        .collection('invoices')
        .find({
          tenantId: tenantOid,
          $or: [
            ...buildOrConditions(['phone'], ['linkedLeadId', 'linkedDealId'], ['email']),
            ...(companyName ? [{ clientName: companyName }] : []),
          ],
        })
        .sort({ createdAt: -1 })
        .limit(20)
        .toArray()
        .catch(() => []),
    ]);

    const events: Timeline360Event[] = [];
    const seenKeys = new Set<string>();

    const pushUniqueEvent = (ev: Timeline360Event) => {
      const dedupKey = `${ev.category}:${ev.description.slice(0, 80)}:${ev.occurredAt.slice(0, 16)}`;
      if (seenKeys.has(dedupKey)) return;
      seenKeys.add(dedupKey);
      events.push(ev);
    };

    // 1. Embedded activities on matched Leads
    for (const l of matchedLeads) {
      const acts = Array.isArray(l.activities) ? l.activities : [];
      for (const act of acts) {
        const type = String(act.type || 'note');
        const cat: TimelineEventCategory =
          type === 'whatsapp'
            ? 'whatsapp'
            : type === 'call'
              ? 'calls'
              : 'notes';
        pushUniqueEvent({
          id: String(act.id || `lead-act-${l._id}-${act.createdAt}`),
          category: cat,
          sourceModule: 'lead',
          title:
            type === 'whatsapp'
              ? 'WhatsApp Activity (Lead)'
              : type === 'call'
                ? 'Call Activity (Lead)'
                : type === 'status_change'
                  ? 'Lead Stage / Routing Update'
                  : 'Lead Note / Activity',
          description: String(act.description || ''),
          actorName: String(act.authorName || act.createdBy || 'CRM'),
          badgeText: `Lead: ${l.name}`,
          linkHref: `/leads/${String(l._id)}`,
          occurredAt: act.createdAt
            ? new Date(act.createdAt).toISOString()
            : new Date(l.createdAt || Date.now()).toISOString(),
        });
      }
    }

    // 2. Embedded activities on matched Contacts
    for (const c of matchedContacts) {
      const acts = Array.isArray(c.activities) ? c.activities : [];
      for (const act of acts) {
        const type = String(act.type || 'note');
        const cat: TimelineEventCategory =
          type === 'whatsapp'
            ? 'whatsapp'
            : type === 'call'
              ? 'calls'
              : 'notes';
        pushUniqueEvent({
          id: String(act.id || `contact-act-${c._id}-${act.createdAt}`),
          category: cat,
          sourceModule: 'contact',
          title:
            type === 'whatsapp'
              ? 'WhatsApp Interaction (Contact)'
              : type === 'call'
                ? 'Phone Call Log (Contact)'
                : 'Contact Timeline Note',
          description: String(act.description || ''),
          actorName: String(act.authorName || 'CRM'),
          badgeText: `Contact: ${c.name}`,
          linkHref: `/contacts/${String(c._id)}`,
          occurredAt: act.createdAt
            ? new Date(act.createdAt).toISOString()
            : new Date(c.createdAt || Date.now()).toISOString(),
        });
      }
    }

    // 3. Embedded activities on matched Deals
    for (const d of matchedDeals) {
      const acts = Array.isArray(d.activities) ? d.activities : [];
      for (const act of acts) {
        const type = String(act.type || 'note');
        const cat: TimelineEventCategory =
          type === 'whatsapp'
            ? 'whatsapp'
            : type === 'call'
              ? 'calls'
              : type === 'quote'
                ? 'invoices'
                : 'deals';
        pushUniqueEvent({
          id: String(act.id || `deal-act-${d._id}-${act.createdAt}`),
          category: cat,
          sourceModule: 'deal',
          title:
            type === 'stage_change'
              ? `Deal Stage Updated (${d.title})`
              : `Deal Activity (${d.title})`,
          description: String(act.description || ''),
          actorName: String(act.authorName || 'Sales Desk'),
          badgeText: `Deal · ₹${Number(d.value || 0).toLocaleString('en-IN')}`,
          amountInr: Number(d.value || 0),
          linkHref: `/deals/${String(d._id)}`,
          occurredAt: act.createdAt
            ? new Date(act.createdAt).toISOString()
            : new Date(d.createdAt || Date.now()).toISOString(),
        });
      }
    }

    // 4. WhatsApp Inbox Conversation Messages
    for (const conv of matchedConvs) {
      const msgs = Array.isArray(conv.messages) ? conv.messages.slice(-15) : [];
      for (const m of msgs) {
        const isInbound = m.direction === 'inbound';
        pushUniqueEvent({
          id: String(m.id || `wa-msg-${conv._id}-${m.createdAt}`),
          category: 'whatsapp',
          sourceModule: 'inbox',
          title: isInbound
            ? `Inbound WhatsApp from ${conv.contactName || customerName}`
            : `Outbound WhatsApp (${m.senderName || 'CRM'})`,
          description: String(m.content || ''),
          actorName: String(
            isInbound ? conv.contactName || customerName : m.senderName || 'WhatsApp Bot',
          ),
          badgeText: isInbound ? 'Buyer Reply' : `Status: ${String(m.status || 'sent').toUpperCase()}`,
          linkHref: '/inbox',
          occurredAt: m.createdAt
            ? new Date(m.createdAt).toISOString()
            : new Date(conv.updatedAt || Date.now()).toISOString(),
        });
      }
    }

    // 5. Call Logs & SetuAI Call Audits
    for (const call of matchedCalls) {
      pushUniqueEvent({
        id: String(call._id),
        category: 'calls',
        sourceModule: 'calls',
        title: `${String(call.direction || 'outbound').toUpperCase()} Call · ${call.outcome || call.status || 'Logged'}`,
        description: String(
          call.aiSummary ||
            call.notes ||
            call.summary ||
            `Duration: ${call.durationSeconds || call.duration || 0}s`,
        ),
        actorName: String(call.agentName || call.repName || 'Sales Rep'),
        badgeText: call.sentiment ? `Sentiment: ${call.sentiment}` : 'CRM Phone',
        linkHref: '/calls',
        occurredAt: call.createdAt
          ? new Date(call.createdAt).toISOString()
          : new Date().toISOString(),
      });
    }

    // 6. Follow-Up Tasks
    for (const t of matchedTasks) {
      pushUniqueEvent({
        id: String(t._id),
        category: 'tasks',
        sourceModule: 'tasks',
        title: `Task: ${t.title}`,
        description: String(t.description || `Due: ${t.dueDate || 'Today'}`),
        actorName: 'Task Engine',
        badgeText: `${String(t.status || 'pending').toUpperCase()} · ${String(t.priority || 'high').toUpperCase()}`,
        linkHref: '/tasks',
        occurredAt: t.createdAt
          ? new Date(t.createdAt).toISOString()
          : new Date().toISOString(),
      });
    }

    // 7. SLA Support Tickets
    for (const tk of matchedTickets) {
      pushUniqueEvent({
        id: String(tk._id),
        category: 'tickets',
        sourceModule: 'tickets',
        title: `SLA Ticket ${tk.ticketNumber || ''}: ${tk.subject}`,
        description: String(
          tk.resolutionSummary || tk.notes || `Category: ${tk.category}`,
        ),
        actorName: String(tk.assignedToName || 'Support Desk'),
        badgeText: `${String(tk.status || 'open').toUpperCase()} · ${String(tk.priority || 'high').toUpperCase()}`,
        linkHref: '/tickets',
        occurredAt: tk.createdAt
          ? new Date(tk.createdAt).toISOString()
          : new Date().toISOString(),
      });
    }

    // 8. GST Invoices & Proforma Quotations
    let totalInvoicedInr = 0;
    let totalPaidInr = 0;
    for (const inv of matchedInvoices) {
      const grandTotal = Number(inv.grandTotal || 0);
      const isQuote = inv.docType === 'proforma_quote';
      if (!isQuote && inv.status !== 'cancelled') {
        totalInvoicedInr += grandTotal;
        if (inv.status === 'paid') {
          totalPaidInr += grandTotal;
        } else if (inv.amountPaid) {
          totalPaidInr += Number(inv.amountPaid || 0);
        }
      }
      pushUniqueEvent({
        id: String(inv._id),
        category: 'invoices',
        sourceModule: 'invoices',
        title: `${isQuote ? 'Proforma Quotation' : 'GST Tax Invoice'} #${inv.invoiceNumber}`,
        description: `Client: ${inv.clientName} · Grand Total: ₹${grandTotal.toLocaleString('en-IN')} (${String(inv.status || 'draft').toUpperCase()})`,
        actorName: 'GST Billing Desk',
        badgeText: `${String(inv.status || 'draft').toUpperCase()} · ₹${grandTotal.toLocaleString('en-IN')}`,
        amountInr: grandTotal,
        linkHref: isQuote ? '/quotations' : '/invoices',
        occurredAt: inv.createdAt
          ? new Date(inv.createdAt).toISOString()
          : new Date().toISOString(),
      });
    }

    // Sort all events newest first
    events.sort(
      (a, b) =>
        new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime(),
    );

    const summary = {
      totalEvents: events.length,
      whatsappCount: events.filter((e) => e.category === 'whatsapp').length,
      callsCount: events.filter((e) => e.category === 'calls').length,
      invoicesCount: events.filter((e) => e.category === 'invoices').length,
      tasksCount: events.filter((e) => e.category === 'tasks').length,
      ticketsCount: events.filter((e) => e.category === 'tickets').length,
      notesCount: events.filter(
        (e) => e.category === 'notes' || e.category === 'deals',
      ).length,
      totalInvoicedInr,
      totalPaidInr,
    };

    const filteredEvents =
      categoryFilter && categoryFilter !== 'all'
        ? events.filter((e) =>
            categoryFilter === 'notes'
              ? e.category === 'notes' || e.category === 'deals'
              : e.category === categoryFilter,
          )
        : events;

    return {
      entityType,
      entityId,
      customer: {
        name: customerName,
        company: companyName,
        phone: rawPhone,
        normalizedPhone,
        email: customerEmail,
        city: customerCity,
      },
      linkedEntities: {
        leads: matchedLeads.map((l) => ({
          id: String(l._id),
          name: String(l.name || 'Lead'),
          status: String(l.status || 'new'),
          source: String(l.source || 'website'),
        })),
        contacts: matchedContacts.map((c) => ({
          id: String(c._id),
          name: String(c.name || 'Contact'),
          company: String(c.company || ''),
          type: String(c.type || 'customer'),
        })),
        deals: matchedDeals.map((d) => ({
          id: String(d._id),
          title: String(d.title || 'Deal'),
          stage: String(d.stage || 'qualified'),
          value: Number(d.value || 0),
        })),
      },
      summary,
      events: filteredEvents.slice(0, 80),
    };
  }

  /**
   * Appends a note/call/whatsapp activity directly onto the target Lead, Contact, or Deal
   * and returns the refreshed Customer 360 Timeline.
   */
  async addTimelineNote(
    auth: { userId: string; tenantId: string; name: string },
    entityType: TimelineEntityType,
    entityId: string,
    body: { type?: 'note' | 'call' | 'whatsapp'; description: string },
  ): Promise<Customer360TimelineResponse> {
    if (!Types.ObjectId.isValid(entityId)) {
      throw new BadRequestException('Invalid record ID.');
    }
    const text = String(body?.description || '').trim();
    if (!text) {
      throw new BadRequestException('Activity description is required.');
    }

    const db = this.connection.db;
    if (!db) throw new NotFoundException('Database unavailable.');

    const col = db.collection(this.resolveCollectionName(entityType));
    const nowIso = new Date().toISOString();
    const entry = {
      id: `act-360-${Date.now()}`,
      type: body.type || 'note',
      description: text,
      authorName: auth.name || 'Sales Desk',
      createdAt: nowIso,
    };

    const res = await col.updateOne(
      {
        _id: new Types.ObjectId(entityId),
        tenantId: new Types.ObjectId(auth.tenantId),
      },
      {
        $push: {
          activities: {
            $each: [entry],
            $position: 0,
          },
        } as never,
      },
    );

    if (res.matchedCount === 0) {
      throw new NotFoundException(`${entityType} record not found.`);
    }

    return this.getCustomer360Timeline(auth, entityType, entityId);
  }
}
