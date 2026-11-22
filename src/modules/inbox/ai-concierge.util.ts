export type AiSalesAgentMode = 'autopilot' | 'draft_only' | 'off';
export type AiSalesAgentLanguage = 'auto' | 'hinglish' | 'english' | 'hindi';

export interface AiSalesAgentPolicy {
  mode: AiSalesAgentMode;
  language: AiSalesAgentLanguage;
  maxDiscountPct: number;
  handoffScoreThreshold: number;
  autoSendCatalogPricing: boolean;
  autoUpdateLeadFields: boolean;
  autoShareBookingLink: boolean;
  businessHoursOnly: boolean;
  escalationKeywords: string[];
}

export interface AiQualifiedData {
  productName?: string;
  sku?: string;
  hsnSac?: string;
  moq?: number;
  quotedUnitPrice?: number;
  gstRate?: number;
  quantity?: number;
  city?: string;
  gstin?: string;
  estimatedTotal?: number;
  requestedDiscountPct?: number;
  matchedKbTitles?: string[];
  bookingLinkShared?: string;
}

export interface AiActionLogItem {
  id: string;
  action:
    | 'autopilot_replied'
    | 'draft_prepared'
    | 'lead_qualified'
    | 'handoff_triggered'
    | 'guardrail_blocked'
    | 'skipped_paused';
  detail: string;
  replySent?: string;
  mode: AiSalesAgentMode;
  createdAt: string;
}

export interface KnowledgeDocBrief {
  id: string;
  title: string;
  category: string;
  content: string;
  tags?: string[];
}

export interface MatchedKbSnippet {
  id: string;
  title: string;
  category: string;
  snippet: string;
  score: number;
}

export const DEFAULT_AI_AGENT_POLICY: AiSalesAgentPolicy = {
  mode: 'draft_only',
  language: 'auto',
  maxDiscountPct: 10,
  handoffScoreThreshold: 80,
  autoSendCatalogPricing: true,
  autoUpdateLeadFields: true,
  autoShareBookingLink: true,
  businessHoursOnly: false,
  escalationKeywords: [
    'human',
    'manager',
    'call back',
    'callback',
    'agent',
    'complaint',
    'credit limit',
    'udhaar',
  ],
};

export function normalizeAiAgentPolicy(raw?: unknown): AiSalesAgentPolicy {
  if (!raw || typeof raw !== 'object') {
    return {
      ...DEFAULT_AI_AGENT_POLICY,
      escalationKeywords: [...DEFAULT_AI_AGENT_POLICY.escalationKeywords],
    };
  }
  const obj = raw as Record<string, unknown>;
  const mode: AiSalesAgentMode =
    obj.mode === 'autopilot' || obj.mode === 'draft_only' || obj.mode === 'off'
      ? obj.mode
      : DEFAULT_AI_AGENT_POLICY.mode;
  const language: AiSalesAgentLanguage =
    obj.language === 'auto' ||
    obj.language === 'hinglish' ||
    obj.language === 'english' ||
    obj.language === 'hindi'
      ? obj.language
      : DEFAULT_AI_AGENT_POLICY.language;

  const keywords = Array.isArray(obj.escalationKeywords)
    ? obj.escalationKeywords
        .map((k) => String(k || '').trim().toLowerCase())
        .filter(Boolean)
    : DEFAULT_AI_AGENT_POLICY.escalationKeywords;

  return {
    mode,
    language,
    maxDiscountPct: Math.max(
      0,
      Math.min(50, Number(obj.maxDiscountPct ?? DEFAULT_AI_AGENT_POLICY.maxDiscountPct)),
    ),
    handoffScoreThreshold: Math.max(
      50,
      Math.min(
        98,
        Math.round(
          Number(
            obj.handoffScoreThreshold ??
              DEFAULT_AI_AGENT_POLICY.handoffScoreThreshold,
          ),
        ),
      ),
    ),
    autoSendCatalogPricing: obj.autoSendCatalogPricing !== false,
    autoUpdateLeadFields: obj.autoUpdateLeadFields !== false,
    autoShareBookingLink: obj.autoShareBookingLink !== false,
    businessHoursOnly: Boolean(obj.businessHoursOnly),
    escalationKeywords:
      keywords.length > 0
        ? keywords
        : [...DEFAULT_AI_AGENT_POLICY.escalationKeywords],
  };
}

