export type BotFlowLanguage = 'english' | 'hindi' | 'hinglish';

export type BotFlowMenuMode = 'auto' | 'buttons' | 'list';

export type BotFlowActionType =
  | 'send_rate_card'
  | 'send_booking_link'
  | 'track_order'
  | 'create_sla_ticket'
  | 'handoff_rep'
  | 'sub_menu';

export interface BotFlowLocalizedText {
  english: string;
  hindi: string;
  hinglish: string;
}

export interface BotFlowBranch {
  id: string;
  enabled: boolean;
  title: BotFlowLocalizedText;
  description: BotFlowLocalizedText;
  keywords: string[];
  actionType: BotFlowActionType;
  replyBody: BotFlowLocalizedText;
  followUpButtons: string[];
  ticketPriority: 'low' | 'medium' | 'high' | 'urgent';
  ticketCategory:
    | 'dispatch_delay'
    | 'warranty'
    | 'gst_correction'
    | 'installation'
    | 'amc_service'
    | 'general';
  routeToRole: 'sales' | 'support' | 'manager' | 'owner';
  hitsCount: number;
}

export interface BotFlowStats {
  totalRuns: number;
  buttonsTapped: number;
  ticketsCreated: number;
  rateCardsSent: number;
  demosShared: number;
  ordersTracked: number;
  lastTriggeredAt?: string;
}

export interface WhatsAppBotFlowConfig {
  enabled: boolean;
  defaultLanguage: BotFlowLanguage;
  autoDetectLanguage: boolean;
  menuMode: BotFlowMenuMode;
  triggerKeywords: string[];
  triggerOnFirstMessage: boolean;
  cooldownMinutes: number;
  listButtonLabel: BotFlowLocalizedText;
  welcomeHeader: BotFlowLocalizedText;
  welcomeBody: BotFlowLocalizedText;
  footerText: string;
  branches: BotFlowBranch[];
  stats: BotFlowStats;
}

export interface BotSessionState {
  step?: 'root' | 'awaiting_ticket_issue' | 'completed';
  lastBranchId?: string;
  lastMenuSentAt?: string;
  language?: BotFlowLanguage;
}

export interface InteractiveMenuButton {
  id: string;
  title: string;
}

export interface InteractiveMenuListRow {
  id: string;
  title: string;
  description?: string;
}

export interface InteractiveBotPayload {
  body: string;
  footerText: string;
  interactiveType: 'buttons' | 'list' | 'none';
  buttons?: InteractiveMenuButton[];
  listMenu?: {
    headerText?: string;
    buttonLabel: string;
    sectionTitle: string;
    rows: InteractiveMenuListRow[];
  };
}

export const BOT_MAIN_MENU_ID = 'ls_bot_main_menu';

