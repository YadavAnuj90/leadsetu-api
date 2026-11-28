import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { SuperAdminService } from './super-admin.service';

@ApiTags('16. Public Careers & Applications')
@Controller('public/careers')
export class PublicCareersController {
  constructor(private readonly superAdminService: SuperAdminService) {}

  @Get('jobs')
  @ApiOperation({ summary: 'List active open career positions published by Super Admin' })
  @ApiQuery({ name: 'team', required: false })
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
