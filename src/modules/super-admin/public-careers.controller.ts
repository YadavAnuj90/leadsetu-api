import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { SuperAdminService } from './super-admin.service';

@ApiTags('17. Public Careers & Applications')
@Controller('public/careers')
export class PublicCareersController {
  constructor(private readonly superAdminService: SuperAdminService) {}

  @Get('jobs')
  @ApiOperation({
    summary: 'List active open career positions published by Super Admin',
  })
  @ApiQuery({
    name: 'team',
    required: false,
    enum: [
      'All',
      'Engineering & AI',
      'Product & Design',
      'Growth & Success',
      'Operations & Trust',
    ],
  })
  async listPublicJobs(@Query('team') team?: string) {
    return this.superAdminService.listPublicCareerJobs(team);
  }

  @Post('apply')
  @ApiOperation({ summary: 'Submit a public job application with PDF resume' })
  @ApiBody({
    schema: {
      type: 'object',
      required: [
        'jobTitle',
        'candidateName',
        'candidateEmail',
        'candidatePhone',
        'resumeFileName',
        'resumeBase64',
      ],
      properties: {
        jobId: {
          type: 'string',
          description: 'Optional CareerJob ObjectId (omit for General Talent Pool)',
        },
        jobTitle: {
          type: 'string',
          example: 'Senior Frontend Engineer (Next.js 15 & TypeScript)',
        },
        jobTeam: { type: 'string', example: 'Engineering & AI' },
        candidateName: { type: 'string', example: 'Priya Verma' },
        candidateEmail: { type: 'string', example: 'priya@example.com' },
        candidatePhone: { type: 'string', example: '+91 9811223344' },
        noticePeriod: { type: 'string', example: 'Immediate / 15 Days' },
        portfolioUrl: {
          type: 'string',
          example: 'https://github.com/priyaverma',
        },
        coverNote: {
          type: 'string',
          example: 'Built multi-tenant Next.js 15 SaaS dashboards.',
        },
        resumeFileName: { type: 'string', example: 'priya-verma-resume.pdf' },
        resumeSizeBytes: { type: 'number', example: 245120 },
        resumeBase64: {
          type: 'string',
          description: 'Base64-encoded PDF content (max 5 MB)',
        },
      },
    },
  })
  async apply(
    @Body()
    body: {
      jobId?: string;
      jobTitle: string;
      jobTeam?: string;
      candidateName: string;
      candidateEmail: string;
      candidatePhone: string;
      noticePeriod?: string;
      portfolioUrl?: string;
      coverNote?: string;
      resumeFileName: string;
      resumeSizeBytes?: number;
      resumeBase64: string;
    },
  ) {
    return this.superAdminService.submitPublicCareerApplication(body);
  }
}
