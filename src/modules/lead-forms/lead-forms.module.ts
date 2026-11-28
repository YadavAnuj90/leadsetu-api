import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { Tenant, TenantSchema } from '../auth/schemas/tenant.schema';
import { User, UserSchema } from '../auth/schemas/user.schema';
import { Deal, DealSchema } from '../deals/schemas/deal.schema';
import { InboxModule } from '../inbox/inbox.module';
import { LeadRoutingModule } from '../lead-routing/lead-routing.module';
import { Lead, LeadSchema } from '../leads/schemas/lead.schema';
import {
  LeadFormsController,
  PublicLeadFormsController,
} from './lead-forms.controller';
import { LeadFormsService } from './lead-forms.service';
import {
  LeadForm,
  LeadFormSchema,
  LeadFormSubmission,
  LeadFormSubmissionSchema,
} from './schemas/lead-form.schema';

@Module({
  imports: [
    ConfigModule,
    LeadRoutingModule,
    InboxModule,
    MongooseModule.forFeature([
      { name: LeadForm.name, schema: LeadFormSchema },
      { name: LeadFormSubmission.name, schema: LeadFormSubmissionSchema },
      { name: Tenant.name, schema: TenantSchema },
      { name: User.name, schema: UserSchema },
      { name: Lead.name, schema: LeadSchema },
      { name: Deal.name, schema: DealSchema },
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
  controllers: [LeadFormsController, PublicLeadFormsController],
  providers: [LeadFormsService],
  exports: [LeadFormsService],
})
export class LeadFormsModule {}
