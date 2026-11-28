import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import {
  BookingPublicController,
  MarketplaceSyncController,
} from './marketplace-sync.controller';
import { MarketplaceSyncService } from './marketplace-sync.service';
import { BookingSchedulerService } from './booking-scheduler.service';
import {
  BookingAppointment,
  BookingAppointmentSchema,
} from './schemas/booking-appointment.schema';
import {
  MarketplaceSyncLog,
  MarketplaceSyncLogSchema,
} from './schemas/marketplace-sync-log.schema';
import { Tenant, TenantSchema } from '../auth/schemas/tenant.schema';
import { User, UserSchema } from '../auth/schemas/user.schema';
import { Lead, LeadSchema } from '../leads/schemas/lead.schema';
import { ProductItem, ProductSchema } from '../products/products.module';
import { Ticket, TicketSchema } from '../tickets/tickets.module';
import { LeadRoutingModule } from '../lead-routing/lead-routing.module';
import { InboxModule } from '../inbox/inbox.module';

@Global()
@Module({
  imports: [
    ConfigModule,
    LeadRoutingModule,
    InboxModule,
    MongooseModule.forFeature([
      { name: MarketplaceSyncLog.name, schema: MarketplaceSyncLogSchema },
      { name: BookingAppointment.name, schema: BookingAppointmentSchema },
      { name: Tenant.name, schema: TenantSchema },
      { name: User.name, schema: UserSchema },
      { name: Lead.name, schema: LeadSchema },
      { name: ProductItem.name, schema: ProductSchema },
      { name: Ticket.name, schema: TicketSchema },
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
  controllers: [MarketplaceSyncController, BookingPublicController],
  providers: [MarketplaceSyncService, BookingSchedulerService],
  exports: [MarketplaceSyncService, BookingSchedulerService],
})
export class MarketplaceSyncModule {}
