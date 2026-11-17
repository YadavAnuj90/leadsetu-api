import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { MongooseModule } from '@nestjs/mongoose';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { User, UserSchema } from '../auth/schemas/user.schema';
import { Tenant, TenantSchema } from '../auth/schemas/tenant.schema';
import {
  PlatformAuditLog,
  PlatformAuditLogSchema,
  PlatformConfig,
  PlatformConfigSchema,
  SaasCoupon,
  SaasCouponSchema,
  SaasPartner,
  SaasPartnerSchema,
} from './schemas/platform-config.schema';
import { SuperAdminService } from './super-admin.service';
import { SuperAdminController } from './super-admin.controller';
import { TenantSecurityGuard } from './tenant-security.guard';

@Global()
@Module({
  imports: [
    ConfigModule,
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: Tenant.name, schema: TenantSchema },
      { name: PlatformConfig.name, schema: PlatformConfigSchema },
      { name: PlatformAuditLog.name, schema: PlatformAuditLogSchema },
      { name: SaasCoupon.name, schema: SaasCouponSchema },
      { name: SaasPartner.name, schema: SaasPartnerSchema },
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
  controllers: [SuperAdminController],
  providers: [
    SuperAdminService,
    {
      provide: APP_GUARD,
      useClass: TenantSecurityGuard,
    },
  ],
  exports: [SuperAdminService],
})
export class SuperAdminModule {}
