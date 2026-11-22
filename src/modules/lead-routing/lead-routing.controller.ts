import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  SimulateLeadRoutingDto,
  UpdateLeadRoutingDto,
} from './dto/lead-routing.dto';
import { LeadRoutingService } from './lead-routing.service';

@ApiTags('2. Leads & SetuAI Scoring')
@ApiBearerAuth('access-token')
@Controller('lead-routing')
export class LeadRoutingController {
  constructor(private readonly leadRoutingService: LeadRoutingService) {}

  @Get()
  @ApiOperation({
    summary: 'Get Smart Lead Routing rules, rep pool workloads, and recent assignment log',
    description:
      'Returns workspace routing mode (`round_robin`, `territory_first`, `load_balanced`), daily caps, rep open-lead workloads, priority territory/source rules, and recent routing logs.',
  })
  @ApiResponse({ status: 200, description: 'Routing configuration returned.' })
  async getConfig(@Headers('authorization') authorization: string | undefined) {
    const auth = await this.leadRoutingService.verifyAuth(authorization);
    return this.leadRoutingService.getRoutingConfig(auth);
  }

  @Patch()
  @ApiOperation({
    summary: 'Update Smart Lead Routing mode, rep pool eligibility, daily caps & territory rules (Owner/Admin)',
    description:
      'Configures how inbound IndiaMART, Justdial, Meta Ads, Website, and API leads are distributed across active sales reps.',
  })
  @ApiBody({ type: UpdateLeadRoutingDto })
  async updateConfig(
    @Headers('authorization') authorization: string | undefined,
    @Body() dto: UpdateLeadRoutingDto,
  ) {
    const auth = await this.leadRoutingService.verifyAuth(authorization);
    return this.leadRoutingService.updateRoutingConfig(auth, dto);
  }

  @Post('simulate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Dry-run test Smart Lead Routing without creating a lead',
    description:
      'Evaluates territory rules, round-robin order, and load-balanced daily caps for a sample city/source/deal value.',
  })
  @ApiBody({ type: SimulateLeadRoutingDto })
  async simulate(
    @Headers('authorization') authorization: string | undefined,
    @Body() dto: SimulateLeadRoutingDto,
  ) {
    const auth = await this.leadRoutingService.verifyAuth(authorization);
    return this.leadRoutingService.simulateRouting(auth, dto);
  }
}