const KNOWN_INDIAN_CITIES = [
  'greater noida',
  'new delhi',
  'noida',
  'delhi',
  'gurugram',
  'gurgaon',
  'faridabad',
  'ghaziabad',
  'mumbai',
  'pune',
  'bengaluru',
  'bangalore',
  'hyderabad',
  'chennai',
  'kolkata',
  'ahmedabad',
  'surat',
  'jaipur',
  'lucknow',
  'kanpur',
  'ludhiana',
  'bhiwadi',
  'rajkot',
  'coimbatore',
  'indore',
  'nagpur',
  'chandigarh',
  'vadodara',
];

export interface CatalogProductBrief {
  name: string;
  sku: string;
  hsnSac: string;
  moq: number;
  unit: string;
  unitPrice: number;
  gstRate: number;
  description: string;
  brochureUrl: string;
}

export function detectReplyLanguage(
  message: string,
  configured: AiSalesAgentLanguage,
): 'hinglish' | 'english' | 'hindi' {
  if (configured !== 'auto') return configured;
  if (/[\u0900-\u097F]/.test(message)) return 'hindi';
  if (
    /\b(kya|hai|hain|bhai|bhaiya|ji|kitna|rate|bhej|bhejo|chahiye|kab|ka|ke|ki|kripya|karo|dena|lena|milega|hoga|bakwas|bekar|karni|saal|tak)\b/i.test(
      message,
    )
  ) {
    return 'hinglish';
  }
  return 'english';
}

const HINGLISH_SYNONYM_GROUPS: Array<{ triggers: RegExp; expand: string[] }> = [
  {
    triggers: /\b(warranty|guarantee|garanti|kharab|faulty|repair|replace|replacement|service)\b/i,
    expand: ['warranty', 'replacement', 'service', 'defective', 'guarantee'],
  },
  {
    triggers: /\b(dispatch|delivery|shipping|courier|awb|transport|bilty|kab|aayega|pahunchega|time)\b/i,
    expand: ['dispatch', 'delivery', 'shipping', 'transport', 'days', 'hours', 'eway'],
  },
  {
    triggers: /\b(gst|tax|bill|invoice|itc|hsn|sac|b2b)\b/i,
    expand: ['gst', 'invoice', 'tax', 'itc', 'hsn', 'moq'],
  },
  {
    triggers: /\b(pay|payment|upi|qr|razorpay|neft|rtgs|udhaar|credit|advance)\b/i,
    expand: ['payment', 'upi', 'razorpay', 'neft', 'rtgs', 'credit', 'terms'],
  },
  {
    triggers: /\b(demo|sample|trial|meeting|call|book|visit)\b/i,
    expand: ['demo', 'sample', 'trial', 'consultation', 'booking'],
  },
];

export function retrieveTopKbMatches(
  message: string,
  kbDocs: KnowledgeDocBrief[],
  limit = 2,
): MatchedKbSnippet[] {
  const cleanMsg = String(message || '').trim().toLowerCase();
  if (!cleanMsg || !Array.isArray(kbDocs) || kbDocs.length === 0) return [];

  const queryTokens = new Set(
    cleanMsg
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 2),
  );
  for (const grp of HINGLISH_SYNONYM_GROUPS) {
    if (grp.triggers.test(cleanMsg)) {
      for (const word of grp.expand) queryTokens.add(word);
    }
  }

  const scored: MatchedKbSnippet[] = [];
  for (const doc of kbDocs) {
    const titleLower = String(doc.title || '').toLowerCase();
    const contentLower = String(doc.content || '').toLowerCase();
    const tagStr = (doc.tags || []).join(' ').toLowerCase();
    let score = 0;

    for (const tok of queryTokens) {
      if (titleLower.includes(tok)) score += 6;
      if (tagStr.includes(tok)) score += 5;
      if (contentLower.includes(tok)) score += 2;
    }

    if (score >= 4) {
      const compact = String(doc.content || '')
        .replace(/\s+/g, ' ')
        .trim();
      const snippet = compact.length > 260 ? `${compact.slice(0, 257)}...` : compact;
      scored.push({
        id: doc.id,
        title: doc.title,
        category: doc.category,
        snippet,
        score,
      });
    }
  }

  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