export function buildDefaultWhatsAppBotFlowConfig(): WhatsAppBotFlowConfig {
  return {
    enabled: false,
    defaultLanguage: 'hinglish',
    autoDetectLanguage: true,
    menuMode: 'auto',
    triggerKeywords: [
      'hi',
      'hello',
      'hey',
      'namaste',
      'menu',
      'start',
      'help',
      'info',
      'price',
      'rate',
    ],
    triggerOnFirstMessage: true,
    cooldownMinutes: 15,
    listButtonLabel: {
      english: 'Choose Option',
      hindi: 'विकल्प चुनें',
      hinglish: 'Option Chunein',
    },
    welcomeHeader: {
      english: 'Welcome to {{company}}',
      hindi: '{{company}} में आपका स्वागत है',
      hinglish: 'Namaste {{buyer_name}} ji! {{company}}',
    },
    welcomeBody: {
      english:
        'Hi {{buyer_name}}, how can we help your business today? Tap an option below for instant details:',
      hindi:
        'नमस्ते {{buyer_name}} जी! आज हम आपकी किस प्रकार सहायता कर सकते हैं? तुरंत जानकारी के लिए नीचे विकल्प चुनें:',
      hinglish:
        'Namaste {{buyer_name}} ji! Aaj hum aapki kya madad kar sakte hain? Instant update ke liye neeche button select karein:',
    },
    footerText: 'Powered by Leadsetu CRM',
    branches: [
      {
        id: 'branch_rate_card',
        enabled: true,
        title: {
          english: 'Get Rate Card',
          hindi: 'रेट कार्ड पाएं',
          hinglish: 'Rate Card Paayein',
        },
        description: {
          english: 'Latest GST prices, MOQ & bulk slabs',
          hindi: 'ताज़ा GST मूल्य, MOQ और थोक दरें',
          hinglish: 'Latest GST price list, MOQ aur bulk rates',
        },
        keywords: ['1', 'rate', 'price', 'rate card', 'catalog', 'quote', 'bhav', 'ret'],
        actionType: 'send_rate_card',
        replyBody: {
          english:
            'Here is our latest GST Rate Card from our live catalog. Reply with SKU & quantity for an instant proforma invoice:',
          hindi:
            'यहाँ हमारी लाइव कैटलॉग की ताज़ा GST रेट लिस्ट है। तुरंत प्रोफॉर्मा इनवॉइस के लिए SKU और मात्रा बताएं:',
          hinglish:
            'Yeh rahi hamari latest GST Rate Card list. Instant proforma quote ke liye SKU aur quantity reply karein:',
        },
        followUpButtons: ['Book Demo', 'Main Menu'],
        ticketPriority: 'medium',
        ticketCategory: 'general',
        routeToRole: 'sales',
        hitsCount: 0,
      },
      {
        id: 'branch_book_demo',
        enabled: true,
        title: {
          english: 'Book Demo',
          hindi: 'डेमो बुक करें',
          hinglish: 'Demo Book Karein',
        },
        description: {
          english: 'Schedule 15-min IST specialist call',
          hindi: 'विशेषज्ञ के साथ 15 मिनट की कॉल बुक करें',
          hinglish: '15-min video/call slot reserve karein',
        },
        keywords: ['2', 'demo', 'book', 'meeting', 'call', 'appointment', 'slot', 'schedule'],
        actionType: 'send_booking_link',
        replyBody: {
          english:
            'Pick your preferred IST date & slot with our product specialist directly using this link:',
          hindi:
            'हमारे प्रोडक्ट विशेषज्ञ के साथ अपनी सुविधा के अनुसार IST स्लॉट चुनने के लिए इस लिंक पर क्लिक करें:',
          hinglish:
            'Apni pasand ka IST time slot direct book karne ke liye neeche link open karein:',
        },
        followUpButtons: ['Get Rate Card', 'Main Menu'],
        ticketPriority: 'medium',
        ticketCategory: 'general',
        routeToRole: 'sales',
        hitsCount: 0,
      },
      {
        id: 'branch_track_order',
        enabled: true,
        title: {
          english: 'Track Order',
          hindi: 'ऑर्डर ट्रैक करें',
          hinglish: 'Order Track Karein',
        },
        description: {
          english: 'Live invoice, dispatch & deal status',
          hindi: 'इनवॉइस, डिस्पैच और डील की लाइव स्थिति',
          hinglish: 'Apna invoice, dispatch aur deal status dekhein',
        },
        keywords: ['3', 'track', 'order', 'status', 'dispatch', 'invoice', 'delivery', 'kahan'],
        actionType: 'track_order',
        replyBody: {
          english: 'Checked your account records for your latest order & billing status:',
          hindi: 'आपके नंबर से जुड़े ताज़ा ऑर्डर और बिलिंग की जानकारी नीचे दी गई है:',
          hinglish: 'Aapke number par latest order / invoice update check kar liya hai:',
        },
        followUpButtons: ['Raise SLA Ticket', 'Main Menu'],
        ticketPriority: 'medium',
        ticketCategory: 'dispatch_delay',
        routeToRole: 'support',
        hitsCount: 0,
      },
      {
        id: 'branch_sla_ticket',
        enabled: true,
        title: {
          english: 'Raise SLA Ticket',
          hindi: 'सपोर्ट टिकट बनाएं',
          hinglish: 'SLA Ticket Banayein',
        },
        description: {
          english: 'Priority dispatch, GST or service help',
          hindi: 'डिस्पैच, GST या सर्विस सहायता के लिए',
          hinglish: 'Dispatch, GST ya warranty help ke liye',
        },
        keywords: ['4', 'ticket', 'sla', 'complaint', 'issue', 'warranty', 'support', 'problem', 'shikayat'],
        actionType: 'create_sla_ticket',
        replyBody: {
          english:
            'Please choose the issue category below or reply with a 1-line summary (e.g. "Dispatch delayed for INV-104") to open a priority SLA ticket:',
          hindi:
            'कृपया नीचे समस्या चुनें या 1 लाइन में अपना विवरण लिखें ताकि तुरंत प्राथमिकता SLA टिकट बन सके:',
          hinglish:
            'Kripya neeche issue chunein ya 1 line mein apni query likhein — turant priority SLA Ticket ban jayega:',
        },
        followUpButtons: ['Dispatch Delay', 'GST / Billing', 'Warranty Help'],
        ticketPriority: 'high',
        ticketCategory: 'dispatch_delay',
        routeToRole: 'support',
        hitsCount: 0,
      },
    ],
    stats: {
      totalRuns: 0,
      buttonsTapped: 0,
      ticketsCreated: 0,
      rateCardsSent: 0,
      demosShared: 0,
      ordersTracked: 0,
    },
  };
}

