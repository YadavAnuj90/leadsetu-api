import { Body, Controller, Get, Headers, Patch, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { SubscribePlanDto, UpdateTenantProfileDto } from './dto/tenants.dto';
import { TenantsService } from './tenants.service';

@ApiTags('14. Workspace & Organization')
@ApiBearerAuth('access-token')
@Controller('tenants')
export class TenantsController {
  constructor(private readonly tenantsService: TenantsService) {}

  @Get('me')
  @ApiOperation({
    summary:
      'Get current workspace organization profile, seat usage, and attached subscription invoices',
  })
  @ApiResponse({ status: 200 })
  async getMe(@Headers('authorization') authorization: string | undefined) {
    const auth = await this.tenantsService.verifyAuth(authorization);
    return this.tenantsService.getCurrentTenant(auth);
  }

  @Patch('me')
  @ApiOperation({
    summary: 'Update workspace organization name, city, GSTIN & billing contact',
  })
  @ApiBody({ type: UpdateTenantProfileDto })
  async updateMe(
    @Headers('authorization') authorization: string | undefined,
    @Body() dto: UpdateTenantProfileDto,
  ) {
    const auth = await this.tenantsService.verifyAuth(authorization);
    return this.tenantsService.updateCurrentTenant(auth, dto);
  }

  @Get('me/billing')
  @ApiOperation({
    summary:
      'Get active subscription plan, Leadsetu seller GST details, and attached payment invoices',
  })
  async getBilling(@Headers('authorization') authorization: string | undefined) {
    const auth = await this.tenantsService.verifyAuth(authorization);
    return this.tenantsService.getBillingSummary(auth);
  }

  @Post('me/billing/subscribe')
  @ApiOperation({
    summary:
      'Purchase, upgrade, or renew a Leadsetu subscription plan and attach a new GST Tax Invoice PDF record',
  })
  @ApiBody({ type: SubscribePlanDto })
  async subscribe(
    @Headers('authorization') authorization: string | undefined,
    @Body() dto: SubscribePlanDto,
  ) {
    const auth = await this.tenantsService.verifyAuth(authorization);
    return this.tenantsService.subscribePlan(auth, dto);
  }

  @Get('me/topup-requests')
  @ApiOperation({
    summary: 'List AI and WhatsApp top-up requests submitted by this workspace',
  })
  async listTopupRequests(@Headers('authorization') authorization?: string) {
    const auth = await this.tenantsService.verifyAuth(authorization);
    return this.tenantsService.listTopupRequests(auth);
  }

  @Post('me/topup-requests')
  @ApiOperation({
    summary: 'Request an AI or WhatsApp quota top-up from Leadsetu Super Admin',
    description: 'Submits a manual quota top-up approval request visible in the Super Admin queue.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['resource', 'quantity'],
      properties: {
        resource: { type: 'string', enum: ['ai', 'whatsapp'], example: 'ai' },
        quantity: { type: 'number', example: 1000 },
        note: { type: 'string', example: 'Month-end sales campaign volume' },
      },
    },
  })
  async createTopupRequest(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: { resource: 'ai' | 'whatsapp'; quantity: number; note?: string },
  ) {
    const auth = await this.tenantsService.verifyAuth(authorization);
    return this.tenantsService.createTopupRequest(auth, body);
  }
}
