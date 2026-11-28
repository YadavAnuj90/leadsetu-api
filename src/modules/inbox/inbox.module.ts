import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Module,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiProperty,
  ApiPropertyOptional,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Tenant, TenantSchema } from '../auth/schemas/tenant.schema';
import { User, UserSchema } from '../auth/schemas/user.schema';
import { Contact, ContactSchema } from '../contacts/contacts.service';
import { Deal, DealSchema } from '../deals/schemas/deal.schema';
import { Invoice, InvoiceSchema } from '../invoices/invoices.service';
import { Lead, LeadSchema } from '../leads/schemas/lead.schema';
import { ProductItem, ProductSchema } from '../products/products.module';
import {
  PlatformConfig,
  PlatformConfigSchema,
} from '../super-admin/schemas/platform-config.schema';
import { Ticket, TicketSchema } from '../tickets/tickets.service';
import {
  DEFAULT_WHATSAPP_TEMPLATES,
  InboxService,
  SUPPORTED_WHATSAPP_VARIABLES,
  extractLast10Digits,
  extractVariables,
  renderTemplateBody,
  slugifyTemplateName,
} from './inbox.service';
import { MetaWhatsAppService } from './meta-whatsapp.service';
import { InboxGateway } from './inbox.gateway';
import {
  ChatAttachment,
  ChatMessage,
  ConversationDocument,
  ConversationThread,
  ConversationThreadSchema,
  LinkedCrmEntityType,
} from './schemas/conversation.schema';
import {
  WhatsAppTemplate,
  WhatsAppTemplateCategory,
  WhatsAppTemplateLanguage,
  WhatsAppTemplateSchema,
} from './schemas/whatsapp-template.schema';
import {
  AiKnowledgeCategory,
  AiKnowledgeEntry,
  AiKnowledgeEntrySchema,
} from './schemas/ai-knowledge-entry.schema';
import { WhatsAppWebhookController } from './webhooks/whatsapp.controller';

export {
  ChatAttachment,
  ChatMessage,
  ConversationDocument,
  ConversationThread,
  ConversationThreadSchema,
  DEFAULT_WHATSAPP_TEMPLATES,
  InboxService,
  LinkedCrmEntityType,
  SUPPORTED_WHATSAPP_VARIABLES,
  extractLast10Digits,
  extractVariables,
  renderTemplateBody,
  slugifyTemplateName,
};

export class SendInboxMessageSwaggerDto {
  @ApiPropertyOptional({
    description: 'Outbound WhatsApp / IndiaMART message content (English or Hinglish)',
    example:
      'Namaste Rajesh ji! 500 units par 12% bulk discount approve ho gaya hai. Sharing GST proforma invoice right away.',
  })
  content?: string;

  @ApiPropertyOptional({
    description: 'Whether this message was drafted using SetuAI Smart Reply',
    example: true,
    default: false,
  })
  isAiDrafted?: boolean;

  @ApiPropertyOptional({
    description: 'Optional WhatsApp template ID used to compose this message',
  })
  templateId?: string;

  @ApiPropertyOptional({
    description: 'Delivery medium used by agent',
    enum: ['inbox', 'wa_me'],
    default: 'inbox',
  })
  via?: 'inbox' | 'wa_me';

  @ApiPropertyOptional({
    description: 'Whether to auto-log message to linked CRM activity timeline',
    default: true,
  })
  logToTimeline?: boolean;

  @ApiPropertyOptional({
    description: 'Meta delivery mode: free-form text or approved Meta template',
    enum: ['text', 'meta_template'],
    default: 'text',
  })
  sendMode?: 'text' | 'meta_template';

  @ApiPropertyOptional({
    description: 'Approved Meta WhatsApp template payload when sendMode=meta_template',
  })
  metaTemplate?: {
    name: string;
    languageCode?: string;
    bodyParams?: string[];
  };

  @ApiPropertyOptional({
    description: 'Optional PDF/image attachment URL or base64 data URL',
  })
  attachment?: ChatAttachment;
}

export class UpdateInboxStatusSwaggerDto {
  @ApiProperty({
    description: 'Conversation resolution state',
    enum: ['open', 'resolved'],
    example: 'resolved',
  })
  status!: 'open' | 'resolved';
}

export class CreateWhatsAppTemplateSwaggerDto {
  @ApiProperty({ example: 'GST Proforma Follow-up' })
  name!: string;

