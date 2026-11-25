import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { Tenant, TenantSchema } from '../auth/schemas/tenant.schema';
import { User, UserSchema } from '../auth/schemas/user.schema';
import { InboxModule } from '../inbox/inbox.module';
import { LeadRoutingModule } from '../lead-routing/lead-routing.module';
import { Lead, LeadSchema } from '../leads/schemas/lead.schema';
import {
  MetaLeadsController,
  MetaLeadsWebhookController,
} from './meta-leads.controller';
import { MetaLeadsProcessor } from './meta-leads.processor';
import { MetaLeadsService } from './meta-leads.service';
import {
  MetaPageConnection,
  MetaPageConnectionSchema,
} from './schemas/meta-page-connection.schema';

@Module({
  imports: [
    ConfigModule,
    InboxModule,
    LeadRoutingModule,
    MongooseModule.forFeature([
      { name: MetaPageConnection.name, schema: MetaPageConnectionSchema },
      { name: Lead.name, schema: LeadSchema },
      { name: Tenant.name, schema: TenantSchema },
      { name: User.name, schema: UserSchema },
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
  controllers: [MetaLeadsController, MetaLeadsWebhookController],
  providers: [MetaLeadsService, MetaLeadsProcessor],
  exports: [MetaLeadsService, MetaLeadsProcessor],
})
export class MetaLeadsModule {}