export function detectBuyerFrustration(text: string): {
  frustrationDetected: boolean;
  phrase: string;
} {
  const patterns: Array<[RegExp, string]> = [
    [/\b(bakwas|bekar|third\s*class|ghatiya|fhaltu)\b/i, 'dissatisfaction'],
    [/\b(fraud|scam|cheat|cheating|dhokha)\b/i, 'trust concern'],
    [/\b(pathetic|useless|worst|horrible|terrible|ridiculous)\b/i, 'negative complaint'],
    [/\b(consumer\s*court|legal|police|complaint)\b/i, 'escalation threat'],
    [/\b(kab\s*se|2\s*din\s*se|still\s*waiting|koi\s*reply\s*nahi|no\s*response|pareshan)\b/i, 'delay frustration'],
    [/\b(refund|cancel\s*order|galat\s*maal|damaged)\b/i, 'refund/defect issue'],
  ];
  for (const [re, label] of patterns) {
    if (re.test(text)) {
      return { frustrationDetected: true, phrase: label };
    }
  }
  return { frustrationDetected: false, phrase: '' };
}

export function detectBookingIntent(text: string): boolean {
  return /\b(book\s*(?:a\s*)?(?:demo|call|slot|meeting)|schedule\s*(?:a\s*)?(?:call|demo|meeting)|demo\s*dikha|demo\s*chahiye|appointment|video\s*call|zoom\s*call|call\s*book|kal\s*(?:call|demo|meeting))\b/i.test(
    text,
  );
}

