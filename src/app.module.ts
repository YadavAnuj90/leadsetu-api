import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
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

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '.env.local'],
    }),
    MongooseModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const uri =
          configService.get<string>('MONGODB_URI') ||
          'mongodb+srv://anujalitechnologiespvtltd_db_user:kYZywctMdeib6Yaw@anujalitechno.xxdbeke.mongodb.net/leadsetu?retryWrites=true&w=majority&appName=leadsetu';
        return {
          uri,
        };
      },
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
  ],
})
export class AppModule {}
