import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { AiBridgeService } from './ai-bridge.service';

@ApiExcludeController()
@Controller('internal/permissions')
export class InternalPermissionsController {
  constructor(private readonly aiBridge: AiBridgeService) {}

  @Post('check')
  @HttpCode(HttpStatus.OK)
  async checkPermission(
    @Headers('x-internal-secret') internalSecret: string | undefined,
    @Body()
    body: {
      tenantId?: string;
      userId?: string;
      task?: string;
    },
  ) {
    if (!this.aiBridge.verifyInternalSecret(internalSecret)) {
      throw new UnauthorizedException('Invalid internal secret.');
    }
    return this.aiBridge.checkInternalPermission({
      tenantId: body?.tenantId,
      userId: body?.userId,
      task: body?.task,
    });
  }
}
