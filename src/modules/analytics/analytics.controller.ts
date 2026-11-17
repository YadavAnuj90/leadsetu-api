import {
  Controller,
  Get,
  Headers,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AnalyticsService } from './analytics.service';

@ApiTags('11. Real-Time Analytics & Command Center')
@ApiBearerAuth('access-token')
@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Get('overview')
  @ApiOperation({
    summary:
      'Get real-time cross-collection CRM analytics (Leads, Deals, GST Invoices, WhatsApp Campaigns, Workflows, Tickets & Rep Leaderboard)',
  })
  @ApiQuery({ name: 'range', required: false, example: 'all' })
  @ApiResponse({
    status: 200,
    description:
      'Returns full cross-module workspace analytics including trend, AI tiers, Udhaar aging, and rep leaderboard.',
  })
  async getOverview(
    @Headers('authorization') authorization: string | undefined,
    @Query('range') range?: string,
  ) {
    const auth = await this.analyticsService.verifyAuth(authorization);
    return this.analyticsService.getOverview(auth, range || 'all');
  }

  @Get('search')
  @ApiOperation({
    summary:
      'Global Ctrl+K Command Search across Leads, Contacts, Deals, GST Invoices, Tasks & Tickets',
  })
  @ApiQuery({ name: 'q', required: false, example: 'Rajesh' })
  async globalSearch(
    @Headers('authorization') authorization: string | undefined,
    @Query('q') q?: string,
  ) {
    const auth = await this.analyticsService.verifyAuth(authorization);
    return this.analyticsService.globalSearch(auth, q);
  }

  @Get('notifications')
  @ApiOperation({
    summary:
      'Get live Notification Bell alerts (Hot Leads, Unpaid GST Invoices, Follow-up Tasks, Inbox & Tickets)',
  })
  async getNotifications(
    @Headers('authorization') authorization: string | undefined,
  ) {
    const auth = await this.analyticsService.verifyAuth(authorization);
    return this.analyticsService.getNotifications(auth);
  }
}