  @ApiPropertyOptional({
    enum: ['greeting', 'quotation', 'followup', 'payment', 'support', 'custom'],
    default: 'custom',
  })
  category?: WhatsAppTemplateCategory;

  @ApiPropertyOptional({
    enum: ['English', 'Hinglish', 'Hindi'],
    default: 'Hinglish',
  })
  language?: WhatsAppTemplateLanguage;

  @ApiProperty({
    example: 'Namaste {{buyer_name}} ji from {{company}}, sharing quote worth {{deal_value}}.',
  })
  body!: string;

  @ApiPropertyOptional({ default: true })
  isActive?: boolean;
}

export class UpdateWhatsAppTemplateSwaggerDto {
  @ApiPropertyOptional()
  name?: string;

  @ApiPropertyOptional({
    enum: ['greeting', 'quotation', 'followup', 'payment', 'support', 'custom'],
  })
  category?: WhatsAppTemplateCategory;

  @ApiPropertyOptional({
    enum: ['English', 'Hinglish', 'Hindi'],
  })
  language?: WhatsAppTemplateLanguage;

  @ApiPropertyOptional()
  body?: string;

  @ApiPropertyOptional()
  isActive?: boolean;
}

export class RenderWhatsAppTemplateSwaggerDto {
  @ApiPropertyOptional()
  templateId?: string;

  @ApiPropertyOptional()
  body?: string;

  @ApiPropertyOptional()
  conversationId?: string;

  @ApiPropertyOptional({ enum: ['', 'lead', 'contact', 'deal', 'ticket'] })
  linkedEntityType?: LinkedCrmEntityType;

  @ApiPropertyOptional()
  linkedEntityId?: string;

  @ApiPropertyOptional()
  overrides?: Record<string, string>;
}

export class StartConversationSwaggerDto {
  @ApiPropertyOptional({ enum: ['', 'lead', 'contact', 'deal', 'ticket'] })
  linkedEntityType?: LinkedCrmEntityType;

  @ApiPropertyOptional()
  linkedEntityId?: string;

  @ApiPropertyOptional()
  contactName?: string;

  @ApiPropertyOptional()
  company?: string;

  @ApiPropertyOptional()
  phone?: string;

  @ApiPropertyOptional()
  city?: string;

  @ApiPropertyOptional()
  estimatedValue?: number;

  @ApiPropertyOptional({ enum: ['whatsapp', 'indiamart', 'email'], default: 'whatsapp' })
  channel?: 'whatsapp' | 'indiamart' | 'email';

  @ApiPropertyOptional()
  initialMessage?: string;

  @ApiPropertyOptional()
  templateId?: string;

  @ApiPropertyOptional({ enum: ['inbox', 'wa_me'], default: 'inbox' })
  via?: 'inbox' | 'wa_me';

  @ApiPropertyOptional({ default: false })
  isAiDrafted?: boolean;

  @ApiPropertyOptional({ default: true })
  logToTimeline?: boolean;

  @ApiPropertyOptional({ enum: ['text', 'meta_template'], default: 'text' })
  sendMode?: 'text' | 'meta_template';

  @ApiPropertyOptional()
  metaTemplate?: {
    name: string;
    languageCode?: string;
    bodyParams?: string[];
  };

  @ApiPropertyOptional()
  attachment?: ChatAttachment;
}

export class LinkConversationEntitySwaggerDto {
  @ApiProperty({ enum: ['', 'lead', 'contact', 'deal', 'ticket'] })
  linkedEntityType!: LinkedCrmEntityType;

  @ApiPropertyOptional()
  linkedEntityId?: string;
}

export class UpdateWhatsAppConfigSwaggerDto {
  @ApiPropertyOptional()
  enabled?: boolean;

  @ApiPropertyOptional({ example: '123456789012345' })
  phoneNumberId?: string;

  @ApiPropertyOptional({ example: '987654321098765' })
  wabaId?: string;

  @ApiPropertyOptional()
  accessToken?: string;

  @ApiPropertyOptional()
  appSecret?: string;

  @ApiPropertyOptional()
  verifyToken?: string;

  @ApiPropertyOptional()
  clearAccessToken?: boolean;

  @ApiPropertyOptional()
  clearAppSecret?: boolean;
}

export class UpdateAiAgentConfigSwaggerDto {
  @ApiPropertyOptional({ enum: ['autopilot', 'draft_only', 'off'], example: 'autopilot' })
  mode?: 'autopilot' | 'draft_only' | 'off';

