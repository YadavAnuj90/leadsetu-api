import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import type { Job } from 'bull';
import { WhatsappCallingService } from './whatsapp-calling.service';

export const WHATSAPP_CALL_POSTPROCESS_QUEUE = 'whatsapp-call-postprocess';

export interface WhatsappCallPostprocessJobData {
  callId: string;
  transcript?: string;
}

@Processor(WHATSAPP_CALL_POSTPROCESS_QUEUE)
export class WhatsappCallingProcessor {
  private readonly logger = new Logger(WhatsappCallingProcessor.name);

  constructor(private readonly callingService: WhatsappCallingService) {}

  @Process('analyze')
  async handleAnalyzeCall(job: Job<WhatsappCallPostprocessJobData>) {
    this.logger.debug(
      `Processing ${WHATSAPP_CALL_POSTPROCESS_QUEUE} job ${job.id} for call ${job.data?.callId}`,
    );
    return this.callingService.runPostCallAiJob(job.data);
  }
}
