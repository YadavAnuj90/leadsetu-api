import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AiBridgeService } from './ai-bridge.service';

@ApiTags('AI Copilot & 3 Indian B2B Pillars')
@ApiBearerAuth()
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
  @ApiOperation({ summary: 'Pillar 1: AI Credit Risk Scoring & Hinglish Payment Vaada Extraction' })
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
  @ApiOperation({ summary: 'Pillar 1: AI Hinglish / Hindi / English Udhaar Recovery Reminder Draft' })
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
  @ApiOperation({ summary: 'Pillar 2: Hinglish Voice-to-CRM Extraction & Call Audit' })
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
  @ApiOperation({ summary: 'Pillar 3: WhatsApp Dealer RFQ Parser & Field Beat Route Planner' })
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
  @ApiOperation({ summary: 'Tenant-scoped RAG CRM Q&A Copilot (Products, Documents, Leads, Deals, Invoices, Tasks)' })
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
    summary:
      'Execute a confirmed Copilot transactional action (create_task, schedule_call, create_quotation)',
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