function normalizeLocalizedText(
  raw: unknown,
  fallback: BotFlowLocalizedText,
  maxLength?: number,
): BotFlowLocalizedText {
  const src =
    raw && typeof raw === 'object' ? (raw as Partial<BotFlowLocalizedText>) : {};
  const clamp = (val: unknown, fb: string) => {
    const clean = String(val ?? fb).trim() || fb;
    return maxLength ? clean.slice(0, maxLength) : clean;
  };
  return {
    english: clamp(src.english, fallback.english),
    hindi: clamp(src.hindi, fallback.hindi),
    hinglish: clamp(src.hinglish, fallback.hinglish),
  };
}

export function normalizeWhatsAppBotFlowConfig(
  raw: unknown,
): WhatsAppBotFlowConfig {
  const defaults = buildDefaultWhatsAppBotFlowConfig();
  if (!raw || typeof raw !== 'object') {
    return defaults;
  }
  const src = raw as Partial<WhatsAppBotFlowConfig>;

  const validLangs: BotFlowLanguage[] = ['english', 'hindi', 'hinglish'];
  const defaultLanguage: BotFlowLanguage = validLangs.includes(
    src.defaultLanguage as BotFlowLanguage,
  )
    ? (src.defaultLanguage as BotFlowLanguage)
    : defaults.defaultLanguage;

  const validModes: BotFlowMenuMode[] = ['auto', 'buttons', 'list'];
  const menuMode: BotFlowMenuMode = validModes.includes(
    src.menuMode as BotFlowMenuMode,
  )
    ? (src.menuMode as BotFlowMenuMode)
    : defaults.menuMode;

  const validActions: BotFlowActionType[] = [
    'send_rate_card',
    'send_booking_link',
    'track_order',
    'create_sla_ticket',
    'handoff_rep',
    'sub_menu',
  ];

  const rawBranches = Array.isArray(src.branches) ? src.branches : defaults.branches;
  const branches: BotFlowBranch[] = rawBranches
    .slice(0, 10)
    .map((b, idx) => {
      const def =
        defaults.branches.find((d) => d.id === b?.id) ||
        defaults.branches[idx] ||
        defaults.branches[0];
      const item = (b || {}) as Partial<BotFlowBranch>;
      const id =
        String(item.id || def.id || `branch_${idx + 1}`)
          .trim()
          .replace(/[^a-zA-Z0-9_-]/g, '_') || `branch_${idx + 1}`;
      return {
        id,
        enabled: item.enabled !== false,
        title: normalizeLocalizedText(item.title, def.title, 24),
        description: normalizeLocalizedText(item.description, def.description, 72),
        keywords: Array.isArray(item.keywords)
          ? item.keywords.map((k) => String(k || '').trim().toLowerCase()).filter(Boolean)
          : def.keywords,
        actionType: validActions.includes(item.actionType as BotFlowActionType)
          ? (item.actionType as BotFlowActionType)
          : def.actionType,
        replyBody: normalizeLocalizedText(item.replyBody, def.replyBody, 900),
        followUpButtons: Array.isArray(item.followUpButtons)
          ? item.followUpButtons
              .map((btn) => String(btn || '').trim().slice(0, 20))
              .filter(Boolean)
              .slice(0, 3)
          : def.followUpButtons,
        ticketPriority: (['low', 'medium', 'high', 'urgent'].includes(
          String(item.ticketPriority || ''),
        )
          ? item.ticketPriority
          : def.ticketPriority) as BotFlowBranch['ticketPriority'],
        ticketCategory: (['dispatch_delay', 'warranty', 'gst_correction', 'installation', 'amc_service', 'general'].includes(
          String(item.ticketCategory || ''),
        )
          ? item.ticketCategory
          : def.ticketCategory) as BotFlowBranch['ticketCategory'],
        routeToRole: (['sales', 'support', 'manager', 'owner'].includes(
          String(item.routeToRole || ''),
        )
          ? item.routeToRole
          : def.routeToRole) as BotFlowBranch['routeToRole'],
        hitsCount: Math.max(0, Number(item.hitsCount ?? 0) || 0),
      };
    });

  const statsSrc = (src.stats || {}) as Partial<BotFlowStats>;
  return {
    enabled: Boolean(src.enabled),
    defaultLanguage,
    autoDetectLanguage: src.autoDetectLanguage !== false,
    menuMode,
    triggerKeywords:
      Array.isArray(src.triggerKeywords) && src.triggerKeywords.length > 0
        ? src.triggerKeywords
            .map((k) => String(k || '').trim().toLowerCase())
            .filter(Boolean)
            .slice(0, 20)
        : defaults.triggerKeywords,
    triggerOnFirstMessage: src.triggerOnFirstMessage !== false,
    cooldownMinutes: Math.max(
      0,
      Math.min(1440, Number(src.cooldownMinutes ?? defaults.cooldownMinutes) || 15),
    ),
    listButtonLabel: normalizeLocalizedText(
      src.listButtonLabel,
      defaults.listButtonLabel,
      20,
    ),
    welcomeHeader: normalizeLocalizedText(
      src.welcomeHeader,
      defaults.welcomeHeader,
      60,
    ),
    welcomeBody: normalizeLocalizedText(src.welcomeBody, defaults.welcomeBody, 900),
    footerText:
      String(src.footerText || defaults.footerText).trim().slice(0, 60) ||
      defaults.footerText,
    branches: branches.length > 0 ? branches : defaults.branches,
    stats: {
      totalRuns: Math.max(0, Number(statsSrc.totalRuns || 0)),
      buttonsTapped: Math.max(0, Number(statsSrc.buttonsTapped || 0)),
      ticketsCreated: Math.max(0, Number(statsSrc.ticketsCreated || 0)),
      rateCardsSent: Math.max(0, Number(statsSrc.rateCardsSent || 0)),
      demosShared: Math.max(0, Number(statsSrc.demosShared || 0)),
      ordersTracked: Math.max(0, Number(statsSrc.ordersTracked || 0)),
      lastTriggeredAt: statsSrc.lastTriggeredAt
        ? String(statsSrc.lastTriggeredAt)
        : undefined,
    },
  };
}

