import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { Tenant, TenantSchema } from '../auth/schemas/tenant.schema';
import { User, UserSchema } from '../auth/schemas/user.schema';
import { Contact, ContactSchema } from '../contacts/contacts.service';
import { Deal, DealSchema } from '../deals/schemas/deal.schema';
import { InboxModule } from '../inbox/inbox.module';
import { LeadRoutingModule } from '../lead-routing/lead-routing.module';
import { Lead, LeadSchema } from '../leads/schemas/lead.schema';
import { HttpsOnlyGuard } from './https-only.guard';
import {
  UniversalWebhook,
  UniversalWebhookSchema,
} from './schemas/universal-webhook.schema';
import {
  WebhookDeliveryLog,
  WebhookDeliveryLogSchema,
} from './schemas/webhook-delivery-log.schema';
import { UniversalWebhookProcessor } from './universal-webhook.processor';
import {
  UniversalWebhookInboundController,
  UniversalWebhooksController,
} from './universal-webhooks.controller';
import { UniversalWebhooksService } from './universal-webhooks.service';

@Module({
  imports: [
    ConfigModule,
    InboxModule,
    LeadRoutingModule,
    MongooseModule.forFeature([
      { name: UniversalWebhook.name, schema: UniversalWebhookSchema },
      { name: WebhookDeliveryLog.name, schema: WebhookDeliveryLogSchema },
      { name: Lead.name, schema: LeadSchema },
      { name: Contact.name, schema: ContactSchema },
      { name: Deal.name, schema: DealSchema },
      { name: Tenant.name, schema: TenantSchema },
      { name: User.name, schema: UserSchema },
    ]),
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
  controllers: [
    UniversalWebhooksController,
    UniversalWebhookInboundController,
  ],
  providers: [
    UniversalWebhooksService,
    UniversalWebhookProcessor,
    HttpsOnlyGuard,
  ],
  exports: [UniversalWebhooksService, UniversalWebhookProcessor],
})
export class UniversalWebhooksModule {}
