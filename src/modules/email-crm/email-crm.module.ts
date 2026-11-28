import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EmailCrmController } from './email-crm.controller';
import { EmailCrmService } from './email-crm.service';
import {
  EmailAccount,
  EmailAccountSchema,
} from './schemas/email-account.schema';
import {
  EmailTemplate,
  EmailTemplateSchema,
} from './schemas/email-template.schema';
import {
  EmailMessage,
  EmailMessageSchema,
} from './schemas/email-message.schema';

@Module({
  imports: [
    ConfigModule,
    MongooseModule.forFeature([
      { name: EmailAccount.name, schema: EmailAccountSchema },
      { name: EmailTemplate.name, schema: EmailTemplateSchema },
      { name: EmailMessage.name, schema: EmailMessageSchema },
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
  controllers: [EmailCrmController],
  providers: [EmailCrmService],
  exports: [EmailCrmService],
})
export class EmailCrmModule {}
