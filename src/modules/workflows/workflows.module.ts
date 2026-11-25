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
import {
  WorkflowEnrollment,
  WorkflowEnrollmentSchema,
} from './schemas/workflow-enrollment.schema';

export type { WorkflowDocument } from './workflows.service';
export type { WorkflowEnrollmentDocument } from './schemas/workflow-enrollment.schema';
export type {
  WorkflowTriggerType,
  WorkflowActionType,
  WorkflowNodeKind,
  WorkflowDelayUnit,
  WorkflowConditionGuard,
  WorkflowNodeActionKind,
  WorkflowStepNodeDto,
} from './dto/workflows.dto';
export {
  Workflow,
  WorkflowSchema,
  WorkflowLogEntry,
  WorkflowLogEntrySchema,
  WorkflowEnrollment,
  WorkflowEnrollmentSchema,
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
      { name: WorkflowEnrollment.name, schema: WorkflowEnrollmentSchema },
      { name: Lead.name, schema: LeadSchema },
    ]),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret:
          config.get<string>('JWT_SECRET') ||
          'leadsetu_super_secret_access_key_2026_delhi_ncr',
        signOptions: { expiresIn: '7d' },
      }),
    }),
  ],
  controllers: [WorkflowsController],
  providers: [WorkflowsService],
  exports: [WorkflowsService],
})
export class WorkflowsModule {}
