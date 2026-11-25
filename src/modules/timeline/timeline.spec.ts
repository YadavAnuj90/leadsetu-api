import { Types } from 'mongoose';
import { TimelineService } from './timeline.service';

describe('TimelineService Customer 360 Unified Aggregator', () => {
  const tenantId = new Types.ObjectId();
  const contactId = new Types.ObjectId();
  const leadId = new Types.ObjectId();
  const dealId = new Types.ObjectId();

  const makeMockConnection = () => {
    const contactDoc = {
      _id: contactId,
      tenantId,
      name: 'Priya Malhotra',
      company: 'Malhotra Luxury Interiors',
      phone: '+91 98180 23451',
      normalizedPhone: '+919818023451',
      email: 'priya@malhotrainteriors.in',
      city: 'Gurugram',
      type: 'customer',
      activities: [
        {
          id: 'c-act-1',
          type: 'note',
          description: 'VIP dealer account onboarded with 30-day credit limit',
          authorName: 'Anuj',
          createdAt: '2026-11-20T10:00:00.000Z',
        },
      ],
    };

    const collections: Record<string, any[]> = {
      contacts: [contactDoc],
      leads: [
        {
          _id: leadId,
          tenantId,
          name: 'Priya Malhotra',
          company: 'Malhotra Luxury Interiors',
          phone: '09818023451',
          status: 'qualified',
          source: 'indiamart',
          activities: [
            {
              id: 'l-act-1',
              type: 'status_change',
              description: 'Qualified via SetuAI (Score 94)',
              authorName: 'SetuAI',
              createdAt: '2026-11-21T11:00:00.000Z',
            },
          ],
        },
      ],
      deals: [
        {
          _id: dealId,
          tenantId,
          title: 'Commercial Modular Office Order',
          stage: 'proposal',
          value: 450000,
          contactPhone: '+919818023451',
          activities: [
            {
              id: 'd-act-1',
              type: 'stage_change',
              description: 'Moved to Proposal Sent stage',
              authorName: 'Anuj',
              createdAt: '2026-11-22T12:00:00.000Z',
            },
          ],
        },
      ],
      conversations: [
        {
          _id: new Types.ObjectId(),
          tenantId,
          contactName: 'Priya Malhotra',
          phone: '+919818023451',
          messages: [
            {
              id: 'm-1',
              direction: 'inbound',
              content: 'Namaste, please share 18% GST proforma invoice',
              senderName: 'Priya Malhotra',
              status: 'read',
              createdAt: '2026-11-23T09:30:00.000Z',
            },
          ],
        },
      ],
      calls: [
        {
          _id: new Types.ObjectId(),
          tenantId,
          direction: 'outbound',
          outcome: 'Connected',
          aiSummary: 'Discussed Gurugram delivery schedule & 10% volume discount',
          agentName: 'Anuj',
          createdAt: '2026-11-23T14:00:00.000Z',
        },
      ],
      tasks: [
        {
          _id: new Types.ObjectId(),
          tenantId,
          title: 'Send revised GST Quotation PDF',
          status: 'pending',
          priority: 'high',
          createdAt: '2026-11-24T08:00:00.000Z',
        },
      ],
      tickets: [
        {
          _id: new Types.ObjectId(),
          tenantId,
          ticketNumber: 'SLA-101',
          subject: 'Priority dispatch confirmation',
          status: 'open',
          priority: 'urgent',
          createdAt: '2026-11-24T15:00:00.000Z',
        },
      ],
      invoices: [
        {
          _id: new Types.ObjectId(),
          tenantId,
          invoiceNumber: 'INV-2026-089',
          docType: 'tax_invoice',
          clientName: 'Malhotra Luxury Interiors',
          grandTotal: 531000,
          status: 'paid',
          createdAt: '2026-11-25T10:00:00.000Z',
        },
      ],
    };

    const db = {
      collection: jest.fn((name: string) => ({
        findOne: jest.fn(async () => (collections[name] || [])[0] || null),
        find: jest.fn(() => ({
          sort: () => ({
            limit: () => ({
              toArray: jest.fn(async () => collections[name] || []),
            }),
          }),
        })),
        updateOne: jest.fn(async () => ({ matchedCount: 1, modifiedCount: 1 })),
      })),
    };

    return { db } as any;
  };

  it('aggregates touchpoints across leads, contacts, deals, whatsapp, calls, tasks, tickets, and invoices into one chronological Customer 360 feed', async () => {
    const conn = makeMockConnection();
    const service = new TimelineService(
      conn,
      {} as any,
      { get: jest.fn().mockReturnValue('') } as any,
    );

    const res = await service.getCustomer360Timeline(
      { userId: String(new Types.ObjectId()), tenantId: String(tenantId) },
      'contact',
      String(contactId),
    );

    expect(res.customer.name).toBe('Priya Malhotra');
    expect(res.customer.normalizedPhone).toBe('+919818023451');
    expect(res.linkedEntities.leads).toHaveLength(1);
    expect(res.linkedEntities.contacts).toHaveLength(1);
    expect(res.linkedEntities.deals).toHaveLength(1);
    expect(res.summary.whatsappCount).toBe(1);
    expect(res.summary.callsCount).toBe(1);
    expect(res.summary.invoicesCount).toBe(1);
    expect(res.summary.tasksCount).toBe(1);
    expect(res.summary.ticketsCount).toBe(1);
    expect(res.summary.totalInvoicedInr).toBe(531000);
    expect(res.summary.totalPaidInr).toBe(531000);
    expect(res.events.length).toBeGreaterThanOrEqual(8);
    // Newest event first (the 2026-11-25 paid GST invoice)
    expect(res.events[0].category).toBe('invoices');
  });
});
