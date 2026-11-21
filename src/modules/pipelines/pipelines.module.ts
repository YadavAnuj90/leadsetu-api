import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PipelinesController } from './pipelines.controller';
import { PipelinesService } from './pipelines.service';
import { Pipeline, PipelineSchema } from './schemas/pipeline.schema';
import { Deal, DealSchema } from '../deals/schemas/deal.schema';

@Module({
  imports: [
    ConfigModule,
    MongooseModule.forFeature([
      { name: Pipeline.name, schema: PipelineSchema },
      { name: Deal.name, schema: DealSchema },
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
  controllers: [PipelinesController],
  providers: [PipelinesService],
  exports: [PipelinesService],
})
export class PipelinesModule {}
