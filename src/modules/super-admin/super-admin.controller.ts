import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { SuperAdminService } from './super-admin.service';
import {
  CreateSaasCouponDto,
  CreateSaasPartnerDto,
  CreateSuperAdminOperatorDto,
  ImpersonateTenantDto,
  IssueTenantSubscriptionDto,
  PartnerPayoutDto,
  UpdateDunningPolicyDto,
  UpdatePlatformPoliciesDto,
  UpdateSaasCouponDto,
  UpdateSubscriptionInvoiceStatusDto,
  UpdateTenantGovernanceDto,
  UpdateTenantUserRbacDto,
} from './dto/super-admin.dto';

function clientIp(req: Request): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.trim()) {
    return fwd.split(',')[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || '';
}

@ApiTags('15. Super Admin Platform Authority')
@ApiBearerAuth('access-token')
@Controller('super-admin')
export class SuperAdminController {
  constructor(private readonly superAdminService: SuperAdminService) {}

  @Get('bootstrap-status')
  @ApiOperation({ summary: 'Check whether Platform Super Admin Vault is initialized' })
  async getBootstrapStatus() {
    return this.superAdminService.getBootstrapStatus();
  }

  @Post('bootstrap')
  @ApiOperation({
    summary:
      'One-time Vault initialization when zero Super Admins exist (requires server Setup Key)',
  })
  async bootstrap(
    @Body()
    body: {
      name: string;
      email: string;
      password: string;
      phone?: string;
      setupKey: string;
    },
    @Req() req: Request,
  ) {
    return this.superAdminService.bootstrapInitialSuperAdmin(body, clientIp(req));
  }

  @Get('overview')
  @ApiOperation({ summary: 'Platform-wide KPI telemetry, MRR, and quota watchlist' })
  async getOverview(@Headers('authorization') authorization: string | undefined) {
    await this.superAdminService.verifySuperAdmin(authorization);
    return this.superAdminService.getOverview();
  }

  @Get('tenants')
  @ApiOperation({ summary: 'List all customer tenant workspaces with live usage' })
  async listTenants(
    @Headers('authorization') authorization: string | undefined,
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('plan') plan?: string,
  ) {
    await this.superAdminService.verifySuperAdmin(authorization);
    return this.superAdminService.listTenants({ search, status, plan });
  }

  @Get('tenants/:tenantId')
  @ApiOperation({ summary: 'Inspect full governance, RBAC members, quotas & policies for a tenant' })
  async getTenantDetail(
    @Headers('authorization') authorization: string | undefined,
    @Param('tenantId') tenantId: string,
  ) {
    await this.superAdminService.verifySuperAdmin(authorization);
    return this.superAdminService.getTenantDetail(tenantId);
  }

  @Patch('tenants/:tenantId/governance')
  @ApiOperation({
    summary:
      'Enforce plan, status, seat limits, feature overrides, quotas & security policies on a tenant',
  })
  async updateTenantGovernance(
    @Headers('authorization') authorization: string | undefined,
    @Param('tenantId') tenantId: string,
    @Body() dto: UpdateTenantGovernanceDto,
    @Req() req: Request,
  ) {
    const actor = await this.superAdminService.verifySuperAdmin(authorization);
    return this.superAdminService.updateTenantGovernance(
      actor,
      tenantId,
      dto,
      clientIp(req),
    );
  }

  @Patch('tenants/:tenantId/users/:userId')
  @ApiOperation({
    summary: 'Override RBAC role, department preset, masking, or session status for a tenant user',
  })
  async updateTenantUserRbac(
    @Headers('authorization') authorization: string | undefined,
    @Param('tenantId') tenantId: string,
    @Param('userId') userId: string,
    @Body() dto: UpdateTenantUserRbacDto,
    @Req() req: Request,
  ) {
    const actor = await this.superAdminService.verifySuperAdmin(authorization);
    return this.superAdminService.updateTenantUserRbac(
      actor,
      tenantId,
      userId,
      dto,
      clientIp(req),
    );
  }

  @Post('tenants/:tenantId/impersonate')
  @ApiOperation({
    summary: 'Start a logged, time-boxed Support Impersonation session into a tenant workspace',
  })
  async impersonateTenant(
    @Headers('authorization') authorization: string | undefined,
    @Param('tenantId') tenantId: string,
    @Body() dto: ImpersonateTenantDto,
    @Req() req: Request,
  ) {
    const actor = await this.superAdminService.verifySuperAdmin(authorization);
    return this.superAdminService.impersonateTenant(
      actor,
      tenantId,
      dto,
      clientIp(req),
    );
  }

  @Get('policies')
  @ApiOperation({ summary: 'Read Global Platform Security Policy, Plan Matrix & Kill-Switches' })
  async getPolicies(@Headers('authorization') authorization: string | undefined) {
    await this.superAdminService.verifySuperAdmin(authorization);
    return this.superAdminService.getPolicies();
  }

  @Patch('policies')
  @ApiOperation({ summary: 'Update Global Platform Security Policy, Plan Matrix & Kill-Switches' })
  async updatePolicies(
    @Headers('authorization') authorization: string | undefined,
    @Body() dto: UpdatePlatformPoliciesDto,
    @Req() req: Request,
  ) {
    const actor = await this.superAdminService.verifySuperAdmin(authorization);
    return this.superAdminService.updatePolicies(actor, dto, clientIp(req));
  }

  @Get('billing')
  @ApiOperation({ summary: 'Cross-tenant SaaS revenue, coupons, partners, dunning & 18% GST ledger' })
  async getBillingLedger(
    @Headers('authorization') authorization: string | undefined,
    @Query('month') month?: string,
  ) {
    await this.superAdminService.verifySuperAdmin(authorization);
    return this.superAdminService.getBillingLedger(month);
  }

  @Get('billing/export')
  @ApiOperation({ summary: 'Download CA-ready GSTR-1 Outward Supplies or Platform TDS CSV report' })
  async exportBillingCsv(
    @Headers('authorization') authorization: string | undefined,
    @Res({ passthrough: true }) res: Response,
    @Query('type') type?: string,
    @Query('month') month?: string,
  ) {
    await this.superAdminService.verifySuperAdmin(authorization);
    const reportType = type === 'tds' ? 'tds' : 'gstr1';
    const result = await this.superAdminService.exportBillingCsv(reportType, month);
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    return result.csv;
  }

  @Post('tenants/:tenantId/billing/grant')
  @ApiOperation({ summary: 'Upgrade plan, record offline NEFT deal, or issue complimentary GST invoice' })
  async issueTenantSubscription(
    @Headers('authorization') authorization: string | undefined,
    @Param('tenantId') tenantId: string,
    @Body() dto: IssueTenantSubscriptionDto,
    @Req() req: Request,
  ) {
    const actor = await this.superAdminService.verifySuperAdmin(authorization);
    return this.superAdminService.issueTenantSubscription(
      actor,
      tenantId,
      dto,
      clientIp(req),
    );
  }

  @Patch('tenants/:tenantId/billing/invoices/:invoiceId')
  @ApiOperation({ summary: 'Refund, void, or mark paid a workspace SaaS GST invoice' })
  async updateSubscriptionInvoiceStatus(
    @Headers('authorization') authorization: string | undefined,
    @Param('tenantId') tenantId: string,
    @Param('invoiceId') invoiceId: string,
    @Body() dto: UpdateSubscriptionInvoiceStatusDto,
    @Req() req: Request,
  ) {
    const actor = await this.superAdminService.verifySuperAdmin(authorization);
    return this.superAdminService.updateSubscriptionInvoiceStatus(
      actor,
      tenantId,
      invoiceId,
      dto,
      clientIp(req),
    );
  }

  @Post('billing/coupons')
  @ApiOperation({ summary: 'Create a SaaS promo code or annual discount coupon' })
  async createCoupon(
    @Headers('authorization') authorization: string | undefined,
    @Body() dto: CreateSaasCouponDto,
    @Req() req: Request,
  ) {
    const actor = await this.superAdminService.verifySuperAdmin(authorization);
    return this.superAdminService.createCoupon(actor, dto, clientIp(req));
  }

  @Patch('billing/coupons/:couponId')
  @ApiOperation({ summary: 'Activate, pause, or update a SaaS coupon' })
  async updateCoupon(
    @Headers('authorization') authorization: string | undefined,
    @Param('couponId') couponId: string,
    @Body() dto: UpdateSaasCouponDto,
    @Req() req: Request,
  ) {
    const actor = await this.superAdminService.verifySuperAdmin(authorization);
    return this.superAdminService.updateCoupon(actor, couponId, dto, clientIp(req));
  }

  @Post('billing/partners')
  @ApiOperation({ summary: 'Register a referral or channel partner for SaaS commissions' })
  async createPartner(
    @Headers('authorization') authorization: string | undefined,
    @Body() dto: CreateSaasPartnerDto,
    @Req() req: Request,
  ) {
    const actor = await this.superAdminService.verifySuperAdmin(authorization);
    return this.superAdminService.createPartner(actor, dto, clientIp(req));
  }

  @Post('billing/partners/:partnerId/payout')
  @ApiOperation({ summary: 'Record commission payout settlement for a channel partner' })
  async recordPartnerPayout(
    @Headers('authorization') authorization: string | undefined,
    @Param('partnerId') partnerId: string,
    @Body() dto: PartnerPayoutDto,
    @Req() req: Request,
  ) {
    const actor = await this.superAdminService.verifySuperAdmin(authorization);
    return this.superAdminService.recordPartnerPayout(
      actor,
      partnerId,
      dto,
      clientIp(req),
    );
  }

  @Patch('billing/dunning')
  @ApiOperation({ summary: 'Update auto-dunning reminder schedule, grace period & trial expiry rule' })
  async updateDunningPolicy(
    @Headers('authorization') authorization: string | undefined,
    @Body() dto: UpdateDunningPolicyDto,
    @Req() req: Request,
  ) {
    const actor = await this.superAdminService.verifySuperAdmin(authorization);
    return this.superAdminService.updateDunningPolicy(actor, dto, clientIp(req));
  }

  @Post('billing/dunning/run')
  @ApiOperation({ summary: 'Run on-demand trial expiry & auto-dunning sweep across workspaces' })
  async runDunningSweep(
    @Headers('authorization') authorization: string | undefined,
    @Req() req: Request,
  ) {
    const actor = await this.superAdminService.verifySuperAdmin(authorization);
    return this.superAdminService.runDunningSweep(actor, clientIp(req));
  }

  @Get('audit-logs')
  @ApiOperation({ summary: 'Read immutable Leadsetu HQ Platform Audit & Security Trail' })
  async getAuditLogs(
    @Headers('authorization') authorization: string | undefined,
    @Query('severity') severity?: string,
    @Query('search') search?: string,
    @Query('limit') limit?: string,
  ) {
    await this.superAdminService.verifySuperAdmin(authorization);
    return this.superAdminService.getAuditLogs({
      severity,
      search,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('operators')
  @ApiOperation({ summary: 'List all HQ Super Admin operators' })
  async listOperators(@Headers('authorization') authorization: string | undefined) {
    await this.superAdminService.verifySuperAdmin(authorization);
    return this.superAdminService.listOperators();
  }

  @Post('operators')
  @ApiOperation({ summary: 'Provision a new HQ Super Admin operator' })
  async createOperator(
    @Headers('authorization') authorization: string | undefined,
    @Body() dto: CreateSuperAdminOperatorDto,
    @Req() req: Request,
  ) {
    const actor = await this.superAdminService.verifySuperAdmin(authorization);
    return this.superAdminService.createOperator(actor, dto, clientIp(req));
  }

  @Patch('operators/:operatorId/status')
  @ApiOperation({ summary: 'Activate or deactivate another HQ Super Admin operator' })
  async toggleOperatorStatus(
    @Headers('authorization') authorization: string | undefined,
    @Param('operatorId') operatorId: string,
    @Body() body: { isActive: boolean },
    @Req() req: Request,
  ) {
    const actor = await this.superAdminService.verifySuperAdmin(authorization);
    return this.superAdminService.toggleOperatorStatus(
      actor,
      operatorId,
      Boolean(body.isActive),
      clientIp(req),
    );
  }
}
