import { Body, Controller, Get, Headers, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { MetaCapiService } from './meta-capi.service';
import {
  SimulateCtwaInboundDto,
  TriggerManualCapiEventDto,
  UpdateMetaCapiConfigDto,
} from './dto/meta-capi.dto';

@ApiTags('Meta CAPI & CTWA Attribution')
@ApiBearerAuth()
@Controller('meta-capi')
export class MetaCapiController {
  constructor(private readonly metaCapiService: MetaCapiService) {}

  @Get()
  @ApiOperation({
    summary:
      'Get workspace Meta CAPI config, conversion event audit logs & per-ad ROAS breakdown',
  })
  getOverview(@Headers('authorization') authHeader?: string) {
    return this.metaCapiService.getConfigAndStats(authHeader);
  }

  @Patch('config')
  @ApiOperation({
    summary:
      'Update Meta Pixel / Dataset ID, CAPI System User Token (encrypted) & auto-fire toggles',
  })
  updateConfig(
    @Headers('authorization') authHeader: string | undefined,
    @Body() body: UpdateMetaCapiConfigDto,
  ) {
    return this.metaCapiService.updateConfig(authHeader, body);
  }

  @Post('simulate-ctwa')
  @ApiOperation({
    summary:
      'Simulate a Meta Click-to-WhatsApp Ad click: creates attributed Lead + Inbox thread & fires LeadSubmitted CAPI event',
  })
  simulateCtwa(
    @Headers('authorization') authHeader: string | undefined,
    @Body() body: SimulateCtwaInboundDto,
  ) {
    return this.metaCapiService.simulateCtwaClickAndLead(authHeader, body);
  }

  @Post('fire')
  @ApiOperation({
    summary:
      'Manually dispatch a Meta CAPI conversion event (LeadSubmitted, QualifiedLead, Purchase) for an entity',
  })
  fireManual(
    @Headers('authorization') authHeader: string | undefined,
    @Body() body: TriggerManualCapiEventDto,
  ) {
    return this.metaCapiService.fireManualEvent(authHeader, body);
  }

  @Post('events/:id/retry')
  @ApiOperation({
    summary: 'Retry dispatching a logged Meta CAPI conversion event',
  })
  retryEvent(
    @Headers('authorization') authHeader: string | undefined,
    @Param('id') id: string,
  ) {
    return this.metaCapiService.retryEvent(authHeader, id);
  }
}
