import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type WorkflowEnrollmentDocument = HydratedDocument<WorkflowEnrollment>;

@Schema({ _id: false })
export class WorkflowEnrollmentStepLog {
  @Prop({ required: true })
  nodeId!: string;

  @Prop({ required: true })
  kind!: 'trigger' | 'condition' | 'delay' | 'action';

  @Prop({ required: true })
  title!: string;

  @Prop({ required: true, enum: ['success', 'skipped', 'stopped', 'scheduled'] })
  status!: 'success' | 'skipped' | 'stopped' | 'scheduled';

  @Prop({ required: true })
  detail!: string;

  @Prop({ required: true })
  executedAt!: string;
}

export const WorkflowEnrollmentStepLogSchema = SchemaFactory.createForClass(
  WorkflowEnrollmentStepLog,
);

@Schema({ timestamps: true, collection: 'workflow_enrollments' })
export class WorkflowEnrollment {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Workflow', required: true, index: true })
  workflowId!: Types.ObjectId;

  @Prop({ required: true, trim: true })
  workflowName!: string;

  @Prop({ type: Types.ObjectId, ref: 'Lead', required: true, index: true })
  leadId!: Types.ObjectId;

  @Prop({ trim: true, default: '' })
  leadName!: string;

  @Prop({ trim: true, default: '' })
  leadPhone!: string;

  @Prop({ trim: true, default: '' })
  leadSource!: string;

  @Prop({ type: Number, default: 0 })
  currentStepIndex!: number;

  @Prop({
    default: 'active',
    enum: ['active', 'completed', 'stopped_on_reply', 'skipped'],
    index: true,
  })
  status!: 'active' | 'completed' | 'stopped_on_reply' | 'skipped';

  @Prop({ type: Date, default: () => new Date(), index: true })
  nextRunAt!: Date;

  @Prop({ type: Boolean, default: true })
  stopOnReply!: boolean;

  @Prop({ trim: true, default: '' })
  stopReason!: string;

  @Prop({ type: [WorkflowEnrollmentStepLogSchema], default: [] })
  stepLogs!: WorkflowEnrollmentStepLog[];
}

export const WorkflowEnrollmentSchema =
  SchemaFactory.createForClass(WorkflowEnrollment);

WorkflowEnrollmentSchema.index({ tenantId: 1, workflowId: 1, leadId: 1 });
WorkflowEnrollmentSchema.index({ status: 1, nextRunAt: 1 });