  @ApiPropertyOptional({ enum: ['auto', 'hinglish', 'english', 'hindi'], example: 'auto' })
  language?: 'auto' | 'hinglish' | 'english' | 'hindi';

  @ApiPropertyOptional({ example: 10 })
  maxDiscountPct?: number;

  @ApiPropertyOptional({ example: 80 })
  handoffScoreThreshold?: number;

  @ApiPropertyOptional({ default: true })
  autoSendCatalogPricing?: boolean;

  @ApiPropertyOptional({ default: true })
  autoUpdateLeadFields?: boolean;

  @ApiPropertyOptional({ default: true })
  autoShareBookingLink?: boolean;

  @ApiPropertyOptional({ default: false })
  businessHoursOnly?: boolean;

  @ApiPropertyOptional({
    type: [String],
    example: ['human', 'manager', 'call back', 'discount'],
  })
  escalationKeywords?: string[];
}

export class ToggleAutopilotSwaggerDto {
  @ApiProperty({ example: false })
  paused!: boolean;
}

export class SimulateInboundSwaggerDto {
  @ApiProperty({
    example: 'Namaste, 500 switch ka rate kya hai Gurugram ke liye? GSTIN 06AABCU9603R1ZM',
  })
  message!: string;
}

export class UpsertAiKnowledgeSwaggerDto {
  @ApiProperty({ example: 'Warranty & Replacement Guarantee' })
  title!: string;

  @ApiPropertyOptional({
    enum: [
      'pricing_terms',
      'product_spec',
      'warranty_returns',
      'shipping_dispatch',
      'company_faq',
      'custom_sop',
    ],
    default: 'company_faq',
  })
  category?: AiKnowledgeCategory;

  @ApiProperty({
    example: '18 Months standard replacement warranty with 48-hour resolution.',
  })
  content!: string;

  @ApiPropertyOptional({ type: [String], example: ['warranty', 'replacement'] })
  tags?: string[];

  @ApiPropertyOptional({ default: true })
  isActive?: boolean;
}

@ApiTags('6. Unified WhatsApp & AI Inbox')
@ApiBearerAuth('access-token')
@Controller('inbox')
export class InboxController {
  constructor(private readonly inboxService: InboxService) {}

  @Get()
  @ApiOperation({
    summary:
      'List all WhatsApp & IndiaMART buyer conversations with SetuAI summaries',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['all', 'open', 'resolved'],
    description: 'Filter threads by resolution status',
  })
  @ApiQuery({
    name: 'channel',
    required: false,
    enum: ['all', 'whatsapp', 'indiamart', 'email'],
    description: 'Filter threads by channel',
  })
  @ApiQuery({
    name: 'search',
    required: false,
    description: 'Search by buyer name, company, or phone',
  })
  @ApiResponse({
    status: 200,
    description: 'Returns `{ data: Conversation[] }`.',
  })
  async findAll(
    @Headers('authorization') authorization: string | undefined,
    @Query() query: { status?: string; channel?: string; search?: string },
  ) {
    const auth = await this.inboxService.verifyAuth(authorization);
    return this.inboxService.findAll(auth, query);
  }

  @Get('whatsapp-config')
  @ApiOperation({
    summary: 'Get per-tenant Official Meta WhatsApp Cloud API credentials & webhook status',
  })
  async getWhatsAppConfig(
    @Headers('authorization') authorization: string | undefined,
  ) {
    const auth = await this.inboxService.verifyAuth(authorization);
    return this.inboxService.getWhatsAppConfig(auth);
  }

  @Get('ai-agent/config')
  @ApiOperation({
    summary: 'Get 24x7 Autonomous AI WhatsApp Sales Concierge & Discount Guardrail configuration',
  })
  async getAiAgentConfig(
    @Headers('authorization') authorization: string | undefined,
  ) {
    const auth = await this.inboxService.verifyAuth(authorization);
    return this.inboxService.getAiAgentConfig(auth);
  }

  @Patch('ai-agent/config')
  @ApiOperation({
    summary: 'Configure Autonomous 24x7 AI Sales Concierge mode (autopilot / draft_only / off), discount caps & handoff score',
  })
  @ApiBody({ type: UpdateAiAgentConfigSwaggerDto })
  async updateAiAgentConfig(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: UpdateAiAgentConfigSwaggerDto,
  ) {
    const auth = await this.inboxService.verifyAuth(authorization);
    return this.inboxService.updateAiAgentConfig(auth, body);
  }

