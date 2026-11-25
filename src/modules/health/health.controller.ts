import { Controller, Get, HttpCode, HttpStatus, Res } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { HealthService } from './health.service';

@ApiTags('0. System Health & Readiness')
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  @ApiOperation({
    summary:
      'Production Health & Readiness Probe (MongoDB ping, memory, uptime, AI & Webhook readiness)',
  })
  @ApiResponse({ status: 200, description: 'Service and MongoDB are healthy.' })
  @ApiResponse({
    status: 503,
    description: 'Service is degraded (MongoDB disconnected).',
  })
  async getHealth(@Res({ passthrough: true }) res: Response) {
    const report = await this.healthService.checkHealth();
    res.status(
      report.status === 'ok'
        ? HttpStatus.OK
        : HttpStatus.SERVICE_UNAVAILABLE,
    );
    return report;
  }

  @Get('ready')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Kubernetes / Docker / Load Balancer Readiness Probe',
  })
  async getReady(@Res({ passthrough: true }) res: Response) {
    const report = await this.healthService.checkHealth();
    res.status(
      report.status === 'ok'
        ? HttpStatus.OK
        : HttpStatus.SERVICE_UNAVAILABLE,
    );
    return report;
  }
}
