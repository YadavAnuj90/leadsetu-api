import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LeadRoutingController } from './lead-routing.controller';
import { LeadRoutingService } from './lead-routing.service';
import {
  LeadRouting,
  LeadRoutingSchema,
} from './schemas/lead-routing.schema';
import { Lead, LeadSchema } from '../leads/schemas/lead.schema';
import { User, UserSchema } from '../auth/schemas/user.schema';

@Module({
  imports: [
    ConfigModule,
    MongooseModule.forFeature([
      { name: LeadRouting.name, schema: LeadRoutingSchema },
      { name: Lead.name, schema: LeadSchema },
      { name: User.name, schema: UserSchema },
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
  controllers: [LeadRoutingController],
  providers: [LeadRoutingService],
  exports: [LeadRoutingService],
})
export class LeadRoutingModule {}
