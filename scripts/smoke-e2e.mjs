#!/usr/bin/env node
/**
 * Leadsetu Happy-Path API / E2E Smoke Suite
 * Verifies critical revenue & lead automation flows end-to-end against a running API:
 *   1. Public Instant Form (/f/[slug]) -> Lead Created + UTM Attribution Saved
 *   2. Public Booking Scheduler (/book/[slug]) -> Real Slots + .ics + Confirmation
 *   3. Interactive Bot Flow (/inbox/bot-flow/simulate) -> Get Rate Card + 2-Step Raise SLA Ticket
 *   4. GST Invoice -> Razorpay Webhook Paid -> status: 'paid' + Meta CAPI Purchase Signal
 */

const BASE = (process.env.API_BASE_URL || 'http://localhost:3001/v1').replace(/\/+$/, '');
const passed = [];

function assert(cond, msg) {
  if (!cond) {
    throw new Error(`ASSERTION FAILED: ${msg}`);
  }
}

async function req(method, path, { token, body, expectedStatus } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  const okStatus = expectedStatus ? res.status === expectedStatus : res.ok;
  if (!okStatus) {
    throw new Error(
      `${method} ${path} -> HTTP ${res.status}: ${JSON.stringify(json)}`,
    );
  }
  return json;
}

function stepOk(label) {
  passed.push(label);
  console.log(`✅ PASS: ${label}`);
}

