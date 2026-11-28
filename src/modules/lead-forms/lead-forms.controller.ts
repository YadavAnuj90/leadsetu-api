import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { LeadFormsService } from './lead-forms.service';
import type { LeadForm } from './schemas/lead-form.schema';

@ApiTags('Leadsetu Instant Forms (Builder)')
@ApiBearerAuth()
@Controller('lead-forms')
export class LeadFormsController {
  constructor(private readonly leadFormsService: LeadFormsService) {}

  @Get()
  @ApiOperation({ summary: 'List workspace Instant Forms with live funnel & won revenue' })
  listForms(@Headers('authorization') authHeader?: string) {
    return this.leadFormsService.listForms(authHeader);
  }

  @Get(':idOrSlug/submissions')
  @ApiOperation({
    summary: 'List form submissions with UTM attribution, SetuAI score, and linked Lead / Deal IDs',
  })
  getFormSubmissions(
    @Headers('authorization') authHeader: string | undefined,
    @Param('idOrSlug') idOrSlug: string,
  ) {
    return this.leadFormsService.getFormSubmissions(authHeader, idOrSlug);
  }

  @Get(':idOrSlug')
  @ApiOperation({ summary: 'Get single Instant Form by ID or slug' })
  getForm(
    @Headers('authorization') authHeader: string | undefined,
    @Param('idOrSlug') idOrSlug: string,
  ) {
    return this.leadFormsService.getForm(authHeader, idOrSlug);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new Instant Form' })
  createForm(
    @Headers('authorization') authHeader: string | undefined,
    @Body() body: Partial<LeadForm>,
  ) {
    return this.leadFormsService.createForm(authHeader, body);
  }

  @Patch(':idOrSlug')
  @ApiOperation({ summary: 'Update Instant Form design, steps, OTP, Thank-You or automation' })
  updateForm(
    @Headers('authorization') authHeader: string | undefined,
    @Param('idOrSlug') idOrSlug: string,
    @Body() body: Partial<LeadForm>,
  ) {
    return this.leadFormsService.updateForm(authHeader, idOrSlug, body);
  }

  @Post(':idOrSlug/duplicate')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Duplicate an Instant Form into a new draft' })
  duplicateForm(
    @Headers('authorization') authHeader: string | undefined,
    @Param('idOrSlug') idOrSlug: string,
  ) {
    return this.leadFormsService.duplicateForm(authHeader, idOrSlug);
  }

  @Delete(':idOrSlug')
  @ApiOperation({ summary: 'Delete an Instant Form' })
  deleteForm(
    @Headers('authorization') authHeader: string | undefined,
    @Param('idOrSlug') idOrSlug: string,
  ) {
    return this.leadFormsService.deleteForm(authHeader, idOrSlug);
  }
}

@ApiTags('Public Instant Forms (/f/[slug])')
@Controller('public/forms')
export class PublicLeadFormsController {
  constructor(private readonly leadFormsService: LeadFormsService) {}

  @Get(':slug')
  @ApiOperation({ summary: 'Fetch public Instant Form config and increment views counter' })
  getPublicForm(
    @Param('slug') slug: string,
    @Query('track') track?: string,
  ) {
    return this.leadFormsService.getPublicForm(slug, track !== '0');
  }

  @Post(':slug/start')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Increment form start telemetry counter' })
  trackStart(@Param('slug') slug: string) {
    return this.leadFormsService.trackPublicStart(slug);
  }

  @Post(':slug/otp')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Send 4-digit WhatsApp verification OTP code' })
  requestOtp(
    @Param('slug') slug: string,
    @Body() body: { phone: string; name?: string },
  ) {
    return this.leadFormsService.requestPublicOtp(slug, body);
  }

  @Post(':slug/verify-otp')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify 4-digit WhatsApp OTP code' })
  verifyOtp(
    @Param('slug') slug: string,
    @Body() body: { phone: string; code: string },
  ) {
    return this.leadFormsService.verifyPublicOtp(slug, body);
  }

  @Post(':slug/submit')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Submit Instant Form: deduplicate lead, score with SetuAI, route rep, dispatch WhatsApp welcome & fire Meta CAPI',
  })
  submitForm(
    @Param('slug') slug: string,
    @Body()
    body: {
      answers?: Record<string, string>;
      otpCode?: string;
      utmSource?: string;
      utmMedium?: string;
      utmCampaign?: string;
      referrer?: string;
      _hp?: string;
    },
  ) {
    return this.leadFormsService.submitPublicForm(slug, body);
  }

  @Get(':slug/widget.js')
  @Header('Content-Type', 'application/javascript; charset=utf-8')
  @ApiOperation({ summary: 'Serve embeddable floating button / popup widget script' })
  getWidgetScript(@Param('slug') slug: string, @Req() req: Request) {
    const originHeader = String(req.headers.origin || '').trim();
    const frontendOrigin =
      originHeader ||
      process.env.FRONTEND_URL ||
      'http://localhost:3000';
    return this.leadFormsService.buildWidgetScript(slug, frontendOrigin);
  }
}