  @Get('bot-flow')
  @ApiOperation({
    summary: 'Get WhatsApp Interactive Multi-Step Button & List Menu Bot Flow configuration',
  })
  async getBotFlowConfig(
    @Headers('authorization') authorization: string | undefined,
  ) {
    const auth = await this.inboxService.verifyAuth(authorization);
    return this.inboxService.getBotFlowConfig(auth);
  }

  @Patch('bot-flow')
  @ApiOperation({
    summary: 'Save WhatsApp Interactive Multi-Step Bot Flow (English/Hindi/Hinglish buttons & routing)',
  })
  async updateBotFlowConfig(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: Record<string, unknown>,
  ) {
    const auth = await this.inboxService.verifyAuth(authorization);
    return this.inboxService.updateBotFlowConfig(auth, body);
  }

  @Post('bot-flow/reset-defaults')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reset WhatsApp Interactive Bot Flow branches to starter English/Hindi/Hinglish presets',
  })
  async resetBotFlowConfig(
    @Headers('authorization') authorization: string | undefined,
  ) {
    const auth = await this.inboxService.verifyAuth(authorization);
    return this.inboxService.resetBotFlowConfig(auth);
  }

  @Post('bot-flow/simulate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Simulate a multi-step WhatsApp Interactive Bot turn against live catalog/booking/invoice CRM data',
  })
  async simulateBotFlowStep(
    @Headers('authorization') authorization: string | undefined,
    @Body()
    body: {
      message?: string;
      interactiveOptionId?: string;
      language?: 'english' | 'hindi' | 'hinglish';
      session?: Record<string, unknown>;
      buyerName?: string;
      buyerPhone?: string;
      draftConfig?: Record<string, unknown>;
    },
  ) {
    const auth = await this.inboxService.verifyAuth(authorization);
    return this.inboxService.simulateBotFlowStep(auth, body as never);
  }

  @Get('ai-knowledge')
  @ApiOperation({
    summary: 'List workspace AI Knowledge Base (RAG FAQs, policies & synced SKUs)',
  })
  async listKnowledgeBase(
    @Headers('authorization') authorization: string | undefined,
    @Query('search') search?: string,
    @Query('category') category?: string,
  ) {
    const auth = await this.inboxService.verifyAuth(authorization);
    return this.inboxService.listKnowledgeBase(auth, { search, category });
  }

  @Post('ai-knowledge')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Add a custom FAQ, warranty/shipping policy, or pricing SOP to AI Knowledge Base',
  })
  @ApiBody({ type: UpsertAiKnowledgeSwaggerDto })
  async createKnowledgeEntry(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: UpsertAiKnowledgeSwaggerDto,
  ) {
    const auth = await this.inboxService.verifyAuth(authorization);
    return this.inboxService.createKnowledgeEntry(auth, body);
  }

  @Post('ai-knowledge/seed-defaults')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '1-click seed B2B/D2C Indian Starter FAQs (Warranty, Dispatch, GST, Payments, Demo)',
  })
  async seedStarterKnowledge(
    @Headers('authorization') authorization: string | undefined,
  ) {
    const auth = await this.inboxService.verifyAuth(authorization);
    return this.inboxService.seedStarterKnowledgeBase(auth);
  }

  @Post('ai-knowledge/sync-catalog')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Sync active /products catalog SKUs cleanly into AI Knowledge Base',
  })
  async syncCatalogKnowledge(
    @Headers('authorization') authorization: string | undefined,
  ) {
    const auth = await this.inboxService.verifyAuth(authorization);
    return this.inboxService.syncCatalogToKnowledgeBase(auth);
  }

  @Patch('ai-knowledge/:entryId')
  @ApiOperation({ summary: 'Update an AI Knowledge Base entry' })
  async updateKnowledgeEntry(
    @Headers('authorization') authorization: string | undefined,
    @Param('entryId') entryId: string,
    @Body() body: Partial<UpsertAiKnowledgeSwaggerDto>,
  ) {
    const auth = await this.inboxService.verifyAuth(authorization);
    return this.inboxService.updateKnowledgeEntry(auth, entryId, body);
  }

  @Delete('ai-knowledge/:entryId')
  @ApiOperation({ summary: 'Delete an AI Knowledge Base entry' })
  async deleteKnowledgeEntry(
    @Headers('authorization') authorization: string | undefined,
    @Param('entryId') entryId: string,
  ) {
    const auth = await this.inboxService.verifyAuth(authorization);
    return this.inboxService.deleteKnowledgeEntry(auth, entryId);
  }

  @Patch('whatsapp-config')
  @ApiOperation({
    summary: 'Save or update per-tenant Meta WhatsApp Cloud API credentials (Owner/Admin only)',
  })
  @ApiBody({ type: UpdateWhatsAppConfigSwaggerDto })
  async updateWhatsAppConfig(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: UpdateWhatsAppConfigSwaggerDto,
  ) {
    const auth = await this.inboxService.verifyAuth(authorization);
    return this.inboxService.updateWhatsAppConfig(auth, body);
  }

  @Post('whatsapp-config/test')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Test active WhatsApp Cloud API connection for this workspace',
  })
  @ApiBody({
    required: false,
    schema: {
      type: 'object',
      properties: {
        phoneNumberId: { type: 'string', example: '3849201948271' },
        wabaId: { type: 'string', example: '9182736450192' },
        accessToken: { type: 'string', example: 'EAAG...' },
      },
    },
  })
  async testWhatsAppConfig(
    @Headers('authorization') authorization: string | undefined,
    @Body()
    body?: { phoneNumberId?: string; wabaId?: string; accessToken?: string },
  ) {
    const auth = await this.inboxService.verifyAuth(authorization);
    return this.inboxService.testWhatsAppConfig(auth, body);
  }

  @Post('whatsapp-config/connect-number')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Connect company WhatsApp Business number using only essential business details (number + display name)',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['phoneNumber'],
      properties: {
        phoneNumber: { type: 'string', example: '+91 9811001122' },
        businessDisplayName: { type: 'string', example: 'RS Electricals Sales' },
      },
    },
  })
  async connectCompanyWhatsAppNumber(
    @Headers('authorization') authorization: string | undefined,
    @Body()
    body: {
      phoneNumber: string;
      businessDisplayName?: string;
    },
  ) {
    const auth = await this.inboxService.verifyAuth(authorization);
    return this.inboxService.connectCompanyWhatsAppNumber(auth, body);
  }

  @Post('whatsapp-config/embedded-signup')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Complete 1-click Meta Embedded Signup onboarding using Leadsetu Tech Provider app',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['code'],
      properties: {
        code: { type: 'string', example: 'AQBx91...' },
        wabaId: { type: 'string', example: '9182736450192' },
        phoneNumberId: { type: 'string', example: '3849201948271' },
        redirectUri: { type: 'string', example: 'http://localhost:3000/settings/integrations' },
      },
    },
  })
  async completeEmbeddedSignup(
    @Headers('authorization') authorization: string | undefined,
    @Body()
    body: {
      code: string;
      wabaId?: string;
      phoneNumberId?: string;
      redirectUri?: string;
    },
  ) {
    const auth = await this.inboxService.verifyAuth(authorization);
    return this.inboxService.completeEmbeddedSignup(auth, body);
  }

  @Post('whatsapp-config/use-managed')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Activate Leadsetu Managed WhatsApp Cloud Gateway on this workspace',
  })
  async activateLeadsetuManaged(
    @Headers('authorization') authorization: string | undefined,
  ) {
    const auth = await this.inboxService.verifyAuth(authorization);
    return this.inboxService.activateLeadsetuManaged(auth);
  }

  @Post('whatsapp-config/disconnect')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Disconnect workspace WhatsApp Cloud sender (falls back to CRM + wa.me)',
  })
  async disconnectWhatsApp(
    @Headers('authorization') authorization: string | undefined,
  ) {
    const auth = await this.inboxService.verifyAuth(authorization);
    return this.inboxService.disconnectWhatsApp(auth);
  }

  @Get('meta-templates')
  @ApiOperation({
    summary: 'Fetch approved WhatsApp templates from Meta WABA account',
  })
  async listMetaTemplates(
    @Headers('authorization') authorization: string | undefined,
  ) {
    const auth = await this.inboxService.verifyAuth(authorization);
    return this.inboxService.listMetaApprovedTemplates(auth);
  }

  @Get('templates')
  @ApiOperation({ summary: 'List tenant WhatsApp templates & supported variables' })
  @ApiQuery({ name: 'category', required: false, description: 'Filter by template category' })
  @ApiQuery({ name: 'search', required: false, description: 'Search template name or body' })
  @ApiQuery({ name: 'activeOnly', required: false, description: 'Pass "true" to return only active templates' })
  async listTemplates(
    @Headers('authorization') authorization: string | undefined,
    @Query() query: { category?: string; search?: string; activeOnly?: string },
  ) {
    const auth = await this.inboxService.verifyAuth(authorization);
    return this.inboxService.listTemplates(auth, query);
  }

  @Post('templates')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a custom WhatsApp template with variables' })
  @ApiBody({ type: CreateWhatsAppTemplateSwaggerDto })
  async createTemplate(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: CreateWhatsAppTemplateSwaggerDto,
  ) {
    const auth = await this.inboxService.verifyAuth(authorization);
    return this.inboxService.createTemplate(auth, body);
  }

  @Post('templates/render')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Render a WhatsApp template using CRM entity/conversation data' })
  @ApiBody({ type: RenderWhatsAppTemplateSwaggerDto })
  async renderTemplate(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: RenderWhatsAppTemplateSwaggerDto,
  ) {
    const auth = await this.inboxService.verifyAuth(authorization);
    return this.inboxService.renderTemplate(auth, body);
  }

  @Patch('templates/:templateId')
  @ApiOperation({ summary: 'Update a WhatsApp template' })
  @ApiParam({ name: 'templateId', description: 'Unique WhatsApp template ID' })
  @ApiBody({ type: UpdateWhatsAppTemplateSwaggerDto })
  async updateTemplate(
    @Headers('authorization') authorization: string | undefined,
    @Param('templateId') templateId: string,
    @Body() body: UpdateWhatsAppTemplateSwaggerDto,
  ) {
    const auth = await this.inboxService.verifyAuth(authorization);
    return this.inboxService.updateTemplate(auth, templateId, body);
  }

  @Delete('templates/:templateId')
  @ApiOperation({ summary: 'Delete a WhatsApp template' })
  @ApiParam({ name: 'templateId', description: 'Unique WhatsApp template ID' })
  async deleteTemplate(
    @Headers('authorization') authorization: string | undefined,
    @Param('templateId') templateId: string,
  ) {
    const auth = await this.inboxService.verifyAuth(authorization);
    return this.inboxService.deleteTemplate(auth, templateId);
  }

  @Get('crm-entities')
  @ApiOperation({ summary: 'List Leads, Contacts, Deals & Tickets linkable to Inbox threads' })
  @ApiQuery({ name: 'search', required: false, description: 'Filter CRM records by name, company, or phone' })
  async listCrmEntities(
    @Headers('authorization') authorization: string | undefined,
    @Query('search') search?: string,
  ) {
    const auth = await this.inboxService.verifyAuth(authorization);
    return this.inboxService.listLinkableCrmEntities(auth, search);
  }

  @Post('conversations')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Start or retrieve an Inbox conversation (optionally linked to CRM + sending initial message)',
  })
  @ApiBody({ type: StartConversationSwaggerDto })
  async startOrGetConversation(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: StartConversationSwaggerDto,
  ) {
    const auth = await this.inboxService.verifyAuth(authorization);
    return this.inboxService.startOrGetConversation(auth, body);
  }

  @Post(':id/messages')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Send an outbound message (Meta Cloud / CRM Inbox / template / attachment)',
  })
  @ApiParam({
    name: 'id',
    description: 'Unique conversation thread ID',
    example: 'thr_01a2b3c4d5e6',
  })
  @ApiBody({ type: SendInboxMessageSwaggerDto })
  @ApiResponse({ status: 201, description: 'Message appended to conversation.' })
  async sendMessage(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
    @Body() body: SendInboxMessageSwaggerDto,
  ) {
    const auth = await this.inboxService.verifyAuth(authorization);
    return this.inboxService.sendMessage(auth, id, body);
  }

  @Post(':id/read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark conversation unread count as zero' })
  @ApiParam({ name: 'id', description: 'Unique conversation thread ID' })
  async markRead(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
  ) {
    const auth = await this.inboxService.verifyAuth(authorization);
    return this.inboxService.markConversationRead(auth, id);
  }

  @Patch(':id/ai-autopilot')
  @ApiOperation({
    summary: 'Pause or resume 24x7 Autonomous AI Concierge on a specific conversation thread',
  })
  @ApiParam({ name: 'id', description: 'Unique conversation thread ID' })
  @ApiBody({ type: ToggleAutopilotSwaggerDto })
  async toggleAutopilot(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
    @Body() body: ToggleAutopilotSwaggerDto,
  ) {
    const auth = await this.inboxService.verifyAuth(authorization);
    return this.inboxService.toggleConversationAutopilot(auth, id, body.paused);
  }

  @Post(':id/simulate-inbound')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Simulate an inbound buyer WhatsApp message to trigger & test the 24x7 AI Sales Concierge live',
  })
  @ApiParam({ name: 'id', description: 'Unique conversation thread ID' })
  @ApiBody({ type: SimulateInboundSwaggerDto })
  async simulateInbound(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
    @Body() body: SimulateInboundSwaggerDto,
  ) {
    const auth = await this.inboxService.verifyAuth(authorization);
    return this.inboxService.simulateInboundMessage(auth, id, body.message);
  }

  @Post(':id/ai-assist')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Generate SetuAI Hinglish/English WhatsApp Reply Draft & Conversation Summary using thread + Products + Quotes context',
  })
  @ApiParam({ name: 'id', description: 'Unique conversation thread ID' })
  @ApiBody({
    required: false,
    schema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['both', 'reply', 'summary'], example: 'both' },
        language: { type: 'string', enum: ['hinglish', 'english', 'hindi'], example: 'hinglish' },
        tone: { type: 'string', enum: ['helpful', 'closing', 'followup'], example: 'helpful' },
        customInstruction: { type: 'string', example: 'Mention 10% bulk discount for 50+ units' },
      },
    },
  })
  async generateAiAssist(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
    @Body()
    body?: {
      mode?: 'both' | 'reply' | 'summary';
      language?: 'hinglish' | 'english' | 'hindi';
      tone?: 'helpful' | 'closing' | 'followup';
      customInstruction?: string;
    },
  ) {
    const auth = await this.inboxService.verifyAuth(authorization);
    return this.inboxService.generateAiAssistForConversation(auth, id, body);
  }

  @Patch(':id/link')
  @ApiOperation({ summary: 'Link or unlink a conversation thread to a CRM Lead, Contact, Deal, or Ticket' })
  @ApiParam({ name: 'id', description: 'Unique conversation thread ID' })
  @ApiBody({ type: LinkConversationEntitySwaggerDto })
  async linkEntity(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
    @Body() body: LinkConversationEntitySwaggerDto,
  ) {
    const auth = await this.inboxService.verifyAuth(authorization);
    return this.inboxService.linkEntity(auth, id, body);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Toggle conversation thread status (`open` or `resolved`)',
  })
  @ApiParam({
    name: 'id',
    description: 'Unique conversation thread ID',
    example: 'thr_01a2b3c4d5e6',
  })
  @ApiBody({ type: UpdateInboxStatusSwaggerDto })
  @ApiResponse({ status: 200, description: 'Conversation status updated.' })
  async updateStatus(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
    @Body() body: UpdateInboxStatusSwaggerDto,
  ) {
    const auth = await this.inboxService.verifyAuth(authorization);
    return this.inboxService.updateStatus(auth, id, body.status);
  }
}

@Module({
  imports: [
    ConfigModule,
    MongooseModule.forFeature([
      { name: ConversationThread.name, schema: ConversationThreadSchema },
      { name: WhatsAppTemplate.name, schema: WhatsAppTemplateSchema },
      { name: AiKnowledgeEntry.name, schema: AiKnowledgeEntrySchema },
      { name: Tenant.name, schema: TenantSchema },
      { name: PlatformConfig.name, schema: PlatformConfigSchema },
      { name: User.name, schema: UserSchema },
      { name: Lead.name, schema: LeadSchema },
      { name: Deal.name, schema: DealSchema },
      { name: Contact.name, schema: ContactSchema },
      { name: Ticket.name, schema: TicketSchema },
      { name: ProductItem.name, schema: ProductSchema },
      { name: Invoice.name, schema: InvoiceSchema },
    ]),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret:
          config.get<string>('JWT_SECRET') ||
          'leadsetu_super_secret_access_key_2026',
      }),
    }),
  ],
  controllers: [InboxController, WhatsAppWebhookController],
  providers: [InboxService, MetaWhatsAppService, InboxGateway],
  exports: [InboxService, MetaWhatsAppService, InboxGateway],
})
export class InboxModule {}