export function detectBotLanguage(
  text: string,
  fallback: BotFlowLanguage,
  autoDetect = true,
  override?: BotFlowLanguage,
): BotFlowLanguage {
  if (override) return override;
  if (!autoDetect) return fallback;
  const trimmed = String(text || '').trim();
  if (!trimmed) return fallback;
  if (/[\u0900-\u097F]/.test(trimmed)) {
    return 'hindi';
  }
  const lower = trimmed.toLowerCase();
  if (
    /\b(namaste|namaskar|bhav|kya|kaise|kitna|kitne|kab|chahiye|chunein|banayein|karein|paayein|dekh|batao|bhejo|bhai|bhaiya|ji|aap|hum|mera|meri|kahan|dikha|shikayat)\b/.test(
      lower,
    )
  ) {
    return 'hinglish';
  }
  return fallback;
}

export function pickLocalizedText(
  localized: BotFlowLocalizedText,
  lang: BotFlowLanguage,
): string {
  return (
    String(localized?.[lang] || '').trim() ||
    String(localized?.english || '').trim() ||
    String(localized?.hinglish || '').trim() ||
    String(localized?.hindi || '').trim()
  );
}

export function interpolateBotVars(
  template: string,
  vars: { buyerName: string; company: string },
): string {
  const buyer = String(vars.buyerName || 'Sir/Madam').trim() || 'Sir/Madam';
  const company = String(vars.company || 'Leadsetu Partner').trim();
  return String(template || '')
    .replace(/\{\{\s*buyer_name\s*\}\}/gi, buyer)
    .replace(/\{\{\s*company\s*\}\}/gi, company);
}

