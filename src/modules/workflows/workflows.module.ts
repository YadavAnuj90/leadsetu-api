import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { InboxModule } from '../inbox/inbox.module';
import { Lead, LeadSchema } from '../leads/schemas/lead.schema';
import { CreateWorkflowDto } from './dto/workflows.dto';
import { WorkflowsController } from './workflows.controller';
import {
  Workflow,
  WorkflowLogEntry,
  WorkflowLogEntrySchema,
  WorkflowSchema,
  WorkflowsService,
} from './workflows.service';

export type { WorkflowDocument } from './workflows.service';
export type {
  WorkflowTriggerType,
  WorkflowActionType,
} from './dto/workflows.dto';
export {
  Workflow,
  WorkflowSchema,
  WorkflowLogEntry,
  WorkflowLogEntrySchema,
  WorkflowsService,
  WorkflowsController,
  CreateWorkflowDto,
};

@Module({
  imports: [
    ConfigModule,
    InboxModule,
    MongooseModule.forFeature([
      { name: Workflow.name, schema: WorkflowSchema },
      { name: Lead.name, schema: LeadSchema },
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
  controllers: [WorkflowsController],
  providers: [WorkflowsService],
  exports: [WorkflowsService],
})
export class WorkflowsModule {}
