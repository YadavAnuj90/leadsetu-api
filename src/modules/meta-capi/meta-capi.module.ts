import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MetaCapiController } from './meta-capi.controller';
import { MetaCapiService } from './meta-capi.service';
import {
  MetaCapiEvent,
  MetaCapiEventSchema,
} from './schemas/meta-capi-event.schema';
import { Tenant, TenantSchema } from '../auth/schemas/tenant.schema';
import { User, UserSchema } from '../auth/schemas/user.schema';
import { Lead, LeadSchema } from '../leads/schemas/lead.schema';
import { Deal, DealSchema } from '../deals/schemas/deal.schema';
import { Invoice, InvoiceSchema } from '../invoices/invoices.service';
import {
  ConversationThread,
  ConversationThreadSchema,
} from '../inbox/schemas/conversation.schema';

@Global()
@Module({
  imports: [
    ConfigModule,
    MongooseModule.forFeature([
      { name: MetaCapiEvent.name, schema: MetaCapiEventSchema },
      { name: Tenant.name, schema: TenantSchema },
      { name: User.name, schema: UserSchema },
      { name: Lead.name, schema: LeadSchema },
      { name: Deal.name, schema: DealSchema },
      { name: Invoice.name, schema: InvoiceSchema },
      { name: ConversationThread.name, schema: ConversationThreadSchema },
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
  controllers: [MetaCapiController],
  providers: [MetaCapiService],
  exports: [MetaCapiService],
})
export class MetaCapiModule {}
