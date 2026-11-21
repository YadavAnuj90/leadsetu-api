import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AiBridgeService } from './ai-bridge.service';

@ApiTags('16. AI Copilot & 3 Indian B2B Pillars')
@ApiBearerAuth('access-token')
@Controller('ai-copilot')
export class AiBridgeController {
  constructor(private readonly aiBridge: AiBridgeService) {}

  @Get('health')
  @ApiOperation({ summary: 'Check live connection from leadsetu-api (3001) to leadsetu-ai (3002)' })
  async health(@Headers('authorization') authorization?: string) {
    await this.aiBridge.verifyAuth(authorization);
    return this.aiBridge.getHealth();
  }

  @Post('credit-risk')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Pillar 1: AI Credit Risk Scoring & Hinglish Payment Vaada Extraction',
    description: 'Evaluates B2B dealer credit risk based on overdue days, bounced cheques, and recent Hinglish promise-to-pay statements.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['dealerName', 'creditLimitInr', 'outstandingInr', 'overdueInr', 'maxOverdueDays'],
      properties: {
        dealerName: { type: 'string', example: 'RS Electricals Pvt. Ltd.' },
        gstin: { type: 'string', example: '09AABCR1234F1Z5' },
        creditLimitInr: { type: 'number', example: 500000 },
        outstandingInr: { type: 'number', example: 420000 },
        overdueInr: { type: 'number', example: 150000 },
        maxOverdueDays: { type: 'number', example: 22 },
        bouncedCheques: { type: 'number', example: 0 },
        orderValueInr: { type: 'number', example: 250000 },
        recentPromiseText: { type: 'string', example: 'Tuesday ko RTGS kar denge ji' },
      },
    },
  })
  async scoreCreditRisk(
    @Headers('authorization') authorization: string | undefined,
    @Body()
    body: {
      dealerName: string;
      gstin?: string;
      creditLimitInr: number;
      outstandingInr: number;
      overdueInr: number;
      maxOverdueDays: number;
      bouncedCheques?: number;
      orderValueInr?: number;
      recentPromiseText?: string;
    },
  ) {
    const auth = await this.aiBridge.verifyAuth(authorization);
    const res = await this.aiBridge.scoreCreditRisk({
      tenantId: auth.tenantId,
      userId: auth.userId,
      userRole: auth.role,
      context: body,
    });
    return {
      source: res ? 'leadsetu-ai' : 'unavailable',
      response: res,
    };
  }

  @Post('udhaar-reminder')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Pillar 1: AI Hinglish / Hindi / English Udhaar Recovery Reminder Draft',
    description: 'Generates culturally tailored WhatsApp payment follow-up drafts with invoice details and Razorpay settlement link.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['dealerName', 'overdueInr', 'overdueDays'],
      properties: {
        dealerName: { type: 'string', example: 'RS Electricals Pvt. Ltd.' },
        contactPerson: { type: 'string', example: 'Rajesh Sharma' },
        invoiceNumber: { type: 'string', example: 'INV-2026-1002' },
        overdueInr: { type: 'number', example: 150000 },
        overdueDays: { type: 'number', example: 18 },
        tone: { type: 'string', enum: ['gentle', 'firm', 'overdue_alert', 'final_warning'], example: 'gentle' },
        language: { type: 'string', enum: ['hinglish', 'english', 'hindi'], example: 'hinglish' },
        paymentLink: { type: 'string', example: 'https://rzp.io/i/inv1002' },
        companyName: { type: 'string', example: 'Apex Steel Hub' },
      },
    },
  })
  async draftUdhaarReminder(
    @Headers('authorization') authorization: string | undefined,
    @Body()
    body: {
      dealerName: string;
      contactPerson?: string;
      invoiceNumber?: string;
      overdueInr: number;
      overdueDays: number;
      tone?: 'gentle' | 'firm' | 'overdue_alert' | 'final_warning';
      language?: 'hinglish' | 'english' | 'hindi';
      paymentLink?: string;
      companyName?: string;
    },
  ) {
    const auth = await this.aiBridge.verifyAuth(authorization);
    const res = await this.aiBridge.draftUdhaarReminder({
      tenantId: auth.tenantId,
      userId: auth.userId,
      userRole: auth.role,
      context: body,
    });
    return {
      source: res ? 'leadsetu-ai' : 'unavailable',
      response: res,
    };
  }

  @Post('voice-crm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Pillar 2: Hinglish Voice-to-CRM Extraction & Call Audit',
    description: 'Extracts structured CRM updates (lead details, budget, next steps) or audits rep call quality from a sales call transcript.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['transcript'],
      properties: {
        mode: { type: 'string', enum: ['extract', 'audit'], example: 'extract' },
        transcript: { type: 'string', example: 'Sir 500 pieces MCB panel chahiye Noida site par Friday tak.' },
        repName: { type: 'string', example: 'Rohit Verma' },
        leadOrDealerName: { type: 'string', example: 'Mahavir Infra' },
        cityHint: { type: 'string', example: 'Noida' },
      },
    },
  })
  async voiceCrm(
    @Headers('authorization') authorization: string | undefined,
    @Body()
    body: {
      mode?: 'extract' | 'audit';
      transcript: string;
      repName?: string;
      leadOrDealerName?: string;
      cityHint?: string;
    },
  ) {
    const auth = await this.aiBridge.verifyAuth(authorization);
    const res =
      body.mode === 'audit'
        ? await this.aiBridge.auditCall({
            tenantId: auth.tenantId,
            userId: auth.userId,
            userRole: auth.role,
            context: body,
          })
        : await this.aiBridge.extractVoiceToCrm({
            tenantId: auth.tenantId,
            userId: auth.userId,
            userRole: auth.role,
            context: body,
          });
    return {
      source: res ? 'leadsetu-ai' : 'unavailable',
      response: res,
    };
  }

  @Post('dealer-desk')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Pillar 3: WhatsApp Dealer RFQ Parser & Field Beat Route Planner',
    description: 'Parses unstructured WhatsApp RFQ lists into SKU line items (`mode: "rfq"`) or builds optimized field sales beat plans (`mode: "beat_plan"`).',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['rfq', 'beat_plan'], example: 'rfq' },
        message: { type: 'string', example: 'Send quote for 20x 40A MCB and 10 rolls 2.5mm wire' },
        city: { type: 'string', example: 'Noida Sector 62' },
        stops: { type: 'array', items: { type: 'object' } },
      },
    },
  })
  async dealerDesk(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: Record<string, unknown>,
  ) {
    const auth = await this.aiBridge.verifyAuth(authorization);
    const res =
      body.mode === 'beat_plan'
        ? await this.aiBridge.buildBeatPlan({
            tenantId: auth.tenantId,
            userId: auth.userId,
            userRole: auth.role,
            context: body,
          })
        : await this.aiBridge.parseDealerRfq({
            tenantId: auth.tenantId,
            userId: auth.userId,
            userRole: auth.role,
            context: body,
          });
    return {
      source: res ? 'leadsetu-ai' : 'unavailable',
      response: res,
    };
  }

  @Post('chat')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Tenant-scoped RAG CRM Q&A Copilot',
    description: 'Answers natural-language questions grounded in the workspace Product Catalogue, Document Vault PDFs, Leads, Deals, Invoices, and Tasks.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['question'],
      properties: {
        question: { type: 'string', example: 'What is our HSN code and rate for 3-phase switchgear and any overdue invoices in Noida?' },
        records: { type: 'array', items: { type: 'object' }, description: 'Optional inline CRM context records' },
      },
    },
  })
  async chat(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: { question: string; records?: unknown[] },
  ) {
    const auth = await this.aiBridge.verifyAuth(authorization);
    const res = await this.aiBridge.chat({
      tenantId: auth.tenantId,
      userId: auth.userId,
      userRole: auth.role,
      context: body,
    });
    return {
      source: res ? 'leadsetu-ai' : 'unavailable',
      response: res,
    };
  }

  @Post('knowledge/sync')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Auto-index workspace Product Catalogue (/products), Document Vault (/documents) & CRM records into leadsetu-ai RAG store',
  })
  async syncKnowledge(
    @Headers('authorization') authorization: string | undefined,
  ) {
    const auth = await this.aiBridge.verifyAuth(authorization);
    return this.aiBridge.syncTenantKnowledgeIndex(auth.tenantId, auth.userId);
  }

  @Post('execute-action')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Execute a confirmed Copilot transactional action',
    description: 'Executes a confirmed CRM action (`create_task`, `schedule_call`, `create_quotation`, or `send_whatsapp_draft`) directly on behalf of the signed-in user.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['type'],
      properties: {
        type: { type: 'string', enum: ['create_task', 'schedule_call', 'create_quotation', 'send_whatsapp_draft'], example: 'create_task' },
        payload: { type: 'object', example: { title: 'Follow up with Rajesh ji on GST quote', dueDate: '2026-11-25' } },
      },
    },
  })
  async executeAction(
    @Headers('authorization') authorization: string | undefined,
    @Body()
    body: {
      type:
        | 'create_task'
        | 'schedule_call'
        | 'create_quotation'
        | 'send_whatsapp_draft';
      payload?: Record<string, unknown>;
    },
  ) {
    const auth = await this.aiBridge.verifyAuth(authorization);
    return this.aiBridge.executeCopilotAction(auth, body);
  }

  @Get('usage')
  @ApiOperation({ summary: 'Fetch daily/monthly AI token usage & cost telemetry for current workspace' })
  async usage(@Headers('authorization') authorization?: string) {
    const auth = await this.aiBridge.verifyAuth(authorization);
    return this.aiBridge.getTenantUsage(auth.tenantId);
  }
}
