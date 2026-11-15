import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import {
  Ticket,
  TicketComment,
  TicketCommentSchema,
  TicketDocument,
  TicketSchema,
  TicketsService,
} from './tickets.service';
import { TicketsController } from './tickets.controller';
import {
  AddTicketCommentDto,
  CreateTicketDto,
  TicketAuthContext,
  TicketCategory,
  TicketPriority,
  TicketStatus,
  UpdateTicketDto,
} from './dto/tickets.dto';

export {
  Ticket,
  TicketComment,
  TicketCommentSchema,
  TicketSchema,
  TicketsService,
  TicketsController,
  CreateTicketDto,
  AddTicketCommentDto,
};
export type {
  TicketDocument,
  TicketCategory,
  TicketPriority,
  TicketStatus,
  TicketAuthContext,
  UpdateTicketDto,
};

@Module({
  imports: [
    ConfigModule,
    MongooseModule.forFeature([{ name: Ticket.name, schema: TicketSchema }]),
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
  controllers: [TicketsController],
  providers: [TicketsService],
  exports: [TicketsService],
})
export class TicketsModule {}