export function buildRootMenuPayload(
  config: WhatsAppBotFlowConfig,
  lang: BotFlowLanguage,
  vars: { buyerName: string; company: string },
): InteractiveBotPayload {
  const activeBranches = config.branches.filter((b) => b.enabled).slice(0, 10);
  const body = interpolateBotVars(pickLocalizedText(config.welcomeBody, lang), vars);
  const headerText = interpolateBotVars(
    pickLocalizedText(config.welcomeHeader, lang),
    vars,
  );
  const useButtons =
    config.menuMode === 'buttons' ||
    (config.menuMode === 'auto' && activeBranches.length <= 3);

  if (activeBranches.length === 0) {
    return {
      body,
      footerText: config.footerText,
      interactiveType: 'none',
    };
  }

  if (useButtons) {
    return {
      body,
      footerText: config.footerText,
      interactiveType: 'buttons',
      buttons: activeBranches.slice(0, 3).map((b) => ({
        id: `ls_bot_${b.id}`,
        title: pickLocalizedText(b.title, lang).slice(0, 20),
      })),
    };
  }

  return {
    body,
    footerText: config.footerText,
    interactiveType: 'list',
    listMenu: {
      headerText: headerText.slice(0, 60),
      buttonLabel: pickLocalizedText(config.listButtonLabel, lang).slice(0, 20),
      sectionTitle:
        lang === 'hindi'
          ? 'मुख्य सेवाएं'
          : lang === 'hinglish'
            ? 'Mukhya Sevaayein'
            : 'Quick Actions',
      rows: activeBranches.slice(0, 10).map((b) => ({
        id: `ls_bot_${b.id}`,
        title: pickLocalizedText(b.title, lang).slice(0, 24),
        description: pickLocalizedText(b.description, lang).slice(0, 72),
      })),
    },
  };
}

export function mainMenuButtonLabel(lang: BotFlowLanguage): string {
  if (lang === 'hindi') return 'मुख्य मेनू';
  return 'Main Menu';
}

export interface BotMatchOutcome {
  kind: 'menu' | 'branch' | 'ticket_issue' | 'follow_up_action' | 'none';
  branch?: BotFlowBranch;
  isButtonTap?: boolean;
  ticketIssueSummary?: string;
}

