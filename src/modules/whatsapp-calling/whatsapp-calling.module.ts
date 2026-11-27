import { BullModule } from '@nestjs/bull';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { Tenant, TenantSchema } from '../auth/schemas/tenant.schema';
import { User, UserSchema } from '../auth/schemas/user.schema';
import { InboxModule } from '../inbox/inbox.module';
import {
  ConversationThread,
  ConversationThreadSchema,
} from '../inbox/schemas/conversation.schema';
import { Lead, LeadSchema } from '../leads/schemas/lead.schema';
import {
  PlatformConfig,
  PlatformConfigSchema,
} from '../super-admin/schemas/platform-config.schema';
import {
  CallingWalletTransaction,
  CallingWalletTransactionSchema,
} from './schemas/calling-wallet-transaction.schema';
import {
  WhatsappCallLog,
  WhatsappCallLogSchema,
} from './schemas/whatsapp-call-log.schema';
import {
  WhatsappCallPermission,
  WhatsappCallPermissionSchema,
} from './schemas/whatsapp-call-permission.schema';
import { WhatsappCallingController } from './whatsapp-calling.controller';
import {
  WHATSAPP_CALL_POSTPROCESS_QUEUE,
  WhatsappCallingProcessor,
} from './whatsapp-calling.processor';
import { WhatsappCallingService } from './whatsapp-calling.service';

@Module({
  imports: [
    ConfigModule,
    InboxModule,
    BullModule.registerQueue({
      name: WHATSAPP_CALL_POSTPROCESS_QUEUE,
    }),
    MongooseModule.forFeature([
      {
        name: WhatsappCallPermission.name,
        schema: WhatsappCallPermissionSchema,
      },
      { name: WhatsappCallLog.name, schema: WhatsappCallLogSchema },
      {
        name: CallingWalletTransaction.name,
        schema: CallingWalletTransactionSchema,
      },
      { name: Lead.name, schema: LeadSchema },
      { name: ConversationThread.name, schema: ConversationThreadSchema },
      { name: Tenant.name, schema: TenantSchema },
      { name: User.name, schema: UserSchema },
      { name: PlatformConfig.name, schema: PlatformConfigSchema },
    ]),
  ],
  controllers: [WhatsappCallingController],
  providers: [WhatsappCallingService, WhatsappCallingProcessor],
  exports: [WhatsappCallingService],
})
export class WhatsappCallingModule {}
