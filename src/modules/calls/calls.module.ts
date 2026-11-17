import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { AuditModule } from '../audit/audit.module';
import { Tenant, TenantSchema } from '../auth/schemas/tenant.schema';
import { User, UserSchema } from '../auth/schemas/user.schema';
import { CallsController } from './calls.controller';
import { CallsGateway } from './calls.gateway';
import { CallsService } from './calls.service';
import { CallLog, CallLogSchema } from './schemas/call-log.schema';
import {
  CallTelemetrySample,
  CallTelemetrySampleSchema,
} from './schemas/call-telemetry-sample.schema';

@Module({
  imports: [
    ConfigModule,
    AuditModule,
    MongooseModule.forFeature([
      { name: CallLog.name, schema: CallLogSchema },
      { name: CallTelemetrySample.name, schema: CallTelemetrySampleSchema },
      { name: User.name, schema: UserSchema },
      { name: Tenant.name, schema: TenantSchema },
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
  controllers: [CallsController],
  providers: [CallsService, CallsGateway],
  exports: [CallsService],
})
export class CallsModule {}