export function matchBotInput(params: {
  config: WhatsAppBotFlowConfig;
  text: string;
  interactiveOptionId?: string;
  session?: BotSessionState;
  isFirstConversationInbound?: boolean;
}): BotMatchOutcome {
  const { config, text, interactiveOptionId, session, isFirstConversationInbound } =
    params;
  const cleanText = String(text || '').trim();
  const lower = cleanText.toLowerCase();
  const optionId = String(interactiveOptionId || '').trim();
  const activeBranches = config.branches.filter((b) => b.enabled);

  // 1. Direct Main Menu button / keyword
  if (
    optionId === BOT_MAIN_MENU_ID ||
    optionId === 'ls_followup_main_menu' ||
    /^(main\s*menu|menu|मुख्य\s*मेनू|back|start|restart|0)$/i.test(cleanText)
  ) {
    return { kind: 'menu', isButtonTap: Boolean(optionId) };
  }

  // 2. Match exact branch by Interactive ID (button_reply.id / list_reply.id)
  if (optionId.startsWith('ls_bot_')) {
    const rawBranchId = optionId.slice('ls_bot_'.length);
    const matched = activeBranches.find((b) => b.id === rawBranchId);
    if (matched) {
      return { kind: 'branch', branch: matched, isButtonTap: true };
    }
  }

  // 3. If buyer is in `awaiting_ticket_issue` step and tapped one of the SLA quick buttons OR typed issue details
  if (session?.step === 'awaiting_ticket_issue' && cleanText) {
    // Allow switching to another explicit menu trigger/button first if optionId matched below,
    // otherwise treat this reply as their SLA Ticket issue description!
    const exactBranchByLabel = activeBranches.find((b) => {
      const titles = [b.title.english, b.title.hindi, b.title.hinglish]
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean);
      return titles.includes(lower);
    });
    if (!exactBranchByLabel) {
      return {
        kind: 'ticket_issue',
        ticketIssueSummary: cleanText,
        isButtonTap: Boolean(optionId),
      };
    }
  }

  // 4. Match exact title (case-insensitive) across all 3 languages (e.g. Follow-up button "Book Demo" or typed title)
  const titleMatch = activeBranches.find((b) => {
    const titles = [b.title.english, b.title.hindi, b.title.hinglish]
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    return titles.includes(lower);
  });
  if (titleMatch) {
    return { kind: 'branch', branch: titleMatch, isButtonTap: Boolean(optionId) };
  }

  // 5. Numeric shortcut ("1", "2", "3", "4")
  if (/^[1-9]$/.test(lower)) {
    const idx = Number(lower) - 1;
    if (activeBranches[idx]) {
      return { kind: 'branch', branch: activeBranches[idx], isButtonTap: false };
    }
  }

  // 6. Branch keyword matching
  for (const branch of activeBranches) {
    const hit = branch.keywords.some((kw) => {
      const normalizedKw = kw.trim().toLowerCase();
      if (!normalizedKw || normalizedKw.length < 2) return false;
      return (
        lower === normalizedKw ||
        new RegExp(`\\b${normalizedKw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(
          lower,
        )
      );
    });
    if (hit) {
      return { kind: 'branch', branch, isButtonTap: false };
    }
  }

  // 7. Follow-up "Talk to Rep" / "Agent" CTA
  if (/talk\s*to\s*rep|agent|human|manager|executive/i.test(lower)) {
    const handoffBranch = activeBranches.find((b) => b.actionType === 'handoff_rep');
    if (handoffBranch) {
      return { kind: 'branch', branch: handoffBranch, isButtonTap: Boolean(optionId) };
    }
    return { kind: 'follow_up_action', isButtonTap: Boolean(optionId) };
  }

  // 8. Check root greeting / trigger keywords or first message cooldown
  const cooldownMs = Math.max(0, config.cooldownMinutes) * 60 * 1000;
  const lastMenuMs = session?.lastMenuSentAt ? Date.parse(session.lastMenuSentAt) : 0;
  const withinCooldown =
    cooldownMs > 0 && lastMenuMs > 0 && Date.now() - lastMenuMs < cooldownMs;

  const isExplicitTrigger = config.triggerKeywords.some((kw) => {
    const normalizedKw = kw.trim().toLowerCase();
    if (!normalizedKw) return false;
    return (
      lower === normalizedKw ||
      new RegExp(`\\b${normalizedKw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(
        lower,
      )
    );
  });

  if (isExplicitTrigger && !withinCooldown) {
    return { kind: 'menu', isButtonTap: false };
  }
  if (isFirstConversationInbound && config.triggerOnFirstMessage && !withinCooldown) {
    return { kind: 'menu', isButtonTap: false };
  }

  return { kind: 'none' };
}
