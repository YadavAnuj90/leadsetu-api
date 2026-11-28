import { Body, Controller, Post, Req } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { SuperAdminService } from './super-admin.service';

@ApiTags('18. Public Contact & Demo Requests')
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
        name: { type: 'string', example: 'Rajesh Sharma' },
        company: { type: 'string', example: 'RS Electricals Pvt. Ltd.' },
        email: { type: 'string', example: 'rajesh@rselectricals.in' },
        phone: { type: 'string', example: '+91 9811002233' },
        topic: {
          type: 'string',
          example: 'Enterprise Demo & Migration',
        },
        message: {
          type: 'string',
          example: 'Looking for a 25-seat WhatsApp Cloud + GST workflow demo.',
        },
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
