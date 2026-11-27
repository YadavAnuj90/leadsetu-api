import axios from 'axios';

export interface LeadGstinProfile {
  gstin: string;
  validFormat: boolean;
  checksumValid: boolean;
  status: 'Active' | 'Cancelled' | 'Suspended' | 'Unverified' | 'Invalid';
  legalName?: string;
  tradeName?: string;
  stateCode?: string;
  stateName?: string;
  panNumber?: string;
  entityType?: string;
  taxpayerType?: string;
  cityMatchesState?: boolean;
  overdueInvoicesCount?: number;
  overdueAmountInr?: number;
  trustScore: number; // 0..100
  recommendedTerms:
    | 'safe_credit'
    | 'partial_advance_50'
    | 'advance_100'
    | 'manual_review';
  creditAdvice: string;
  verifiedAt: string;
  source: 'live_gstn' | 'checksum_guard';
}

const GST_STATES: Record<string, string> = {
  '01': 'Jammu & Kashmir',
  '02': 'Himachal Pradesh',
  '03': 'Punjab',
  '04': 'Chandigarh',
  '05': 'Uttarakhand',
  '06': 'Haryana',
  '07': 'Delhi',
  '08': 'Rajasthan',
  '09': 'Uttar Pradesh',
  '10': 'Bihar',
  '11': 'Sikkim',
  '12': 'Arunachal Pradesh',
  '13': 'Nagaland',
  '14': 'Manipur',
  '15': 'Mizoram',
  '16': 'Tripura',
  '17': 'Meghalaya',
  '18': 'Assam',
  '19': 'West Bengal',
  '20': 'Jharkhand',
  '21': 'Odisha',
  '22': 'Chhattisgarh',
  '23': 'Madhya Pradesh',
  '24': 'Gujarat',
  '25': 'Daman & Diu',
  '26': 'Dadra & Nagar Haveli',
  '27': 'Maharashtra',
  '28': 'Andhra Pradesh',
  '29': 'Karnataka',
  '30': 'Goa',
  '31': 'Lakshadweep',
  '32': 'Kerala',
  '33': 'Tamil Nadu',
  '34': 'Puducherry',
  '35': 'Andaman & Nicobar Islands',
  '36': 'Telangana',
  '37': 'Andhra Pradesh (New)',
  '38': 'Ladakh',
  '97': 'Other Territory',
};

const CITY_STATE_HINTS: Array<[RegExp, string]> = [
  [/delhi|new delhi/i, '07'],
  [/noida|ghaziabad|lucknow|kanpur|agra|meerut|varanasi|moradabad/i, '09'],
  [/gurgaon|gurugram|faridabad|panipat|karnal|hisar|rohtak|sonipat/i, '06'],
  [/mumbai|pune|thane|nagpur|nashik|aurangabad|navi mumbai/i, '27'],
  [/ahmedabad|surat|vadodara|rajkot|gandhinagar|vapi|bhavnagar/i, '24'],
  [/bengaluru|bangalore|mysore|hubli|mangalore/i, '29'],
  [/chennai|coimbatore|madurai|tiruppur|salem|hosur/i, '33'],
  [/hyderabad|secunderabad|warangal/i, '36'],
  [/jaipur|jodhpur|udaipur|kota|bhiwadi/i, '08'],
  [/ludhiana|jalandhar|amritsar|mohali|patiala/i, '03'],
  [/kolkata|howrah|siliguri|durgapur/i, '19'],
  [/indore|bhopal|jabalpur|gwalior/i, '23'],
  [/chandigarh/i, '04'],
];

const PAN_ENTITY_TYPES: Record<string, string> = {
  C: 'Private / Public Limited Company',
  P: 'Proprietorship / Individual',
  F: 'Partnership Firm / LLP',
  H: 'Hindu Undivided Family (HUF)',
  T: 'Trust',
  A: 'Association of Persons (AOP)',
  B: 'Body of Individuals (BOI)',
  G: 'Government Entity',
  L: 'Local Authority',
  J: 'Artificial Juridical Person',
};

const GSTIN_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Official Mod-36 GSTN check digit validator */
export function validateGstinChecksum(rawGstin: string): boolean {
  const gstin = String(rawGstin || '').trim().toUpperCase();
  if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/.test(gstin)) {
    return false;
  }
  let factor = 2;
  let sum = 0;
  for (let i = 13; i >= 0; i--) {
    const codePoint = GSTIN_CHARS.indexOf(gstin[i]);
    if (codePoint < 0) return false;
    let product = factor * codePoint;
    factor = factor === 2 ? 1 : 2;
    product = Math.floor(product / 36) + (product % 36);
    sum += product;
  }
  const rem = sum % 36;
  const checkIdx = (36 - rem) % 36;
  return GSTIN_CHARS[checkIdx] === gstin[14];
}

