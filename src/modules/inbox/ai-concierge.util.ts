export type AiSalesAgentMode = 'autopilot' | 'draft_only' | 'off';
export type AiSalesAgentLanguage = 'auto' | 'hinglish' | 'english' | 'hindi';

export interface AiSalesAgentPolicy {
  mode: AiSalesAgentMode;
  language: AiSalesAgentLanguage;
  maxDiscountPct: number;
  handoffScoreThreshold: number;
  autoSendCatalogPricing: boolean;
  autoUpdateLeadFields: boolean;
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

export const DEFAULT_AI_AGENT_POLICY: AiSalesAgentPolicy = {
  mode: 'draft_only',
  language: 'auto',
  maxDiscountPct: 10,
  handoffScoreThreshold: 80,
  autoSendCatalogPricing: true,
  autoUpdateLeadFields: true,
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
    /\b(kya|hai|hain|bhai|ji|kitna|rate|bhej|bhejo|chahiye|kab|ka|ke|ki|kripya|karo|dena|lena|milega|hoga)\b/i.test(
      message,
    )
  ) {
    return 'hinglish';
  }
  return 'english';
}

export function extractBuyerSignals(params: {
  message: string;
  productsCatalog: CatalogProductBrief[];
  existingData?: AiQualifiedData;
  policy: AiSalesAgentPolicy;
}) {
  const { message, productsCatalog, existingData, policy } = params;
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
  if (!bestProduct && productsCatalog.length > 0 && /price|rate|quote|moq|catalog|product/i.test(lower)) {
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

  // 7) Keyword Escalation Check
  const matchedKeyword = policy.escalationKeywords.find((kw) =>
    lower.includes(kw.toLowerCase()),
  );
  const quoteConfirmIntent = /\b(send\s*quote|bhej(?:o)?\s*proforma|confirm\s*order|place\s*order|pi\s*bhej)\b/i.test(
    lower,
  );

  // 8) Dynamic AI Qualification Score
  let score = 55;
  if (data.productName) score += 14;
  if (data.quantity && data.quantity >= (data.moq || 1)) score += 12;
  if (data.city) score += 10;
  if (data.gstin) score += 12;
  if (quoteConfirmIntent) score += 8;
  const aiScore = Math.max(40, Math.min(98, score));
  const aiLabel: 'Hot' | 'Warm' | 'Cold' =
    aiScore >= 80 ? 'Hot' : aiScore >= 55 ? 'Warm' : 'Cold';

  let handoffReason = '';
  if (discountExceedsCap) {
    handoffReason = `Requested ${requestedDiscountPct}% discount exceeds AI guardrail cap (${policy.maxDiscountPct}% max).`;
  } else if (matchedKeyword) {
    handoffReason = `Buyer triggered escalation keyword "${matchedKeyword}".`;
  } else if (aiScore >= policy.handoffScoreThreshold) {
    handoffReason = `Lead qualified HOT (AI Score ${aiScore} >= ${policy.handoffScoreThreshold}).`;
  }

  return {
    data,
    matchedProduct: bestProduct,
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

export function buildConciergeFallbackReply(params: {
  buyerName: string;
  language: 'hinglish' | 'english' | 'hindi';
  signals: ReturnType<typeof extractBuyerSignals>;
  policy: AiSalesAgentPolicy;
}): string {
  const { buyerName, language, signals, policy } = params;
  const { data, discountExceedsCap, requestedDiscountPct, escalationKeyword, handoffTriggered } =
    signals;
  const isEng = language === 'english';

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
  lines.push(
    isEng
      ? `Hello ${buyerName}!`
      : `Namaste ${buyerName} ji!`,
  );

  if (policy.autoSendCatalogPricing && data.productName && data.quotedUnitPrice) {
    const gstText = `${data.gstRate ?? 18}% GST`;
    const priceLine = isEng
      ? `• *${data.productName}* (SKU: ${data.sku} | HSN: ${data.hsnSac}): ₹${data.quotedUnitPrice.toLocaleString('en-IN')} + ${gstText} | MOQ: ${data.moq || 1}`
      : `• *${data.productName}* (SKU: ${data.sku} | HSN: ${data.hsnSac}): ₹${data.quotedUnitPrice.toLocaleString('en-IN')} + ${gstText} | MOQ: ${data.moq || 1}`;
    lines.push(priceLine);

    if (data.quantity && data.estimatedTotal) {
      lines.push(
        isEng
          ? `• Estimate for ${data.quantity} units (incl. ${gstText}): *₹${data.estimatedTotal.toLocaleString('en-IN')}*`
          : `• ${data.quantity} units ka estimate (${gstText} sahit): *₹${data.estimatedTotal.toLocaleString('en-IN')}*`,
      );
    }
  }

  const missing: string[] = [];
  if (!data.quantity) missing.push(isEng ? 'required quantity' : 'required quantity');
  if (!data.city) missing.push(isEng ? 'delivery city' : 'delivery city');
  if (!data.gstin) missing.push(isEng ? '15-digit GSTIN (optional)' : '15-digit GSTIN (optional)');

  if (handoffTriggered) {
    lines.push(
      isEng
        ? `Your inquiry is fully qualified! I have assigned our specialist to issue your formal Proforma Quotation & dispatch timeline right away.`
        : `Aapki requirement qualify ho gayi hai! Maine hamare Sales Specialist ko assign kar diya hai jo abhi aapko formal GST Proforma Quote bhejenge.`,
    );
  } else if (missing.length > 0) {
    lines.push(
      isEng
        ? `Could you share your ${missing.join(', ')} so I can prepare your instant GST quote?`
        : `Kripya apna ${missing.join(', ')} share karein taaki hum turant accurate GST quotation bhej sakein?`,
    );
  }

  return lines.join('\n');
}
