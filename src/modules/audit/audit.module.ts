import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuditController } from './audit.controller';
import { AuditLog, AuditLogDocument, AuditLogSchema, AuditService } from './audit.service';
import {
  AuditAuthContext,
  AuditEntityType,
  RecordAuditInput,
  UpdateSecuritySettingsDto,
} from './dto/audit.dto';

export {
  AuditLog,
  AuditLogSchema,
  AuditService,
  AuditController,
  UpdateSecuritySettingsDto,
};
export type {
  AuditLogDocument,
  AuditEntityType,
  RecordAuditInput,
  AuditAuthContext,
};

@Global()
@Module({
  imports: [
    ConfigModule,
    MongooseModule.forFeature([{ name: AuditLog.name, schema: AuditLogSchema }]),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret:
          config.get<string>('JWT_SECRET') ||
          'leadsetu_super_secret_access_key_2026',
      }),
    }),
  ],
  controllers: [AuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