export async function evaluateGstinTrustProfile(params: {
  gstin: string;
  company?: string;
  city?: string;
  overdueInvoicesCount?: number;
  overdueAmountInr?: number;
  liveApiUrl?: string;
  liveApiKey?: string;
}): Promise<LeadGstinProfile> {
  const gstin = String(params.gstin || '').trim().toUpperCase();
  const validFormat =
    /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/.test(gstin);
  const checksumValid = validFormat ? validateGstinChecksum(gstin) : false;
  const stateCode = gstin.slice(0, 2);
  const stateName = GST_STATES[stateCode] || (validFormat ? `State #${stateCode}` : undefined);
  const panNumber = validFormat ? gstin.slice(2, 12) : undefined;
  const panFourth = panNumber?.[3] || '';
  const entityType = PAN_ENTITY_TYPES[panFourth] || 'Registered Business Entity';
  const nowIso = new Date().toISOString();
  const overdueCount = Math.max(0, Number(params.overdueInvoicesCount || 0));
  const overdueInr = Math.max(0, Number(params.overdueAmountInr || 0));

  if (!validFormat) {
    return {
      gstin,
      validFormat: false,
      checksumValid: false,
      status: 'Invalid',
      trustScore: 15,
      recommendedTerms: 'manual_review',
      creditAdvice:
        'Invalid 15-character GSTIN format. Request a clear GST Certificate copy on WhatsApp before extending credit.',
      verifiedAt: nowIso,
      source: 'checksum_guard',
    };
  }

  // Optional live GSTN API enrichment if configured in environment
  let liveStatus: LeadGstinProfile['status'] | undefined;
  let liveLegalName: string | undefined;
  let liveTradeName: string | undefined;
  let liveTaxpayerType: string | undefined;
  let source: LeadGstinProfile['source'] = 'checksum_guard';

  if (params.liveApiUrl && params.liveApiKey) {
    try {
      const endpoint = params.liveApiUrl.replace(/\{gstin\}/g, encodeURIComponent(gstin));
      const { data } = await axios.get<Record<string, unknown>>(endpoint, {
        headers: { Authorization: `Bearer ${params.liveApiKey}`, 'x-api-key': params.liveApiKey },
        timeout: 8000,
      });
      const rec = (data?.data || data) as Record<string, unknown>;
      if (rec) {
        const rawSt = String(rec.sts || rec.status || '').toLowerCase();
        liveStatus = rawSt.includes('cancel')
          ? 'Cancelled'
          : rawSt.includes('suspend')
            ? 'Suspended'
            : rawSt.includes('active')
              ? 'Active'
              : undefined;
        liveLegalName = String(rec.lgnm || rec.legalName || '').trim() || undefined;
        liveTradeName = String(rec.tradeNam || rec.tradeName || '').trim() || undefined;
        liveTaxpayerType = String(rec.dty || rec.taxpayerType || '').trim() || undefined;
        source = 'live_gstn';
      }
    } catch {
      // Fallback cleanly to deterministic checksum + ledger guard
    }
  }

  let cityMatchesState = true;
  if (params.city && stateCode) {
    const matchedHint = CITY_STATE_HINTS.find(([rx]) => rx.test(params.city || ''));
    if (matchedHint && matchedHint[1] !== stateCode) {
      cityMatchesState = false;
    }
  }

  const status: LeadGstinProfile['status'] =
    liveStatus || (checksumValid ? 'Active' : 'Unverified');

  // Trust scoring (0..100)
  let trustScore = checksumValid ? 78 : 42;
  if (panFourth === 'C') trustScore += 10; // Pvt Ltd / Ltd corporate governance
  else if (panFourth === 'F') trustScore += 6; // Partnership / LLP
  if (!cityMatchesState) trustScore -= 12;
  if (source === 'live_gstn' && status === 'Active') trustScore += 8;
  if (status === 'Cancelled' || status === 'Suspended') trustScore = 10;
  if (overdueCount > 0 || overdueInr > 0) trustScore -= Math.min(45, overdueCount * 15 + 15);
  trustScore = Math.max(5, Math.min(99, trustScore));

  let recommendedTerms: LeadGstinProfile['recommendedTerms'] = 'partial_advance_50';
  let creditAdvice = '';

  if (status === 'Cancelled' || status === 'Suspended') {
    recommendedTerms = 'advance_100';
    creditAdvice = `Warning: GSTIN status is ${status}. Do NOT issue Net Credit — demand 100% advance payment via UPI/RTGS.`;
  } else if (overdueInr > 0) {
    recommendedTerms = 'advance_100';
    creditAdvice = `Ledger Alert: ₹${overdueInr.toLocaleString('en-IN')} overdue across ${overdueCount} invoice(s). Clear prior dues or insist on 100% advance.`;
  } else if (!checksumValid) {
    recommendedTerms = 'manual_review';
    creditAdvice = `GSTIN format matches 15 chars, but check-digit mismatch detected (likely typo). Ask buyer to confirm 15th character before invoicing.`;
  } else if (trustScore >= 82 && cityMatchesState) {
    recommendedTerms = 'safe_credit';
    creditAdvice = `GSTIN checksum & ${stateName || 'state'} jurisdiction verified (${entityType}). Eligible for standard B2B credit or 30% advance terms.`;
  } else {
    recommendedTerms = 'partial_advance_50';
    creditAdvice = !cityMatchesState
      ? `Valid ${stateName || 'state'} GSTIN (${entityType}), though city "${params.city}" differs from GST jurisdiction. Recommended: 50% Advance + Balance on LR.`
      : `Valid ${stateName || 'state'} GSTIN (${entityType}). Safe to proceed with 50% Advance via UPI QR / Razorpay before dispatch.`;
  }

  return {
    gstin,
    validFormat: true,
    checksumValid,
    status,
    legalName: liveLegalName || (params.company?.trim() ? `${params.company.trim()}` : undefined),
    tradeName: liveTradeName || params.company?.trim() || undefined,
    stateCode,
    stateName,
    panNumber,
    entityType,
    taxpayerType: liveTaxpayerType || 'Regular Taxpayer',
    cityMatchesState,
    overdueInvoicesCount: overdueCount,
    overdueAmountInr: overdueInr,
    trustScore,
    recommendedTerms,
    creditAdvice,
    verifiedAt: nowIso,
    source,
  };
}
