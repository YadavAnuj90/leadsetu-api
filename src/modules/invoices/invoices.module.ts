import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { InboxModule } from '../inbox/inbox.module';
import {
  CreateInvoiceDto,
  InvoiceLineItemDto,
  MarkInvoicePaidDto,
  RecordInvoicePaymentDto,
  UpdateInvoiceDto,
} from './dto/invoices.dto';
import { InvoicesController } from './invoices.controller';
import {
  Invoice,
  InvoiceLineItem,
  InvoiceLineItemSchema,
  InvoicePaymentRecord,
  InvoicePaymentRecordSchema,
  InvoiceSchema,
  InvoicesService,
} from './invoices.service';

export type { InvoiceDocument } from './invoices.service';
export {
  Invoice,
  InvoiceSchema,
  InvoiceLineItem,
  InvoiceLineItemSchema,
  InvoicePaymentRecord,
  InvoicePaymentRecordSchema,
  InvoicesService,
  InvoicesController,
  InvoiceLineItemDto,
  CreateInvoiceDto,
  UpdateInvoiceDto,
  MarkInvoicePaidDto,
  RecordInvoicePaymentDto,
};

@Module({
  imports: [
    ConfigModule,
    InboxModule,
    MongooseModule.forFeature([{ name: Invoice.name, schema: InvoiceSchema }]),
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
  controllers: [InvoicesController],
  providers: [InvoicesService],
  exports: [InvoicesService],
})
export class InvoicesModule {}
