export type CommissionBasis = 'max_won_or_paid' | 'won_deals' | 'paid_invoices';

export interface CommissionSlab {
  minRevenueInr: number;
  maxRevenueInr: number | null;
  ratePct: number;
  label: string;
}

export interface TenantCommissionPolicy {
  enabled: boolean;
  basis: CommissionBasis;
  quotaBonusPct: number;
  slabs: CommissionSlab[];
}

export const DEFAULT_COMMISSION_POLICY: TenantCommissionPolicy = {
  enabled: true,
  basis: 'max_won_or_paid',
  quotaBonusPct: 0.5,
  slabs: [
    {
      minRevenueInr: 0,
      maxRevenueInr: 500000,
      ratePct: 1.5,
      label: 'Starter Slab (0 – ₹5L)',
    },
    {
      minRevenueInr: 500000,
      maxRevenueInr: 1500000,
      ratePct: 2.5,
      label: 'Growth Accelerator (₹5L – ₹15L)',
    },
    {
      minRevenueInr: 1500000,
      maxRevenueInr: null,
      ratePct: 4.0,
      label: 'President Club (₹15L+)',
    },
  ],
};

export function normalizeCommissionPolicy(raw?: unknown): TenantCommissionPolicy {
  if (!raw || typeof raw !== 'object') {
    return {
      ...DEFAULT_COMMISSION_POLICY,
      slabs: DEFAULT_COMMISSION_POLICY.slabs.map((s) => ({ ...s })),
    };
  }
  const obj = raw as Record<string, unknown>;
  const basis: CommissionBasis =
    obj.basis === 'won_deals' ||
    obj.basis === 'paid_invoices' ||
    obj.basis === 'max_won_or_paid'
      ? obj.basis
      : DEFAULT_COMMISSION_POLICY.basis;
  const enabled = obj.enabled !== false;
  const quotaBonusPct = Math.max(
    0,
    Math.min(25, Number(obj.quotaBonusPct ?? DEFAULT_COMMISSION_POLICY.quotaBonusPct)),
  );

  const rawSlabs = Array.isArray(obj.slabs) ? obj.slabs : [];
  const cleanedSlabs: CommissionSlab[] = rawSlabs
    .map((item, idx) => {
      const s = (item || {}) as Record<string, unknown>;
      const minRevenueInr = Math.max(0, Math.round(Number(s.minRevenueInr) || 0));
      const maxRaw =
        s.maxRevenueInr === null ||
        s.maxRevenueInr === undefined ||
        s.maxRevenueInr === '' ||
        Number(s.maxRevenueInr) <= 0
          ? null
          : Math.max(minRevenueInr + 1, Math.round(Number(s.maxRevenueInr)));
      const ratePct = Math.max(0, Math.min(50, Number(s.ratePct) || 0));
      const label =
        String(s.label || '').trim() || `Slab ${idx + 1} (${ratePct}%)`;
      return {
        minRevenueInr,
        maxRevenueInr: maxRaw,
        ratePct,
        label,
      };
    })
    .sort((a, b) => a.minRevenueInr - b.minRevenueInr);

  return {
    enabled,
    basis,
    quotaBonusPct,
    slabs:
      cleanedSlabs.length > 0
        ? cleanedSlabs
        : DEFAULT_COMMISSION_POLICY.slabs.map((s) => ({ ...s })),
  };
}

export interface CommissionSlabBreakdownRow {
  label: string;
  ratePct: number;
  eligibleAmountInr: number;
  earnedInr: number;
  isActive: boolean;
}

export interface ComputedCommissionResult {
  eligibleRevenueInr: number;
  baseCommissionInr: number;
  quotaBonusInr: number;
  totalCommissionInr: number;
  activeTierLabel: string;
  activeTierRatePct: number;
  nextTierMinRevenueInr: number | null;
  nextTierRemainingInr: number;
  nextTierRatePct: number | null;
  quotaAchieved: boolean;
  slabBreakdown: CommissionSlabBreakdownRow[];
}

export function resolveEligibleRevenue(
  wonRevenue: number,
  paidRevenue: number,
  basis: CommissionBasis,
): number {
  const won = Math.max(0, Math.round(wonRevenue || 0));
  const paid = Math.max(0, Math.round(paidRevenue || 0));
  if (basis === 'won_deals') return won;
  if (basis === 'paid_invoices') return paid;
  return Math.max(won, paid);
}

export function computeCommissionBreakdown(params: {
  wonRevenue: number;
  paidRevenue: number;
  monthlyTarget: number;
  policy: TenantCommissionPolicy;
}): ComputedCommissionResult {
  const { wonRevenue, paidRevenue, monthlyTarget, policy } = params;
  const eligibleRevenueInr = resolveEligibleRevenue(
    wonRevenue,
    paidRevenue,
    policy.basis,
  );

  if (!policy.enabled || policy.slabs.length === 0) {
    return {
      eligibleRevenueInr,
      baseCommissionInr: 0,
      quotaBonusInr: 0,
      totalCommissionInr: 0,
      activeTierLabel: 'Disabled',
      activeTierRatePct: 0,
      nextTierMinRevenueInr: null,
      nextTierRemainingInr: 0,
      nextTierRatePct: null,
      quotaAchieved: false,
      slabBreakdown: [],
    };
  }

  let baseCommissionInr = 0;
  let activeTierLabel = policy.slabs[0].label;
  let activeTierRatePct = policy.slabs[0].ratePct;
  let nextTierMinRevenueInr: number | null = null;
  let nextTierRemainingInr = 0;
  let nextTierRatePct: number | null = null;

  const slabBreakdown: CommissionSlabBreakdownRow[] = policy.slabs.map((slab) => {
    const upper = slab.maxRevenueInr ?? Number.POSITIVE_INFINITY;
    const sliceAmount = Math.max(
      0,
      Math.min(eligibleRevenueInr, upper) - slab.minRevenueInr,
    );
    const earnedInr = Math.round((sliceAmount * slab.ratePct) / 100);
    baseCommissionInr += earnedInr;

    const isActive =
      eligibleRevenueInr >= slab.minRevenueInr &&
      (slab.maxRevenueInr === null || eligibleRevenueInr <= slab.maxRevenueInr);
    if (eligibleRevenueInr >= slab.minRevenueInr) {
      activeTierLabel = slab.label;
      activeTierRatePct = slab.ratePct;
    }

    if (
      nextTierMinRevenueInr === null &&
      slab.minRevenueInr > eligibleRevenueInr
    ) {
      nextTierMinRevenueInr = slab.minRevenueInr;
      nextTierRemainingInr = slab.minRevenueInr - eligibleRevenueInr;
      nextTierRatePct = slab.ratePct;
    }

    return {
      label: slab.label,
      ratePct: slab.ratePct,
      eligibleAmountInr: sliceAmount,
      earnedInr,
      isActive,
    };
  });

  const quotaAchieved = monthlyTarget > 0 && eligibleRevenueInr >= monthlyTarget;
  const quotaBonusInr = quotaAchieved
    ? Math.round((eligibleRevenueInr * policy.quotaBonusPct) / 100)
    : 0;

  return {
    eligibleRevenueInr,
    baseCommissionInr,
    quotaBonusInr,
    totalCommissionInr: baseCommissionInr + quotaBonusInr,
    activeTierLabel,
    activeTierRatePct,
    nextTierMinRevenueInr,
    nextTierRemainingInr,
    nextTierRatePct,
    quotaAchieved,
    slabBreakdown,
  };
}
