import {
  Injectable,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Connection, Types } from 'mongoose';
import { AuditService } from '../audit/audit.service';
import { maskPhoneNumber, resolveOwnerScopeFilter } from '../auth/identity.util';
import {
  computeCommissionBreakdown,
  normalizeCommissionPolicy,
} from '../team/commission.util';
import { AnalyticsAuthContext } from './dto/analytics.dto';

@Injectable()
export class AnalyticsService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    @Optional() private readonly auditService?: AuditService,
  ) {}

  async verifyAuth(authHeader?: string): Promise<AnalyticsAuthContext> {
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

  async getOverview(
    auth: { userId?: string; tenantId: string },
    range: string = 'all',
  ) {
    const tenantId = new Types.ObjectId(auth.tenantId);
    const db = this.connection.db;
    if (!db) {
      throw new UnauthorizedException('Database connection not ready.');
    }
    const ownerScope = await resolveOwnerScopeFilter(db, auth);
    const isScopedNonAdmin = Object.keys(ownerScope).length > 0;
    const scopedFilter = { tenantId, ...ownerScope };
    const usersFilter =
      isScopedNonAdmin && auth.userId && Types.ObjectId.isValid(auth.userId)
        ? { _id: new Types.ObjectId(auth.userId), tenantId, isActive: { $ne: false } }
        : { tenantId, isActive: { $ne: false } };

    const now = Date.now();
    const daysMap: Record<string, number> = {
      '7d': 7,
      '30d': 30,
      '90d': 90,
    };
    const cutoffDate = daysMap[range]
      ? new Date(now - daysMap[range] * 24 * 60 * 60 * 1000)
      : null;

    const callFilter =
      isScopedNonAdmin && auth.userId && Types.ObjectId.isValid(auth.userId)
        ? { tenantId, callerId: new Types.ObjectId(auth.userId) }
        : { tenantId };

    const [
      rawLeads,
      rawDeals,
      rawInvoices,
      contacts,
      tasks,
      campaigns,
      workflows,
      users,
      tickets,
      productsCount,
      tenantDoc,
      rawCallLogs,
    ] = await Promise.all([
      db.collection('leads').find(scopedFilter).toArray(),
      db.collection('deals').find(scopedFilter).toArray(),
      db.collection('invoices').find(scopedFilter).toArray(),
      db.collection('contacts').find(scopedFilter).toArray(),
      db.collection('tasks').find(scopedFilter).toArray(),
      db.collection('campaigns').find(scopedFilter).toArray(),
      db.collection('workflows').find(scopedFilter).toArray(),
      db.collection('users').find(usersFilter).toArray(),
      db.collection('tickets').find(scopedFilter).toArray(),
      db.collection('products').countDocuments(scopedFilter),
      db.collection('tenants').findOne({ _id: tenantId }),
      db.collection('call_logs').find(callFilter).toArray(),
    ]);

    const commissionPolicy = normalizeCommissionPolicy(
      tenantDoc?.commissionPolicy,
    );

    const inRange = (doc: Record<string, unknown>) => {
      if (!cutoffDate) return true;
      const dt = doc.createdAt ? new Date(String(doc.createdAt)) : null;
      return !dt || Number.isNaN(dt.getTime()) || dt >= cutoffDate;
    };

    const leads = rawLeads.filter(inRange);
    const deals = rawDeals.filter(inRange);
    const invoices = rawInvoices.filter(inRange);
    const usersCount = users.length;

    // 1. Leads Aggregation
    const totalLeads = leads.length;
    const hotLeads = leads.filter(
      (l) => l.aiLabel === 'Hot' || Number(l.aiScore) >= 80,
    ).length;
    const qualifiedLeads = leads.filter((l) =>
      ['qualified', 'proposal', 'converted'].includes(String(l.status)),
    ).length;
    const convertedLeads = leads.filter(
      (l) => l.status === 'converted',
    ).length;
    const leadPipelineValue = leads.reduce(
      (s, l) => s + (Number(l.estimatedValue) || 0),
      0,
    );
    const avgAiScore =
      totalLeads > 0
        ? Math.round(
            leads.reduce((s, l) => s + (Number(l.aiScore) || 0), 0) /
              totalLeads,
          )
        : 0;

    // 2. Deals Aggregation
    const totalDeals = deals.length;
    const openDeals = deals.filter(
      (d) => d.stage !== 'won' && d.stage !== 'lost',
    );
    const wonDeals = deals.filter((d) => d.stage === 'won');
    const openDealsValue = openDeals.reduce(
      (s, d) => s + (Number(d.value) || 0),
      0,
    );
    const weightedForecast = openDeals.reduce(
      (s, d) =>
        s +
        Math.round(
          ((Number(d.value) || 0) * (Number(d.probability) || 50)) / 100,
        ),
      0,
    );
    const wonRevenue = wonDeals.reduce(
      (s, d) => s + (Number(d.value) || 0),
      0,
    );

    // 3. GST Invoices Aggregation (Accounts Receivable Ledger aware: Paid + TDS vs Balance Due)
    const activeInvoices = invoices.filter((i) => i.status !== 'cancelled');
    const getInvoiceSettlement = (inv: Record<string, unknown>) => {
      const grand = Math.max(0, Number(inv.grandTotal) || 0);
      const explicitSettled =
        Math.max(0, Number(inv.amountPaid) || 0) +
        Math.max(0, Number(inv.tdsDeducted) || 0);
      const settled =
        inv.status === 'paid' && explicitSettled === 0
          ? grand
          : Math.min(grand, explicitSettled);
      const balance = Math.max(0, grand - settled);
      return { grand, settled, balance };
    };
    const totalInvoiced = activeInvoices.reduce(
      (s, i) => s + (Number(i.grandTotal) || 0),
      0,
    );
    const paidInvoicesRevenue = activeInvoices.reduce(
      (s, i) => s + getInvoiceSettlement(i).settled,
      0,
    );
    const pendingReceivables = activeInvoices.reduce(
      (s, i) => s + getInvoiceSettlement(i).balance,
      0,
    );
    const gstOutputTax = activeInvoices.reduce(
      (s, i) => s + (Number(i.gstAmount) || 0),
      0,
    );

    // 4. Contacts, Tasks, Campaigns, Workflows
    const totalContacts = contacts.length;
    const gstVerifiedContacts = contacts.filter(
      (c) => c.gstin && String(c.gstin).trim().length > 0,
    ).length;
    const totalLtv = contacts.reduce(
      (s, c) => s + (Number(c.lifetimeValue) || 0),
      0,
    );

    const pendingTasksCount = tasks.filter((t) => t.status !== 'done').length;
    const completedTasksCount = tasks.filter((t) => t.status === 'done').length;

    const campaignsSentMessages = campaigns.reduce(
      (s, c) => s + (Number(c.sentCount) || 0),
      0,
    );
    const campaignsAttributedRevenue = campaigns.reduce(
      (s, c) => s + (Number(c.attributedRevenue) || 0),
      0,
    );

    const activeWorkflowsCount = workflows.filter((w) => w.active).length;
    const totalWorkflowRuns = workflows.reduce(
      (s, w) => s + (Number(w.runsCount) || 0),
      0,
    );
    const hoursSaved = workflows.reduce(
      (s, w) => s + (Number(w.hoursSaved) || 0),
      0,
    );

    // 5. Source Attribution Breakdown
    const sourceMeta: {
      key: string;
      label: string;
      color: string;
    }[] = [
      {
        key: 'whatsapp',
        label: 'WhatsApp Business Cloud',
        color: '#10B981',
      },
      {
        key: 'indiamart',
        label: 'IndiaMART B2B Leads',
        color: '#3978EA',
      },
      {
        key: 'meta_ads',
        label: 'Meta (FB & Instagram) Lead Ads',
        color: '#8B5CF6',
      },
      {
        key: 'website',
        label: 'Website, Google Ads & Referrals',
        color: '#F59E0B',
      },
    ];

    const sourceBreakdown = sourceMeta.map((meta) => {
      const matching = leads.filter((l) => {
        const src = String(l.source || 'whatsapp');
        if (meta.key === 'website') {
          return ['website', 'google_ads', 'referral', 'justdial', 'manual'].includes(
            src,
          );
        }
        return src === meta.key;
      });
      const count = matching.length;
      const sharePct =
        totalLeads > 0 ? Math.round((count / totalLeads) * 100) : 0;
      const pipelineValue = matching.reduce(
        (s, l) => s + (Number(l.estimatedValue) || 0),
        0,
      );
      const won = matching.filter((l) =>
        ['qualified', 'converted'].includes(String(l.status)),
      ).length;
      const winRatePct = count > 0 ? Math.round((won / count) * 100) : 0;

      return {
        key: meta.key,
        label: meta.label,
        color: meta.color,
        count,
        sharePct,
        pipelineValue,
        winRatePct,
      };
    });

    // 6. Delhi-NCR & Regional City Breakdown
    const cityBuckets = [
      {
        label: 'Noida Electronic City & Greater Noida (UP)',
        regex: /noida/i,
      },
      {
        label: 'New Delhi (Connaught Place, Okhla, Karol Bagh)',
        regex: /delhi|okhla|karol/i,
      },
      {
        label: 'Gurugram (Cyber City, Udyog Vihar, Manesar)',
        regex: /gurugram|gurgaon|manesar/i,
      },
      {
        label: 'Faridabad, Ghaziabad & Rest of India',
        regex: /.*/,
      },
    ];

    const matchedIds = new Set<string>();
    const cityBreakdown = cityBuckets.map((bucket, idx) => {
      const matchingLeads = leads.filter((l) => {
        const idStr = String(l._id);
        if (matchedIds.has(idStr)) return false;
        const cityStr = String(l.city || '');
        if (idx === cityBuckets.length - 1 || bucket.regex.test(cityStr)) {
          matchedIds.add(idStr);
          return true;
        }
        return false;
      });

      const count = matchingLeads.length;
      const value = matchingLeads.reduce(
        (s, l) => s + (Number(l.estimatedValue) || 0),
        0,
      );
      const sharePct =
        totalLeads > 0 ? Math.round((count / totalLeads) * 100) : 0;

      return {
        label: bucket.label,
        leadsCount: count,
        pipelineValue: value,
        sharePct,
      };
    });

    // 7. Deal Stage Funnel
    const stagesOrder = [
      { stage: 'qualified', label: 'Qualified (25%)' },
      { stage: 'discovery', label: 'Discovery (45%)' },
      { stage: 'proposal', label: 'Proposal Sent (65%)' },
      { stage: 'negotiation', label: 'Negotiation (85%)' },
      { stage: 'won', label: 'Closed Won (100%)' },
    ];

    const stageFunnel = stagesOrder.map((st) => {
      const stageDeals = deals.filter((d) => d.stage === st.stage);
      return {
        stage: st.stage,
        label: st.label,
        count: stageDeals.length,
        value: stageDeals.reduce((s, d) => s + (Number(d.value) || 0), 0),
      };
    });

    // 8. Extended Revenue, Quotes, Tickets & AI Intent Tiers
    const lostDealsCount = deals.filter((d) => d.stage === 'lost').length;
    const closedCount = wonDeals.length + lostDealsCount;
    const dealWinRatePct =
      closedCount > 0
        ? Math.round((wonDeals.length / closedCount) * 100)
        : totalDeals > 0
          ? Math.round((wonDeals.length / totalDeals) * 100)
          : 0;

    const proformaQuotes = activeInvoices.filter(
      (i) => i.docType === 'proforma_quote',
    );
    const approvedQuotesCount = proformaQuotes.filter(
      (i) => i.quoteApprovalStatus === 'approved',
    ).length;
    const convertedQuotesCount = proformaQuotes.filter(
      (i) => Boolean(i.convertedToInvoiceId),
    ).length;
    const quoteConversionRatePct =
      proformaQuotes.length > 0
        ? Math.round((convertedQuotesCount / proformaQuotes.length) * 100)
        : 0;

    const collectionRatePct =
      totalInvoiced > 0
        ? Math.round((paidInvoicesRevenue / totalInvoiced) * 100)
        : 0;

    // GST Aging & Tax Breakdown
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const agingBuckets = {
      paid: { count: 0, amount: 0 },
      current: { count: 0, amount: 0 },
      days1to15: { count: 0, amount: 0 },
      days16to30: { count: 0, amount: 0 },
      days30Plus: { count: 0, amount: 0 },
    };
    let overdueInvoicesCount = 0;
    let cgstSgstTotal = 0;
    let igstTotal = 0;

    for (const inv of activeInvoices) {
      const { settled, balance } = getInvoiceSettlement(inv);
      const gst = Number(inv.gstAmount) || 0;
      if (inv.taxType === 'igst') igstTotal += gst;
      else cgstSgstTotal += gst;

      if (settled > 0) {
        agingBuckets.paid.amount += settled;
        if (balance <= 0) {
          agingBuckets.paid.count += 1;
          continue;
        }
      }
      if (balance <= 0) {
        agingBuckets.paid.count += 1;
        continue;
      }
      const due = inv.dueDate ? new Date(`${String(inv.dueDate)}T00:00:00`) : null;
      const diffDays =
        due && !Number.isNaN(due.getTime())
          ? Math.floor((todayStart.getTime() - due.getTime()) / 86400000)
          : 0;

      if (diffDays <= 0 && inv.status !== 'overdue') {
        agingBuckets.current.count += 1;
        agingBuckets.current.amount += balance;
      } else {
        overdueInvoicesCount += 1;
        if (diffDays <= 15) {
          agingBuckets.days1to15.count += 1;
          agingBuckets.days1to15.amount += balance;
        } else if (diffDays <= 30) {
          agingBuckets.days16to30.count += 1;
          agingBuckets.days16to30.amount += balance;
        } else {
          agingBuckets.days30Plus.count += 1;
          agingBuckets.days30Plus.amount += balance;
        }
      }
    }

    // AI Intent Tier Distribution
    const hotTierLeads = leads.filter(
      (l) => l.aiLabel === 'Hot' || Number(l.aiScore) >= 80,
    );
    const warmTierLeads = leads.filter((l) => {
      const score = Number(l.aiScore) || 70;
      return l.aiLabel === 'Warm' || (score >= 55 && score < 80 && l.aiLabel !== 'Hot');
    });
    const coldTierLeads = leads.filter((l) => {
      const score = Number(l.aiScore) || 70;
      return l.aiLabel === 'Cold' || (score < 55 && l.aiLabel !== 'Hot' && l.aiLabel !== 'Warm');
    });
    const aiTierBreakdown = [
      {
        tier: 'Hot' as const,
        label: 'Hot (80–100)',
        color: '#10B981',
        count: hotTierLeads.length,
        value: hotTierLeads.reduce((s, l) => s + (Number(l.estimatedValue) || 0), 0),
        sharePct: totalLeads > 0 ? Math.round((hotTierLeads.length / totalLeads) * 100) : 0,
      },
      {
        tier: 'Warm' as const,
        label: 'Warm (55–79)',
        color: '#F59E0B',
        count: warmTierLeads.length,
        value: warmTierLeads.reduce((s, l) => s + (Number(l.estimatedValue) || 0), 0),
        sharePct: totalLeads > 0 ? Math.round((warmTierLeads.length / totalLeads) * 100) : 0,
      },
      {
        tier: 'Cold' as const,
        label: 'Cold (<55)',
        color: '#64748B',
        count: coldTierLeads.length,
        value: coldTierLeads.reduce((s, l) => s + (Number(l.estimatedValue) || 0), 0),
        sharePct: totalLeads > 0 ? Math.round((coldTierLeads.length / totalLeads) * 100) : 0,
      },
    ];

    // 6-Month Revenue & Pipeline Velocity Trend
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const monthlyTrend: {
      monthKey: string;
      label: string;
      leadsCount: number;
      pipelineValue: number;
      invoicedAmount: number;
      paidAmount: number;
    }[] = [];

    for (let offset = 5; offset >= 0; offset -= 1) {
      const ref = new Date(todayStart.getFullYear(), todayStart.getMonth() - offset, 1);
      const yr = ref.getFullYear();
      const mo = ref.getMonth();
      const monthKey = `${yr}-${String(mo + 1).padStart(2, '0')}`;
      const matchMonth = (doc: Record<string, unknown>) => {
        if (!doc.createdAt) return false;
        const d = new Date(String(doc.createdAt));
        return d.getFullYear() === yr && d.getMonth() === mo;
      };
      const mLeads = rawLeads.filter(matchMonth);
      const mDeals = rawDeals.filter(matchMonth);
      const mInvoices = rawInvoices.filter(
        (i) => i.status !== 'cancelled' && matchMonth(i),
      );
      monthlyTrend.push({
        monthKey,
        label: `${monthNames[mo]} '${String(yr).slice(-2)}`,
        leadsCount: mLeads.length,
        pipelineValue:
          mLeads.reduce((s, l) => s + (Number(l.estimatedValue) || 0), 0) +
          mDeals.reduce((s, d) => s + (Number(d.value) || 0), 0),
        invoicedAmount: mInvoices.reduce(
          (s, i) => s + (Number(i.grandTotal) || 0),
          0,
        ),
        paidAmount: mInvoices.reduce(
          (s, i) => s + getInvoiceSettlement(i).settled,
          0,
        ),
      });
    }

    // Sales Rep Leaderboard & Target Progress + Commission Slabs
    const callLogsInRange = rawCallLogs.filter(inRange);
    const repLeaderboard = users
      .map((u) => {
        const uid = String(u._id);
        const repLeads = leads.filter((l) => String(l.ownerId) === uid);
        const repDeals = deals.filter((d) => String(d.ownerId) === uid);
        const repWonDeals = repDeals.filter((d) => d.stage === 'won');
        const repInvoices = activeInvoices.filter((i) => String(i.ownerId) === uid);
        const repPaidRevenue = repInvoices.reduce(
          (s, i) => s + getInvoiceSettlement(i).settled,
          0,
        );
        const repWonValue = repWonDeals.reduce(
          (s, d) => s + (Number(d.value) || 0),
          0,
        );
        const repCallsCount = callLogsInRange.filter(
          (c) => String(c.callerId) === uid,
        ).length;
        const winRatePct =
          repDeals.length > 0
            ? Math.round((repWonDeals.length / repDeals.length) * 100)
            : 0;
        const monthlyTarget = Number(u.monthlyTarget) || 0;
        const commission = computeCommissionBreakdown({
          wonRevenue: repWonValue,
          paidRevenue: repPaidRevenue,
          monthlyTarget,
          policy: commissionPolicy,
        });
        const achievedRevenue = commission.eligibleRevenueInr;
        const targetAchievementPct =
          monthlyTarget > 0
            ? Math.min(200, Math.round((achievedRevenue / monthlyTarget) * 100))
            : 0;

        return {
          userId: uid,
          name: String(u.name || 'Team Member'),
          role: String(u.role || 'agent'),
          territory: String(u.territory || 'Delhi-NCR'),
          leadsCount: repLeads.length,
          hotLeadsCount: repLeads.filter(
            (l) => l.aiLabel === 'Hot' || Number(l.aiScore) >= 80,
          ).length,
          dealsCount: repDeals.length,
          wonDealsCount: repWonDeals.length,
          winRatePct,
          callsCount: repCallsCount,
          wonRevenue: repWonValue,
          paidRevenue: repPaidRevenue,
          achievedRevenue,
          monthlyTarget,
          targetAchievementPct,
          estimatedCommissionInr: commission.totalCommissionInr,
          baseCommissionInr: commission.baseCommissionInr,
          quotaBonusInr: commission.quotaBonusInr,
          activeTierLabel: commission.activeTierLabel,
          activeTierRatePct: commission.activeTierRatePct,
          nextTierRemainingInr: commission.nextTierRemainingInr,
          nextTierRatePct: commission.nextTierRatePct,
        };
      })
      .sort((a, b) => b.achievedRevenue - a.achievedRevenue || b.leadsCount - a.leadsCount);

    // Top Campaigns & SLA Tickets
    const topCampaigns = campaigns
      .slice()
      .sort((a, b) => (Number(b.attributedRevenue) || 0) - (Number(a.attributedRevenue) || 0))
      .slice(0, 4)
      .map((c) => ({
        id: String(c._id),
        name: String(c.name || 'WhatsApp Campaign'),
        status: String(c.status || 'completed'),
        sentCount: Number(c.sentCount) || 0,
        readRate: Number(c.readRate) || 0,
        replyRate: Number(c.replyRate) || 0,
        attributedRevenue: Number(c.attributedRevenue) || 0,
      }));

    const openTicketsCount = tickets.filter((t) =>
      ['open', 'in_progress'].includes(String(t.status || 'open')),
    ).length;
    const urgentTicketsCount = tickets.filter(
      (t) => t.priority === 'urgent' && t.status !== 'resolved' && t.status !== 'closed',
    ).length;
    const resolvedTicketsCount = tickets.filter((t) =>
      ['resolved', 'closed'].includes(String(t.status || '')),
    ).length;

    return {
      range,
      summary: {
        totalLeads,
        hotLeads,
        qualifiedLeads,
        convertedLeads,
        avgAiScore,
        leadPipelineValue,
        totalDeals,
        openDealsCount: openDeals.length,
        wonDealsCount: wonDeals.length,
        lostDealsCount,
        dealWinRatePct,
        openDealsValue,
        weightedForecast,
        wonRevenue,
        totalInvoiced,
        paidInvoicesRevenue,
        pendingReceivables,
        gstOutputTax,
        collectionRatePct,
        overdueInvoicesCount,
        proformaQuotesCount: proformaQuotes.length,
        approvedQuotesCount,
        convertedQuotesCount,
        quoteConversionRatePct,
        cgstSgstTotal,
        igstTotal,
        totalContacts,
        gstVerifiedContacts,
        totalLtv,
        pendingTasksCount,
        completedTasksCount,
        campaignsSentMessages,
        campaignsAttributedRevenue,
        activeWorkflowsCount,
        totalWorkflowRuns,
        hoursSaved,
        teamMembersCount: usersCount,
        openTicketsCount,
        urgentTicketsCount,
        resolvedTicketsCount,
        catalogSkusCount: productsCount,
      },
      sourceBreakdown,
      cityBreakdown,
      stageFunnel,
      aiTierBreakdown,
      agingBuckets,
      monthlyTrend,
      repLeaderboard,
      commissionPolicy,
      topCampaigns,
    };
  }

  async globalSearch(
    auth: { userId: string; tenantId: string },
    rawQuery?: string,
  ) {
    const q = (rawQuery || '').trim();
    const tenantId = new Types.ObjectId(auth.tenantId);
    const db = this.connection.db;
    if (!db) {
      throw new UnauthorizedException('Database connection not ready.');
    }

    const [maskPhones, ownerScope] = await Promise.all([
      this.auditService
        ? this.auditService.shouldMaskViewerPhones(auth.tenantId, auth.userId)
        : Promise.resolve(false),
      resolveOwnerScopeFilter(db, auth),
    ]);

    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rx = escaped ? new RegExp(escaped, 'i') : null;

    const leadFilter = rx
      ? {
          tenantId,
          ...ownerScope,
          $or: [
            { name: rx },
            { company: rx },
            { city: rx },
            ...(maskPhones ? [] : [{ phone: rx }]),
            { email: rx },
          ],
        }
      : { tenantId, ...ownerScope };

    const contactFilter = rx
      ? {
          tenantId,
          ...ownerScope,
          $or: [
            { name: rx },
            { company: rx },
            { gstin: rx },
            { city: rx },
            ...(maskPhones ? [] : [{ phone: rx }]),
          ],
        }
      : { tenantId, ...ownerScope };

    const dealFilter = rx
      ? {
          tenantId,
          ...ownerScope,
          $or: [{ title: rx }, { company: rx }, { contactName: rx }, { city: rx }],
        }
      : { tenantId, ...ownerScope };

    const invoiceFilter = rx
      ? {
          tenantId,
          ...ownerScope,
          $or: [
            { invoiceNumber: rx },
            { clientName: rx },
            { contactPerson: rx },
            { gstin: rx },
          ],
        }
      : { tenantId, ...ownerScope };

    const taskFilter = rx
      ? {
          tenantId,
          ...ownerScope,
          $or: [{ title: rx }, { relatedName: rx }, { relatedCompany: rx }],
        }
      : { tenantId, ...ownerScope };

    const ticketFilter = rx
      ? {
          tenantId,
          ...ownerScope,
          $or: [{ ticketNumber: rx }, { subject: rx }, { customerName: rx }, { company: rx }],
        }
      : { tenantId, ...ownerScope };

    const documentFilter = rx
      ? {
          tenantId,
          ...ownerScope,
          $or: [
            { docCode: rx },
            { title: rx },
            { documentNumber: rx },
            { linkedCustomerName: rx },
            { category: rx },
          ],
        }
      : { tenantId, ...ownerScope };

    const limitPerGroup = rx ? 4 : 2;

    const [leads, contacts, deals, invoices, tasks, tickets, documents] = await Promise.all([
      db.collection('leads').find(leadFilter).sort({ createdAt: -1 }).limit(limitPerGroup).toArray(),
      db.collection('contacts').find(contactFilter).sort({ createdAt: -1 }).limit(limitPerGroup).toArray(),
      db.collection('deals').find(dealFilter).sort({ updatedAt: -1 }).limit(limitPerGroup).toArray(),
      db.collection('invoices').find(invoiceFilter).sort({ createdAt: -1 }).limit(limitPerGroup).toArray(),
      db.collection('tasks').find(taskFilter).sort({ createdAt: -1 }).limit(limitPerGroup).toArray(),
      db.collection('tickets').find(ticketFilter).sort({ createdAt: -1 }).limit(limitPerGroup).toArray(),
      db.collection('documents').find(documentFilter).project({ fileDataUrl: 0 }).sort({ createdAt: -1 }).limit(limitPerGroup).toArray(),
    ]);

    const items = [
      ...leads.map((l) => ({
        id: `lead:${String(l._id)}`,
        entityId: String(l._id),
        type: 'lead' as const,
        title: String(l.name || 'Unnamed Lead'),
        subtitle: [
          String(l.company || ''),
          maskPhones ? maskPhoneNumber(String(l.phone || '')) : String(l.phone || ''),
          `AI ${Number(l.aiScore) || 75}/100`,
        ]
          .filter(Boolean)
          .join(' · '),
        badge: String(l.aiLabel || 'Warm'),
        href: '/leads',
      })),
      ...contacts.map((c) => ({
        id: `contact:${String(c._id)}`,
        entityId: String(c._id),
        type: 'contact' as const,
        title: String(c.company || c.name || 'B2B Contact'),
        subtitle: [
          String(c.name || ''),
          c.gstin ? `GSTIN ${String(c.gstin)}` : '',
          maskPhones ? maskPhoneNumber(String(c.phone || '')) : String(c.phone || ''),
        ]
          .filter(Boolean)
          .join(' · '),
        badge: String(c.type || 'customer').toUpperCase(),
        href: '/contacts',
      })),
      ...deals.map((d) => ({
        id: `deal:${String(d._id)}`,
        entityId: String(d._id),
        type: 'deal' as const,
        title: String(d.title || 'Pipeline Deal'),
        subtitle: `${String(d.company || d.contactName || 'Client')} · ₹${(Number(d.value) || 0).toLocaleString('en-IN')}`,
        badge: String(d.stage || 'qualified').toUpperCase(),
        href: `/deals/${String(d._id)}`,
      })),
      ...invoices.map((i) => ({
        id: `invoice:${String(i._id)}`,
        entityId: String(i._id),
        type: 'invoice' as const,
        title: `${String(i.invoiceNumber || 'INV')} · ${String(i.clientName || '')}`,
        subtitle: `₹${(Number(i.grandTotal) || 0).toLocaleString('en-IN')} (${String(i.status || 'sent').toUpperCase()})`,
        badge: String(i.status || 'sent').toUpperCase(),
        href: i.docType === 'proforma_quote' ? '/quotations' : '/invoices',
      })),
      ...tasks.map((t) => ({
        id: `task:${String(t._id)}`,
        entityId: String(t._id),
        type: 'task' as const,
        title: String(t.title || 'Follow-Up Task'),
        subtitle: `${String(t.relatedCompany || t.relatedName || 'General')} · Due ${String(t.dueDate || 'Today')}`,
        badge: String(t.priority || 'medium').toUpperCase(),
        href: '/tasks',
      })),
      ...tickets.map((tk) => ({
        id: `ticket:${String(tk._id)}`,
        entityId: String(tk._id),
        type: 'ticket' as const,
        title: `${String(tk.ticketNumber || 'TKT')} · ${String(tk.subject || '')}`,
        subtitle: `${String(tk.company || tk.customerName || 'Support')} · ${String(tk.status || 'open').replace('_', ' ')}`,
        badge: String(tk.priority || 'medium').toUpperCase(),
        href: `/tickets?ticketId=${String(tk._id)}`,
      })),
      ...documents.map((doc) => ({
        id: `document:${String(doc._id)}`,
        entityId: String(doc._id),
        type: 'document' as const,
        title: `${String(doc.docCode || 'DOC')} · ${String(doc.title || '')}`,
        subtitle: [
          String(doc.category || '').replace('_', ' ').toUpperCase(),
          doc.documentNumber ? `Ref ${String(doc.documentNumber)}` : '',
          doc.linkedCustomerName ? String(doc.linkedCustomerName) : '',
        ]
          .filter(Boolean)
          .join(' · '),
        badge: String(doc.category || 'document').replace('_', ' ').toUpperCase(),
        href: '/documents',
      })),
    ];

    return {
      query: q,
      total: items.length,
      items,
    };
  }

  async getNotifications(auth: { userId: string; tenantId: string }) {
    const tenantId = new Types.ObjectId(auth.tenantId);
    const db = this.connection.db;
    if (!db) {
      throw new UnauthorizedException('Database connection not ready.');
    }

    const ownerScope = await resolveOwnerScopeFilter(db, auth);
    const userOid = Types.ObjectId.isValid(auth.userId)
      ? new Types.ObjectId(auth.userId)
      : auth.userId;

    const [
      tenantDoc,
      mentions,
      hotLeads,
      pendingTasks,
      unpaidInvoices,
      openThreads,
      openTickets,
    ] = await Promise.all([
      db
        .collection('tenants')
        .findOne(
          { _id: tenantId },
          {
            projection: {
              plan: 1,
              status: 1,
              trialEndsAt: 1,
              isPlatformHq: 1,
              lastExpiryReminderDate: 1,
            },
          },
        )
        .catch(() => null),
      db
        .collection('mention_notifications')
        .find({
          tenantId,
          $or: [{ mentionedUserId: userOid }, { mentionedUserId: auth.userId }],
        })
        .sort({ createdAt: -1 })
        .limit(8)
        .toArray()
        .catch(() => []),
      db
        .collection('leads')
        .find({ tenantId, ...ownerScope, status: { $in: ['new', 'contacted'] } })
        .sort({ createdAt: -1 })
        .limit(5)
        .toArray(),
      db
        .collection('tasks')
        .find({ tenantId, ...ownerScope, status: { $ne: 'done' } })
        .sort({ createdAt: -1 })
        .limit(5)
        .toArray(),
      db
        .collection('invoices')
        .find({
          tenantId,
          ...ownerScope,
          status: { $in: ['sent', 'partial', 'overdue'] },
        })
        .sort({ createdAt: -1 })
        .limit(5)
        .toArray(),
      db
        .collection('conversations')
        .find({ tenantId, ...ownerScope, status: 'open' })
        .sort({ updatedAt: -1 })
        .limit(4)
        .toArray(),
      db
        .collection('tickets')
        .find({
          tenantId,
          ...ownerScope,
          status: { $in: ['open', 'in_progress'] },
        })
        .sort({ createdAt: -1 })
        .limit(4)
        .toArray(),
    ]);

    const billingAlerts: Array<{
      id: string;
      category: 'billing';
      severity: 'urgent' | 'high' | 'medium' | 'info';
      title: string;
      subtitle: string;
      href: string;
      createdAt: string;
    }> = [];

    if (tenantDoc && !tenantDoc.isPlatformHq) {
      const trialEndsAt = String(tenantDoc.trialEndsAt || '').trim();
      const expiresMs = trialEndsAt ? Date.parse(trialEndsAt) : NaN;
      if (trialEndsAt && Number.isFinite(expiresMs)) {
        const daysRemaining = Math.ceil((expiresMs - Date.now()) / 86400000);
        const todayKey = new Date().toISOString().slice(0, 10);
        const endDateLabel = trialEndsAt.slice(0, 10);
        const planLabel = String(tenantDoc.plan || 'growth').toUpperCase();

        if (Date.now() > expiresMs || tenantDoc.status === 'suspended') {
          billingAlerts.push({
            id: `notif-billing-expired-${todayKey}`,
            category: 'billing',
            severity: 'urgent',
            title: 'Plan Expired — Features Paused',
            subtitle: `${planLabel} expired (${endDateLabel}). Data is safe; Admin must renew in Platform Billing to resume.`,
            href: '/settings/billing',
            createdAt: new Date().toISOString(),
          });
        } else if (daysRemaining >= 0 && daysRemaining <= 7) {
          billingAlerts.push({
            id: `notif-billing-expiry-${todayKey}`,
            category: 'billing',
            severity: daysRemaining <= 2 ? 'urgent' : 'high',
            title: `Daily Renewal Reminder: ${daysRemaining} Day(s) Left`,
            subtitle: `${planLabel} plan expires on ${endDateLabel}. Renew now to prevent automatic feature lock.`,
            href: '/settings/billing',
            createdAt: new Date().toISOString(),
          });

          if (tenantDoc.lastExpiryReminderDate !== todayKey) {
            await db
              .collection('tenants')
              .updateOne(
                { _id: tenantId },
                { $set: { lastExpiryReminderDate: todayKey } },
              )
              .catch(() => {});
          }
        }
      }
    }

    const items = [
      ...billingAlerts,
      ...mentions.map((m) => {
        if (m.entityType === 'platform_ticket') {
          const sev = String(m.severity || 'high');
          return {
            id: `notif-plt-${String(m._id)}`,
            category: 'ticket' as const,
            severity:
              sev === 'urgent'
                ? ('urgent' as const)
                : sev === 'info'
                  ? ('info' as const)
                  : ('high' as const),
            title: String(m.title || `Leadsetu HQ Update: ${String(m.entityLabel || '')}`),
            subtitle: String(m.excerpt || ''),
            href: String(m.href || '/support-hq'),
            createdAt: m.createdAt
              ? new Date(m.createdAt as Date).toISOString()
              : new Date().toISOString(),
          };
        }
        return {
          id: `notif-mention-${String(m._id)}`,
          category: 'mention' as const,
          severity: 'high' as const,
          title: `@Mention from ${String(m.authorName || 'Teammate')}: ${String(m.entityLabel || m.entityType || 'Record')}`,
          subtitle: String(m.excerpt || ''),
          href: String(m.href || '/leads'),
          createdAt: m.createdAt
            ? new Date(m.createdAt as Date).toISOString()
            : new Date().toISOString(),
        };
      }),
      ...hotLeads.map((l) => ({
        id: `notif-lead-${String(l._id)}`,
        category: 'lead' as const,
        severity: Number(l.aiScore) >= 80 ? ('high' as const) : ('info' as const),
        title: `Hot/New Lead: ${String(l.name || 'Buyer')}`,
        subtitle: `${String(l.company || l.city || 'Inbound')} · ${String(l.source || 'whatsapp').toUpperCase()} · AI ${Number(l.aiScore) || 75}/100`,
        href: '/leads',
        createdAt: l.createdAt
          ? new Date(l.createdAt as Date).toISOString()
          : new Date().toISOString(),
      })),
      ...unpaidInvoices.map((inv) => {
        const grand = Number(inv.grandTotal) || 0;
        const settled =
          (Number(inv.amountPaid) || 0) + (Number(inv.tdsDeducted) || 0);
        const balance = Math.max(0, grand - settled);
        return {
          id: `notif-inv-${String(inv._id)}`,
          category: 'invoice' as const,
          severity: inv.status === 'overdue' ? ('urgent' as const) : ('medium' as const),
          title: `GST Payment Pending: ${String(inv.invoiceNumber || '')}`,
          subtitle: `${String(inv.clientName || '')} · Bal ₹${balance.toLocaleString('en-IN')} (${String(inv.status || 'sent').toUpperCase()})`,
          href: '/invoices',
          createdAt: inv.createdAt
            ? new Date(inv.createdAt as Date).toISOString()
            : new Date().toISOString(),
        };
      }),
      ...pendingTasks.map((t) => ({
        id: `notif-task-${String(t._id)}`,
        category: 'task' as const,
        severity: t.priority === 'high' ? ('high' as const) : ('info' as const),
        title: `Follow-Up Due: ${String(t.title || 'Call Buyer')}`,
        subtitle: `${String(t.relatedCompany || t.relatedName || 'Lead Follow-Up')} · Due ${String(t.dueDate || 'Today')}`,
        href: '/tasks',
        createdAt: t.createdAt
          ? new Date(t.createdAt as Date).toISOString()
          : new Date().toISOString(),
      })),
      ...openThreads.map((c) => ({
        id: `notif-inbox-${String(c._id)}`,
        category: 'inbox' as const,
        severity: 'info' as const,
        title: `WhatsApp Thread Open: ${String(c.contactName || 'Buyer')}`,
        subtitle: `${String(c.company || c.city || 'Delhi-NCR')} · Needs reply`,
        href: '/inbox',
        createdAt: c.updatedAt
          ? new Date(c.updatedAt as Date).toISOString()
          : new Date().toISOString(),
      })),
      ...openTickets.map((tk) => ({
        id: `notif-ticket-${String(tk._id)}`,
        category: 'ticket' as const,
        severity:
          tk.priority === 'urgent' || tk.priority === 'high'
            ? ('urgent' as const)
            : ('medium' as const),
        title: `SLA Ticket ${String(tk.ticketNumber || '')}: ${String(tk.subject || '')}`,
        subtitle: `${String(tk.company || tk.customerName || 'Client')} · ${String(tk.priority || 'medium').toUpperCase()}`,
        href: '/tickets',
        createdAt: tk.createdAt
          ? new Date(tk.createdAt as Date).toISOString()
          : new Date().toISOString(),
      })),
    ]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 15);

    return {
      totalCount: items.length,
      items,
    };
  }
}