export function extractBuyerSignals(params: {
  message: string;
  productsCatalog: CatalogProductBrief[];
  kbDocs?: KnowledgeDocBrief[];
  existingData?: AiQualifiedData;
  policy: AiSalesAgentPolicy;
}) {
  const { message, productsCatalog, kbDocs = [], existingData, policy } = params;
  const text = String(message || '').trim();
  const lower = text.toLowerCase();

  const data: AiQualifiedData = { ...(existingData || {}) };

  // 1) Extract 15-char GSTIN
  const gstMatch = text.match(/\b(\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z])\b/i);
  if (gstMatch) {
    data.gstin = gstMatch[1].toUpperCase();
  }

  // 2) Extract City
  const matchedCity = KNOWN_INDIAN_CITIES.find((c) => lower.includes(c));
  if (matchedCity) {
    data.city = matchedCity
      .split(' ')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  }

  // 3) Match Best Catalog Product
  let bestProduct: CatalogProductBrief | null = null;
  let bestScore = 0;
  for (const prod of productsCatalog) {
    let score = 0;
    const skuLower = prod.sku.toLowerCase();
    const hsnLower = prod.hsnSac.toLowerCase();
    if (skuLower && lower.includes(skuLower)) score += 10;
    if (hsnLower && lower.includes(hsnLower)) score += 8;
    const tokens = prod.name
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3);
    for (const tok of tokens) {
      if (lower.includes(tok)) score += 3;
    }
    if (score > bestScore) {
      bestScore = score;
      bestProduct = prod;
    }
  }
  if (
    !bestProduct &&
    productsCatalog.length > 0 &&
    /\b(price|rate|quote|moq|catalog|product|pcs|units|mcb|switch)\b/i.test(lower)
  ) {
    bestProduct = productsCatalog[0];
  }
  if (bestProduct) {
    data.productName = bestProduct.name;
    data.sku = bestProduct.sku;
    data.hsnSac = bestProduct.hsnSac;
    data.moq = bestProduct.moq;
    data.quotedUnitPrice = bestProduct.unitPrice;
    data.gstRate = bestProduct.gstRate;
  }

  // 4) Extract Quantity
  const qtyMatch =
    text.match(/\b(\d{1,6})\s*(?:pcs|pc|units|unit|nos|no|sets|set|box|boxes|kg|mtr|kvas?)\b/i) ||
    text.match(/\b(?:qty|quantity|require|order|chahiye)\s*[:\-]?\s*(\d{1,6})\b/i);
  if (qtyMatch) {
    const qtyNum = Number(qtyMatch[1]);
    if (Number.isFinite(qtyNum) && qtyNum > 0) {
      data.quantity = qtyNum;
    }
  } else if (!data.quantity) {
    const bareNumber = text.match(/^\s*(\d{2,5})\s*$/);
    if (bareNumber) {
      data.quantity = Number(bareNumber[1]);
    }
  }

  // 5) Calculate Estimated Value (Base + GST if price known)
  if (data.quotedUnitPrice && data.quotedUnitPrice > 0) {
    const effectiveQty = data.quantity || data.moq || 1;
    const subTotal = data.quotedUnitPrice * effectiveQty;
    const gstPct = data.gstRate ?? 18;
    data.estimatedTotal = Math.round(subTotal * (1 + gstPct / 100));
  }

  // 6) Discount Guardrail Detection
  const discMatch = text.match(/(\d{1,2})\s*%?\s*(?:discount|off|kam|less|chhoot)/i);
  const requestedDiscountPct = discMatch ? Number(discMatch[1]) : undefined;
  if (requestedDiscountPct !== undefined && Number.isFinite(requestedDiscountPct)) {
    data.requestedDiscountPct = requestedDiscountPct;
  }
  const discountExceedsCap =
    requestedDiscountPct !== undefined && requestedDiscountPct > policy.maxDiscountPct;

  // 7) Keyword Escalation, Frustration, Booking Intent & Grounded KB Retrieval
  const matchedKeyword = policy.escalationKeywords.find((kw) =>
    lower.includes(kw.toLowerCase()),
  );
  const frustration = detectBuyerFrustration(text);
  const bookingIntent = detectBookingIntent(text);
  const matchedKb = retrieveTopKbMatches(text, kbDocs, 2);
  if (matchedKb.length > 0) {
    data.matchedKbTitles = matchedKb.map((k) => k.title);
  }

  const quoteConfirmIntent = /\b(send\s*quote|bhej(?:o)?\s*proforma|confirm\s*order|place\s*order|pi\s*bhej)\b/i.test(
    lower,
  );

  // 8) Dynamic AI Qualification Score
  let score = 55;
  if (data.productName) score += 14;
  if (data.quantity && data.quantity >= (data.moq || 1)) score += 12;
  if (data.city) score += 10;
  if (data.gstin) score += 12;
  if (quoteConfirmIntent || bookingIntent) score += 8;
  const aiScore = Math.max(40, Math.min(98, score));
  const aiLabel: 'Hot' | 'Warm' | 'Cold' =
    aiScore >= 80 ? 'Hot' : aiScore >= 55 ? 'Warm' : 'Cold';

  let handoffReason = '';
  if (frustration.frustrationDetected) {
    handoffReason = `Buyer frustration detected (${frustration.phrase}) — paused AI & alerted Human Manager.`;
  } else if (discountExceedsCap) {
    handoffReason = `Requested ${requestedDiscountPct}% discount exceeds AI guardrail cap (${policy.maxDiscountPct}% max).`;
  } else if (matchedKeyword) {
    handoffReason = `Buyer triggered escalation keyword "${matchedKeyword}".`;
  } else if (aiScore >= policy.handoffScoreThreshold) {
    handoffReason = `Lead qualified HOT (AI Score ${aiScore} >= ${policy.handoffScoreThreshold}).`;
  }

  return {
    data,
    matchedProduct: bestProduct,
    matchedKb,
    bookingIntent,
    frustrationDetected: frustration.frustrationDetected,
    frustrationPhrase: frustration.phrase,
    detectedLanguage: detectReplyLanguage(text, policy.language),
    discountExceedsCap,
    requestedDiscountPct,
    escalationKeyword: matchedKeyword || '',
    quoteConfirmIntent,
    aiScore,
    aiLabel,
    handoffTriggered: Boolean(handoffReason),
    handoffReason,
  };
}

export function isWithinIstBusinessHours(now = new Date()): boolean {
  const ist = new Date(now.getTime() + 5.5 * 3600_000);
  const day = ist.getUTCDay(); // 0=Sun..6=Sat
  const hour = ist.getUTCHours();
  if (day === 0) return false;
  return hour >= 9 && hour < 20;
}

