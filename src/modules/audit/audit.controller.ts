import { Body, Controller, Get, Headers, Patch, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { UpdateSecuritySettingsDto } from './dto/audit.dto';
import { AuditService } from './audit.service';

@ApiTags('12. Security & Audit Trail')
@ApiBearerAuth('access-token')
@Controller('audit')
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get()
  @ApiOperation({
    summary:
      'List immutable workspace audit events & anti-data-leak security settings',
  })
  @ApiQuery({
    name: 'entityType',
    required: false,
    enum: [
      'all',
      'security',
      'team',
      'lead',
      'deal',
      'contact',
      'invoice',
      'ticket',
      'document',
    ],
  })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'limit', required: false, example: '60' })
  @ApiResponse({
    status: 200,
    description: 'Returns `{ security, data: AuditLog[], stats }`.',
  })
  async list(
    @Headers('authorization') authorization: string | undefined,
    @Query() query: { entityType?: string; search?: string; limit?: string },
  ) {
    const auth = await this.auditService.verifyAuth(authorization);
    return this.auditService.list(auth, query);
  }

  @Get('security')
  @ApiOperation({
    summary: 'Get workspace anti-data-leak phone masking & export controls',
  })
  async getSecurity(
    @Headers('authorization') authorization: string | undefined,
  ) {
    const auth = await this.auditService.verifyAuth(authorization);
    return this.auditService.getSecuritySettings(auth);
  }

  @Patch('security')
  @ApiOperation({
    summary:
      'Update anti-data-leak phone masking & agent export block (owner/admin only)',
  })
  @ApiBody({ type: UpdateSecuritySettingsDto })
  async updateSecurity(
    @Headers('authorization') authorization: string | undefined,
    @Body() dto: UpdateSecuritySettingsDto,
  ) {
    const auth = await this.auditService.verifyAuth(authorization);
    return this.auditService.updateSecuritySettings(auth, dto);
  }
}