async function main() {
  const ts = Date.now();
  const suffix = String(ts).slice(-6);

  console.log(`\n🚀 Running Leadsetu E2E Happy-Path Smoke Suite against ${BASE}\n`);

  // 0. Health probe (retry briefly during nest --watch reloads / Mongo reconnects)
  let health = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      health = await req('GET', '/health');
      if (health?.status === 'ok') break;
    } catch (err) {
      if (attempt === 4) throw err;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  assert(health?.status === 'ok', 'API health check returned ok');
  stepOk('0. API & MongoDB Health Check');

  // Bootstrap isolated workspace for smoke test
  const reg = await req('POST', '/auth/register', {
    body: {
      name: 'Smoke Test Founder',
      email: `smoke.${ts}@leadsetu.test`,
      phone: `+91 9811${suffix}`,
      password: `Smoke@${ts}`,
      companyName: `Smoke Industries ${suffix}`,
      city: 'Noida',
      businessMode: 'b2b',
    },
  });
  const token = reg.accessToken;
  assert(Boolean(token), 'Received accessToken from /auth/register');
  stepOk('Bootstrap Isolated Smoke Workspace');

  // -------------------------------------------------------------------------
  // Flow 1: Public Instant Form /f/[slug] -> Lead Created + UTM Saved
  // -------------------------------------------------------------------------
  const form = await req('POST', '/lead-forms', {
    token,
    body: {
      title: `Smoke Quote Form ${suffix}`,
      status: 'live',
      requireWhatsappOtp: false,
      steps: [
        {
          title: 'Contact Info',
          fields: [
            { key: 'name', label: 'Full Name', type: 'text', required: true },
            { key: 'phone', label: 'WhatsApp Number', type: 'phone', required: true },
            { key: 'company', label: 'Company', type: 'text', required: false },
          ],
        },
      ],
    },
  });
  assert(Boolean(form?.slug), 'Created published Instant Form with slug');

  const publicForm = await req('GET', `/public/forms/${encodeURIComponent(form.slug)}`);
  assert(
    publicForm?.form?.slug === form.slug,
    'Public form GET /public/forms/:slug returned form',
  );

  const buyerPhone1 = `+919822${suffix}`;
  const submitRes = await req('POST', `/public/forms/${encodeURIComponent(form.slug)}/submit`, {
    body: {
      answers: {
        name: 'Vikram Malhotra',
        phone: buyerPhone1,
        company: 'Malhotra Steel Works',
      },
      utmSource: 'meta_ads',
      utmMedium: 'cpc',
      utmCampaign: `smoke_campaign_${suffix}`,
    },
  });
  assert(Boolean(submitRes?.leadId), 'Form submission created CRM Lead');

  const subsRes = await req('GET', `/lead-forms/${form.id}/submissions`, { token });
  const matchedSub = (subsRes?.submissions || []).find((s) => s.leadId === submitRes.leadId);
  assert(Boolean(matchedSub), 'Submission visible inside /lead-forms/:id/submissions drawer');
  assert(
    matchedSub.utmSource === 'meta_ads' &&
      matchedSub.utmCampaign === `smoke_campaign_${suffix}`,
    'UTM Source & Campaign persisted accurately on submission',
  );
  stepOk('1. Public Form /f/[slug] -> Lead Created + UTM Attribution Saved');

  // -------------------------------------------------------------------------
  // Flow 2: Public Booking /book/[slug] -> Slots + .ics + Confirmation
  // -------------------------------------------------------------------------
  const connectors = await req('GET', '/marketplace-sync/connectors', { token });
  const bookingSlug = connectors?.bookingScheduler?.slug;
  assert(Boolean(bookingSlug), 'Tenant bookingScheduler slug exists');

  // Ensure all 7 days are enabled so tomorrow always has open slots
  await req('PATCH', '/marketplace-sync/connectors', {
    token,
    body: {
      bookingScheduler: {
        enabled: true,
        workingDays: [0, 1, 2, 3, 4, 5, 6],
        startHour: '09:00',
        endHour: '20:00',
        confirmationWhatsappEnabled: true,
      },
    },
  });

  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const schedInfo = await req(
    'GET',
    `/public/booking/${encodeURIComponent(bookingSlug)}?date=${tomorrow}`,
  );
  const openSlot = (schedInfo?.slots || []).find((s) => s.available !== false);
  assert(Boolean(openSlot?.time24), `Open IST slot available on ${tomorrow}`);

  const booked = await req('POST', `/public/booking/${encodeURIComponent(bookingSlug)}`, {
    body: {
      guestName: 'Ananya Verma',
      guestPhone: `+919833${suffix}`,
      guestEmail: 'ananya@verma.example',
      guestCompany: 'Verma Switchgear',
      topic: 'Bulk 150 KVA Stabilizer Demo',
      dateYmd: tomorrow,
      slotTime24: openSlot.time24,
    },
  });
  assert(Boolean(booked?.bookingRef), 'Booking returned bookingRef');
  assert(
    typeof booked?.icsContent === 'string' &&
      booked.icsContent.includes('BEGIN:VCALENDAR') &&
      booked.icsContent.includes('END:VCALENDAR'),
    'Booking returned valid .ics calendar file content',
  );
  assert(booked?.confirmationSent === true, 'WhatsApp confirmation dispatched cleanly');
  stepOk('2. Booking /book/[slug] -> Open Slots + .ics Download + WhatsApp Confirmation');

  // -------------------------------------------------------------------------
  // Flow 3: Bot Flow /inbox/bot-flow/simulate -> Get Rate Card + Raise SLA Ticket
  // -------------------------------------------------------------------------
  await req('POST', '/products', {
    token,
    body: {
      sku: `SMK-${suffix}`,
      name: 'Industrial Copper Servo Stabilizer 100 KVA',
      unitPrice: 145000,
      gstRate: 18,
      moq: 2,
      inStock: true,
    },
  });

  const botMenu = await req('POST', '/inbox/bot-flow/simulate', {
    token,
    body: { message: 'Namaste' },
  });
  assert(botMenu?.handled === true && Boolean(botMenu?.payload), 'Bot root greeting menu simulated');

  const rateCardTurn = await req('POST', '/inbox/bot-flow/simulate', {
    token,
    body: {
      message: 'Get Rate Card',
      interactiveOptionId: 'ls_bot_branch_rate_card',
      session: botMenu.nextSession,
    },
  });
  assert(
    rateCardTurn?.actionExecuted === 'send_rate_card' &&
      String(rateCardTurn?.payload?.body || '').includes('1,45,000'),
    'Get Rate Card branch pulled live catalog SKU & price',
  );

  const ticketPromptTurn = await req('POST', '/inbox/bot-flow/simulate', {
    token,
    body: {
      message: 'Raise SLA Ticket',
      interactiveOptionId: 'ls_bot_branch_sla_ticket',
      session: rateCardTurn.nextSession,
    },
  });
  assert(
    ticketPromptTurn?.nextSession?.step === 'awaiting_ticket_issue',
    'Raise SLA Ticket entered step awaiting_ticket_issue',
  );

  const ticketCreatedTurn = await req('POST', '/inbox/bot-flow/simulate', {
    token,
    body: {
      message: 'Dispatch delayed on transporter docket',
      session: ticketPromptTurn.nextSession,
    },
  });
  assert(
    ticketCreatedTurn?.actionExecuted === 'ticket_created' &&
      /^SL-/.test(String(ticketCreatedTurn?.createdTicketNumber || '')),
    '2nd bot turn auto-generated SLA Ticket reference',
  );
  stepOk('3. Bot Flow /inbox/bot-flow/simulate -> Get Rate Card + 2-Step Raise SLA Ticket');

  // -------------------------------------------------------------------------
  // Flow 4: GST Invoice -> Razorpay Webhook Paid -> status: 'paid' + Meta CAPI Purchase
  // -------------------------------------------------------------------------
  await req('POST', '/meta-capi/simulate-ctwa', {
    token,
    body: {
      contactName: 'Vikram Malhotra',
      phone: buyerPhone1,
      adHeadline: `Smoke CTWA Campaign ${suffix}`,
      estimatedValue: 11800,
    },
  });

  const inv = await req('POST', '/invoices', {
    token,
    body: {
      docType: 'tax_invoice',
      clientName: 'Smoke Steel Enterprises',
      contactPerson: 'Vikram Malhotra',
      phone: buyerPhone1,
      email: 'accounts@smokesteel.example',
      placeOfSupply: '09 - Uttar Pradesh',
      taxType: 'cgst_sgst',
      gstRate: 18,
      items: [
        {
          description: 'Industrial Copper Servo Stabilizer 100 KVA',
          hsnSac: '850440',
          quantity: 1,
          unitPrice: 10000,
        },
      ],
    },
  });
  assert(Boolean(inv?.id) && Boolean(inv?.paymentLink), 'GST Invoice created with Razorpay link');

  const settled = await req('POST', `/invoices/${inv.id}/simulate-webhook-paid`, {
    token,
  });
  assert(settled?.status === 'paid' && settled?.balanceDue === 0, 'Webhook reconciled Invoice PAID');
  assert(settled?.metaCapiPurchaseFired === true, 'Meta CAPI Purchase signal fired on settlement');

  const capiOverview = await req('GET', '/meta-capi', { token });
  const purchaseEvent = (capiOverview?.events || []).find(
    (e) => e.entityType === 'invoice' && e.entityId === inv.id && e.eventName === 'Purchase',
  );
  assert(Boolean(purchaseEvent), 'Meta CAPI Purchase event logged for paid GST Invoice');
  stepOk('4. Invoice -> Razorpay Webhook Paid -> status=paid + Meta CAPI Purchase Signal');

  console.log(`\n🎉 ALL ${passed.length} HAPPY-PATH E2E CHECKS PASSED CLEANLY!\n`);
}

main().catch((err) => {
  console.error(`\n❌ SMOKE SUITE FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