export function buildConciergeFallbackReply(params: {
  buyerName: string;
  language: 'hinglish' | 'english' | 'hindi';
  signals: ReturnType<typeof extractBuyerSignals>;
  policy: AiSalesAgentPolicy;
  bookingPublicUrl?: string;
}): string {
  const { buyerName, language, signals, policy, bookingPublicUrl } = params;
  const {
    data,
    discountExceedsCap,
    requestedDiscountPct,
    escalationKeyword,
    frustrationDetected,
    matchedKb,
    bookingIntent,
    handoffTriggered,
  } = signals;
  const isEng = language === 'english';

  if (frustrationDetected) {
    return isEng
      ? `Sincere apologies ${buyerName} for any delay or inconvenience! I have paused automated replies and immediately escalated your thread on high priority to our Senior Support Manager, who will call you right away.`
      : `Maafi chahte hain ${buyerName} ji delay aur pareshani ke liye! Maine automated replies pause karke aapka case turant hamare Senior Manager ko high-priority par escalate kar diya hai — woh abhi aapko direct call karenge.`;
  }

  if (discountExceedsCap) {
    return isEng
      ? `Thank you ${buyerName}. A ${requestedDiscountPct}% discount exceeds our instant approval limit (up to ${policy.maxDiscountPct}%). I have escalated your request to our Senior Sales Manager who will connect with you shortly with the best possible commercial rate.`
      : `Namaste ${buyerName} ji! ${requestedDiscountPct}% discount instant AI limit (max ${policy.maxDiscountPct}%) se zyada hai. Maine aapki request hamare Senior Sales Manager ko priority par transfer kar di hai — woh jald hi best rate ke saath call karenge.`;
  }

  if (escalationKeyword) {
    return isEng
      ? `Certainly ${buyerName}! I have notified our account specialist right away${
          data.city ? ` for your ${data.city} requirement` : ''
        } and shared full conversation context so you don't have to repeat anything.`
      : `Bilkul ${buyerName} ji! Maine turant hamare dedicated Sales Specialist ko notify kar diya hai aur saari details forward kar di hain — woh abhi aapse connect karenge.`;
  }

  const lines: string[] = [];
  lines.push(isEng ? `Hello ${buyerName}!` : `Namaste ${buyerName} ji!`);

  if (matchedKb.length > 0) {
    for (const kb of matchedKb) {
      lines.push(`📌 *${kb.title}:* ${kb.snippet}`);
    }
  }

  if (policy.autoSendCatalogPricing && data.productName && data.quotedUnitPrice) {
    const gstText = `${data.gstRate ?? 18}% GST`;
    lines.push(
      `• *${data.productName}* (SKU: ${data.sku} | HSN: ${data.hsnSac}): ₹${data.quotedUnitPrice.toLocaleString('en-IN')} + ${gstText} | MOQ: ${data.moq || 1}`,
    );

    if (data.quantity && data.estimatedTotal) {
      lines.push(
        isEng
          ? `• Estimate for ${data.quantity} units (incl. ${gstText}): *₹${data.estimatedTotal.toLocaleString('en-IN')}*`
          : `• ${data.quantity} units ka estimate (${gstText} sahit): *₹${data.estimatedTotal.toLocaleString('en-IN')}*`,
      );
    }
  }

  if (bookingIntent && policy.autoShareBookingLink && bookingPublicUrl) {
    lines.push(
      isEng
        ? `📅 Pick a convenient demo/call slot directly here: ${bookingPublicUrl}`
        : `📅 Apni suvidha ke hisaab se demo/call slot yahan book karein: ${bookingPublicUrl}`,
    );
  }

  const missing: string[] = [];
  if (!data.quantity) missing.push('required quantity');
  if (!data.city) missing.push('delivery city');
  if (!data.gstin) missing.push('15-digit GSTIN (optional)');

  if (handoffTriggered) {
    lines.push(
      isEng
        ? `Your inquiry is fully qualified! I have assigned our specialist to issue your formal Proforma Quotation & dispatch timeline right away.`
        : `Aapki requirement qualify ho gayi hai! Maine hamare Sales Specialist ko assign kar diya hai jo abhi aapko formal GST Proforma Quote bhejenge.`,
    );
  } else if (missing.length > 0 && matchedKb.length === 0 && !bookingIntent) {
    lines.push(
      isEng
        ? `Could you share your ${missing.join(', ')} so I can prepare your instant GST quote?`
        : `Kripya apna ${missing.join(', ')} share karein taaki hum turant accurate GST quotation bhej sakein?`,
    );
  }

  return lines.join('\n');
}
