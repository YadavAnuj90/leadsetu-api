import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { CampaignsController } from './campaigns.controller';
import {
  Campaign,
  CampaignSchema,
  CampaignsService,
} from './campaigns.service';
import {
  CreateCampaignDto,
  UpdateCampaignDto,
} from './dto/campaigns.dto';

export type { CampaignDocument } from './campaigns.service';
export type {
  CampaignSegment,
  CampaignStatus,
} from './dto/campaigns.dto';
export {
  Campaign,
  CampaignSchema,
  CampaignsService,
  CampaignsController,
  CreateCampaignDto,
  UpdateCampaignDto,
};

@Module({
  imports: [
    ConfigModule,
    MongooseModule.forFeature([
      { name: Campaign.name, schema: CampaignSchema },
    ]),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret:
          config.get<string>('JWT_SECRET') ||
          'leadsetu_super_secret_access_key_2026_delhi_ncr',
      }),
    }),
  ],
  controllers: [CampaignsController],
  providers: [CampaignsService],
  exports: [CampaignsService],
})
export class CampaignsModule {}
