import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { PlatformTicketsController } from './platform-tickets.controller';
import { PlatformTicketsService } from './platform-tickets.service';
import {
  PlatformTicket,
  PlatformTicketSchema,
} from './schemas/platform-ticket.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: PlatformTicket.name, schema: PlatformTicketSchema },
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
  controllers: [PlatformTicketsController],
  providers: [PlatformTicketsService],
  exports: [PlatformTicketsService],
})
export class PlatformTicketsModule {}
