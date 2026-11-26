import {
  MiddlewareConsumer,
  Module,
  NestModule,
} from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { WinstonModule } from 'nest-winston';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { PlanExpiryGuard } from './common/guards/plan-expiry.guard';
import { createLeadsetuWinstonOptions } from './common/logger/winston-logger.config';
import { HttpLoggingInterceptor } from './common/logger/http-logging.interceptor';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware';
import { HealthModule } from './modules/health/health.module';
import { AuthModule } from './modules/auth/auth.module';
import { LeadsModule } from './modules/leads/leads.module';
import { DealsModule } from './modules/deals/deals.module';
import { ContactsModule } from './modules/contacts/contacts.module';
import { TasksModule } from './modules/tasks/tasks.module';
import { InboxModule } from './modules/inbox/inbox.module';
import { InvoicesModule } from './modules/invoices/invoices.module';
import { CampaignsModule } from './modules/campaigns/campaigns.module';
import { WorkflowsModule } from './modules/workflows/workflows.module';
import { TeamModule } from './modules/team/team.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { AuditModule } from './modules/audit/audit.module';
import { TicketsModule } from './modules/tickets/tickets.module';
import { ProductsModule } from './modules/products/products.module';
import { DocumentsModule } from './modules/documents/documents.module';
import { TenantsModule } from './modules/tenants/tenants.module';
import { SuperAdminModule } from './modules/super-admin/super-admin.module';
import { AiBridgeModule } from './modules/ai-bridge/ai-bridge.module';
import { CallsModule } from './modules/calls/calls.module';
import { BillingModule } from './modules/billing/billing.module';
import { PipelinesModule } from './modules/pipelines/pipelines.module';
import { CustomFieldsModule } from './modules/custom-fields/custom-fields.module';
import { LeadRoutingModule } from './modules/lead-routing/lead-routing.module';
import { EmailCrmModule } from './modules/email-crm/email-crm.module';
import { PortalModule } from './modules/portal/portal.module';
import { MetaCapiModule } from './modules/meta-capi/meta-capi.module';
import { MarketplaceSyncModule } from './modules/marketplace-sync/marketplace-sync.module';
import { MetaLeadsModule } from './modules/meta-leads/meta-leads.module';
import { UniversalWebhooksModule } from './modules/universal-webhooks/universal-webhooks.module';
import { TimelineModule } from './modules/timeline/timeline.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '.env.local'],
    }),
    WinstonModule.forRoot(createLeadsetuWinstonOptions()),
    MongooseModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const uri = configService.get<string>('MONGODB_URI')?.trim();
        if (!uri) {
          throw new Error(
            'MONGODB_URI environment variable is required. Set it in .env or host environment before starting leadsetu-api.',
          );
        }
        return {
          uri,
        };
      },
    }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret:
          config.get<string>('JWT_SECRET') ||
          'leadsetu_super_secret_access_key_2026_delhi_ncr',
      }),
    }),
    AiBridgeModule,
    AuditModule,
    AuthModule,
    LeadsModule,
    DealsModule,
    ContactsModule,
    TasksModule,
    InboxModule,
    InvoicesModule,
    CampaignsModule,
    WorkflowsModule,
    TeamModule,
    AnalyticsModule,
    TicketsModule,
    ProductsModule,
    DocumentsModule,
    TenantsModule,
    SuperAdminModule,
    CallsModule,
    BillingModule,
    PipelinesModule,
    CustomFieldsModule,
    LeadRoutingModule,
    EmailCrmModule,
    PortalModule,
    MetaCapiModule,
    MarketplaceSyncModule,
    MetaLeadsModule,
    UniversalWebhooksModule,
    TimelineModule,
    HealthModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: PlanExpiryGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: HttpLoggingInterceptor,
    },
    {
      provide: APP_FILTER,
      useClass: AllExceptionsFilter,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
