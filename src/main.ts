import 'reflect-metadata';
import type { RawBodyRequest } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { AppModule } from './app.module';
import {
  convertOpenApiToPostmanCollection,
  sanitizeAndEnrichOpenApiDocument,
  SWAGGER_POSTMAN_CSS,
  SWAGGER_POSTMAN_JS,
} from './swagger-postman.util';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });

  // Allow uploading PDFs / certificates / brochures up to 10 MB via JSON payloads
  // while preserving req.rawBody for Meta X-Hub-Signature-256 verification.
  const preserveRawBody = (
    req: RawBodyRequest<Request>,
    _res: unknown,
    buf: Buffer,
  ) => {
    req.rawBody = buf;
  };
  app.useBodyParser('json', { limit: '10mb', verify: preserveRawBody });
  app.useBodyParser('urlencoded', {
    limit: '10mb',
    extended: true,
    verify: preserveRawBody,
  });

  // Set global prefix `/v1` so leadsetu-web proxy `/api/* -> /v1/*` maps cleanly
  app.setGlobalPrefix('v1');

  // Enable CORS for leadsetu-web frontend & Swagger UI
  app.enableCors({
    origin: [
      process.env.FRONTEND_URL || 'http://localhost:3000',
      'http://127.0.0.1:3000',
      'http://localhost:3001',
    ],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Auth-Scope',
      'X-Razorpay-Signature',
      'X-Hub-Signature-256',
    ],
  });

  // ─── Swagger / OpenAPI Configuration ─────────────────
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Leadsetu AI CRM — Backend API')
    .setDescription(
      'Official OpenAPI 3.0 specification for Leadsetu CRM (Noida / Delhi-NCR). Includes Multi-Tenant Auth, SetuAI Lead Scoring, Visual Kanban Deals Pipeline, B2B Contacts & GST Directory, Sales Follow-up Tasks, and Unified WhatsApp Inbox.'
    )
    .setVersion('2.0.0')
    .setContact(
      'Leadsetu Engineering',
      'http://localhost:3000',
      'hello@leadsetu.in'
    )
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        name: 'Authorization',
        description:
          'Paste your JWT accessToken obtained from POST /v1/auth/login or POST /v1/auth/register',
        in: 'header',
      },
      'access-token'
    )
    .addTag('1. Auth & Workspace', 'Multi-tenant registration, login, JWT refresh & profile')
    .addTag('2. Leads & SetuAI Scoring', 'Lead capture, 1–100 AI scoring, filtering & activity timeline')
    .addTag('3. Deals & Kanban Pipeline', 'Visual sales stages, win probability, 18% GST & weighted forecast')
    .addTag('4. Contacts & GST Directory', 'B2B accounts, 15-digit GSTIN records & Lifetime Value (LTV)')
    .addTag('5. Tasks & Call Reminders', 'Daily follow-ups, site visits, WhatsApp & phone call tasks')
    .addTag('6. Unified WhatsApp & AI Inbox', 'Omnichannel buyer threads & SetuAI smart reply composer')
    .addTag('6B. 2-Way Email CRM & Templates', 'SMTP/IMAP mailbox sync, reusable templates, open tracking & CRM email threads')
    .addTag('7. GST Invoices & Quotations', '18% CGST/SGST & IGST compliant tax invoices, proforma quotes, HSN codes & Razorpay links')
    .addTag('7B. B2B Buyer Magic Portal', 'Passwordless self-service buyer portal for Proforma approvals, GST invoices, Udhaar credit ledger, UPI payment intents & support tickets')
    .addTag('8. WhatsApp Broadcast Campaigns', 'Official Meta Cloud API bulk broadcasts, Hinglish templates & segment funnel analytics')
    .addTag('9. AI Workflows & Automation', 'Zero-code IF-THIS-THEN-THAT CRM automations, auto-task creation & execution logs')
    .addTag('10. Team & Role-Based Access', '5-digit workspace account ID, 10-digit user IDs, add members by email + phone, roles & rep performance')
    .addTag('11. Real-Time Analytics & Command Center', 'Live cross-collection aggregation across Leads, Deals, GST Invoices, Campaigns, Workflows & Team')
    .addTag('12. Security & Audit Trail', 'Immutable tenant activity audit logs & security posture checks')
    .addTag('13. Support & SLA Tickets', 'Customer service tickets, SLA breach timers & resolution workflows')
    .addTag('14. Workspace & Organization', 'Tenant workspace profile, quota visibility & top-up requests')
    .addTag('14. Custom Fields Builder', 'Per-tenant custom CRM fields on Leads, Contacts & Deals')
    .addTag('14. Product & HSN Catalog', 'B2B SKU catalogue, GST rates & HSN/SAC codes')
    .addTag('14. Document Center & Compliance Vault', 'GST certificates, brochures, contracts & signed sales assets')
    .addTag('15. SaaS Billing, Razorpay Checkout & Webhooks', 'Plans, proration, Razorpay subscriptions, invoices & GST credit notes')
    .addTag('15. Super Admin Platform Authority', 'Leadsetu HQ governance, tenant provisioning, DPDP controls & billing ledger')
    .addTag('16. Native CRM Voice Calling', 'Click-to-call WebRTC, Twilio/Exotel bridge & callback links')
    .addTag('16. AI Copilot & 3 Indian B2B Pillars', 'SetuAI credit risk, Udhaar chasers, voice-to-CRM & dealer desk intelligence')
    .build();

  const port = Number(process.env.PORT || 3001);
  const defaultServerUrl =
    process.env.API_PUBLIC_URL || `http://localhost:${port}`;

  const rawDocument = SwaggerModule.createDocument(app, swaggerConfig);
  const document = sanitizeAndEnrichOpenApiDocument(
    rawDocument,
    defaultServerUrl,
  );

  const expressApp = app.getHttpAdapter().getInstance();
  const servePostmanCollection = (req: Request, res: Response) => {
    const protocol = req.protocol || 'http';
    const host = req.get('host');
    const resolvedBaseUrl = host
      ? `${protocol}://${host}`
      : defaultServerUrl;
    const collection = convertOpenApiToPostmanCollection(
      document,
      resolvedBaseUrl,
    );
    if (req.query?.download === '1' || req.query?.download === 'true') {
      res.setHeader(
        'Content-Disposition',
        'attachment; filename="leadsetu-crm-api.postman_collection.json"',
      );
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.send(JSON.stringify(collection, null, 2));
  };
  expressApp.get('/docs-postman.json', servePostmanCollection);
  expressApp.get('/v1/docs-postman.json', servePostmanCollection);

  const swaggerUiOptions = {
    customSiteTitle: 'Leadsetu API Docs — Swagger UI',
    customCss: SWAGGER_POSTMAN_CSS,
    customJsStr: SWAGGER_POSTMAN_JS,
    swaggerOptions: {
      persistAuthorization: true,
      docExpansion: 'list',
      filter: true,
      showRequestDuration: true,
      defaultModelsExpandDepth: 1,
    },
  };

  // Serve Swagger at both `/docs` and `/v1/docs`
  SwaggerModule.setup('docs', app, document, swaggerUiOptions);
  SwaggerModule.setup('v1/docs', app, document, swaggerUiOptions);

  await app.listen(port);
  console.log(`🚀 Leadsetu API running on http://localhost:${port}/v1`);
  console.log(`📘 Swagger API Docs live at http://localhost:${port}/docs`);
  console.log(
    `📮 Postman v2.1 Collection live at http://localhost:${port}/v1/docs-postman.json`,
  );
}

bootstrap();
