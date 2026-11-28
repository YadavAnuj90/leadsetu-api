import { Body, Controller, Post, Req } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { SuperAdminService } from './super-admin.service';

@ApiTags('17. Public Contact & Demo Requests')
@Controller('public/contact')
export class PublicContactController {
  constructor(private readonly superAdminService: SuperAdminService) {}

  @Post('inquiries')
  @ApiOperation({
    summary:
      'Submit a public sales/demo inquiry from /company/contact directly to Super Admin HQ',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['name', 'company', 'email', 'message'],
      properties: {
        name: { type: 'string' },
        company: { type: 'string' },
        email: { type: 'string' },
        phone: { type: 'string' },
        topic: { type: 'string' },
        message: { type: 'string' },
      },
    },
  })
  async submitInquiry(
    @Body()
    body: {
      name: string;
      company: string;
      email: string;
      phone?: string;
      topic?: string;
      message: string;
    },
    @Req() req: Request,
  ) {
    const fwd = req.headers['x-forwarded-for'];
    const ip =
      typeof fwd === 'string' && fwd.trim()
        ? fwd.split(',')[0].trim()
        : req.ip || req.socket?.remoteAddress || '';
    return this.superAdminService.submitPublicContactInquiry(body, ip);
  }
}
