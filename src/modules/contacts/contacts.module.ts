import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ContactsController } from './contacts.controller';
import {
  Contact,
  ContactDocument,
  ContactSchema,
  ContactsService,
} from './contacts.service';
import { CreateContactDto, UpdateContactDto } from './dto/contacts.dto';
import { CustomFieldsModule } from '../custom-fields/custom-fields.module';

export {
  Contact,
  ContactSchema,
  ContactsService,
  ContactsController,
  CreateContactDto,
  UpdateContactDto,
};
export type { ContactDocument };

@Module({
  imports: [
    ConfigModule,
    CustomFieldsModule,
    MongooseModule.forFeature([{ name: Contact.name, schema: ContactSchema }]),
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
  controllers: [ContactsController],
  providers: [ContactsService],
  exports: [ContactsService],
})
export class ContactsModule {}
