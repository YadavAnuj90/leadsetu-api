import 'reflect-metadata';
import type { RawBodyRequest } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { Request } from 'express';
import { AppModule } from './app.module';

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
    allowedHeaders: ['Content-Type', 'Authorization'],
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
    .addTag('7. GST Invoices & Quotations', '18% CGST/SGST & IGST compliant tax invoices, proforma quotes, HSN codes & Razorpay links')
    .addTag('8. WhatsApp Broadcast Campaigns', 'Official Meta Cloud API bulk broadcasts, Hinglish templates & segment funnel analytics')
    .addTag('9. AI Workflows & Automation', 'Zero-code IF-THIS-THEN-THAT CRM automations, auto-task creation & execution logs')
    .addTag('10. Team & Role-Based Access', '5-digit workspace account ID, 10-digit user IDs, add members by email + phone, roles & rep performance')
    .addTag('11. Real-Time Analytics & Command Center', 'Live cross-collection aggregation across Leads, Deals, GST Invoices, Campaigns, Workflows & Team')
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);

  const swaggerUiOptions = {
    customSiteTitle: 'Leadsetu API Docs — Swagger UI',
    swaggerOptions: {
      persistAuthorization: true,
      docExpansion: 'list',
      filter: true,
      showRequestDuration: true,
    },
  };

  // Serve Swagger at both `/docs` and `/v1/docs`
  SwaggerModule.setup('docs', app, document, swaggerUiOptions);
  SwaggerModule.setup('v1/docs', app, document, swaggerUiOptions);

  const port = Number(process.env.PORT || 3001);
  await app.listen(port);
  console.log(`🚀 Leadsetu API running on http://localhost:${port}/v1`);
  console.log(`📘 Swagger API Docs live at http://localhost:${port}/docs`);
}

bootstrap();
