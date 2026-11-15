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
}
