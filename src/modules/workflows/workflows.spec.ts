import { Types } from 'mongoose';
import { WorkflowsService } from './workflows.service';

describe('Visual Workflows & WhatsApp Drip Engine', () => {
  const tenantId = new Types.ObjectId();
  const userId = new Types.ObjectId();
  const backupUserId = new Types.ObjectId();

  const makeMocks = (opts?: { buyerReplied?: boolean; leadStatus?: string }) => {
    const insertedTasks: any[] = [];
    const insertedTickets: any[] = [];
    const leadState: any = {
      _id: new Types.ObjectId(),
      tenantId,
      ownerId: userId,
      name: 'Rajesh Sharma',
      company: 'RS Electricals Pvt Ltd',
      phone: '+919820451290',
      city: 'Noida',
      source: 'indiamart',
      status: opts?.leadStatus || 'new',
      aiScore: 85,
      estimatedValue: 250000,
      activities: [],
      markModified: jest.fn(),
      save: jest.fn().mockResolvedValue(true),
    };

    const mockWorkflowModel: any = {
      db: {
        collection: jest.fn((name: string) => {
          if (name === 'tasks') {
            return {
              insertOne: jest.fn(async (doc: any) => {
                insertedTasks.push(doc);
                return { insertedId: new Types.ObjectId() };
              }),
            };
          }
          if (name === 'tickets') {
            return {
              insertOne: jest.fn(async (doc: any) => {
                insertedTickets.push(doc);
                return { insertedId: new Types.ObjectId() };
              }),
            };
          }
          if (name === 'users') {
            return {
              find: jest.fn().mockReturnValue({
                sort: () => ({
                  toArray: jest.fn().mockResolvedValue([
                    { _id: userId, name: 'Primary Rep', role: 'agent' },
                    { _id: backupUserId, name: 'Backup Closer', role: 'manager' },
                  ]),
                }),
              }),
              findOne: jest.fn().mockResolvedValue({ _id: userId, name: 'Primary Rep' }),
            };
          }
          if (name === 'conversations') {
            return {
              findOne: jest.fn().mockResolvedValue(
                opts?.buyerReplied
                  ? {
                      messages: [
                        {
                          direction: 'inbound',
                          createdAt: new Date(Date.now() + 60_000).toISOString(),
                        },
                      ],
                    }
                  : null,
              ),
            };
          }
          return {};
        }),
      },
      find: jest.fn(),
      findById: jest.fn(),
      create: jest.fn(),
    };

    const mockEnrollmentModel: any = {
      create: jest.fn(async (doc: any) => ({
        _id: new Types.ObjectId(),
        ...doc,
        createdAt: new Date(Date.now() - 1000),
        markModified: jest.fn(),
        save: jest.fn(async function () {
          return this;
        }),
      })),
    };

    const mockLeadModel: any = {
      findById: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue(leadState),
      }),
    };

    const mockInboxService: any = {
      dispatchAutomatedWhatsApp: jest.fn().mockResolvedValue({
        skippedDnd: false,
        deliveryProvider: 'meta_cloud',
        status: 'sent',
      }),
    };

    const service = new WorkflowsService(
      mockWorkflowModel,
      mockEnrollmentModel,
      mockLeadModel,
      {} as any,
      { get: jest.fn().mockReturnValue('') } as any,
      mockInboxService,
    );

    return {
      service,
      leadState,
      insertedTasks,
      insertedTickets,
      mockInboxService,
      mockEnrollmentModel,
    };
  };

  it('schedules a 10-minute delay node on initial enrollment and then executes Hinglish WhatsApp + Backup Rep Reassign + Urgent SLA Alert when uncontacted', async () => {
    const {
      service,
      leadState,
      insertedTasks,
      insertedTickets,
      mockInboxService,
      mockEnrollmentModel,
    } = makeMocks({ leadStatus: 'new', buyerReplied: false });

    const wfDoc: any = {
      _id: new Types.ObjectId(),
      tenantId,
      name: '10m IndiaMART SLA Rescue',
      triggerType: 'lead.created',
      sourceFilter: 'indiamart',
      stopOnReply: true,
      active: true,
      runsCount: 0,
      executionLogs: [],
      markModified: jest.fn(),
      save: jest.fn().mockResolvedValue(true),
      nodes: [
        { id: 'n1', kind: 'trigger', title: 'New IndiaMART Lead' },
        {
          id: 'n2',
          kind: 'delay',
          title: 'Wait 10 Minutes',
          delayValue: 10,
          delayUnit: 'minutes',
        },
        {
          id: 'n3',
          kind: 'condition',
          title: 'If Still Uncontacted',
          conditionGuard: 'if_uncontacted',
        },
        {
          id: 'n4',
          kind: 'action',
          title: 'Send Hinglish WhatsApp',
          actionKind: 'send_whatsapp',
          language: 'hinglish',
          whatsappTemplateBody: 'Namaste {{buyer_name}} ji!',
        },
        {
          id: 'n5',
          kind: 'action',
          title: 'Reassign Backup Rep',
          actionKind: 'reassign_rep',
          reassignStrategy: 'round_robin_backup',
        },
        {
          id: 'n6',
          kind: 'action',
          title: 'Create SLA Alert',
          actionKind: 'create_sla_alert',
          slaPriority: 'urgent',
        },
      ],
    };

    // Step 1: Initial enrollment hits the 10-min delay node and pauses
    const enrollment = await mockEnrollmentModel.create({
      tenantId,
      workflowId: wfDoc._id,
      workflowName: wfDoc.name,
      leadId: leadState._id,
      leadName: leadState.name,
      leadPhone: leadState.phone,
      leadSource: 'indiamart',
      currentStepIndex: 0,
      status: 'active',
      nextRunAt: new Date(),
      stopOnReply: true,
      stepLogs: [],
    });

    const pausedEnr = await service.advanceEnrollment(enrollment, wfDoc, {
      forceSkipDelays: false,
    });

    expect(pausedEnr.status).toBe('active');
    expect(pausedEnr.currentStepIndex).toBe(1); // Paused at delay node (n2), scheduled for +10 mins
    expect(mockInboxService.dispatchAutomatedWhatsApp).not.toHaveBeenCalled();

    // Step 2: 10 minutes elapse -> advanceEnrollment runs remaining nodes
    const completedEnr = await service.advanceEnrollment(pausedEnr, wfDoc, {
      forceSkipDelays: true,
    });

    expect(completedEnr.status).toBe('completed');
    expect(mockInboxService.dispatchAutomatedWhatsApp).toHaveBeenCalledTimes(1);
    expect(leadState.ownerId).toEqual(backupUserId);
    expect(insertedTickets).toHaveLength(1);
    expect(insertedTickets[0].priority).toBe('urgent');
    expect(insertedTasks).toHaveLength(1);
  });

  it('auto-stops drip enrollment when buyer has already replied on WhatsApp', async () => {
    const { service, leadState, mockInboxService, mockEnrollmentModel } = makeMocks({
      buyerReplied: true,
    });

    const wfDoc: any = {
      _id: new Types.ObjectId(),
      tenantId,
      name: 'Hinglish Drip',
      triggerType: 'lead.created',
      stopOnReply: true,
      active: true,
      executionLogs: [],
      markModified: jest.fn(),
      save: jest.fn().mockResolvedValue(true),
      nodes: [
        {
          id: 'n1',
          kind: 'action',
          title: 'Day 1 Nudge',
          actionKind: 'send_whatsapp',
          whatsappTemplateBody: 'Follow-up!',
        },
      ],
    };

    const enrollment = await mockEnrollmentModel.create({
      tenantId,
      workflowId: wfDoc._id,
      workflowName: wfDoc.name,
      leadId: leadState._id,
      leadName: leadState.name,
      leadPhone: leadState.phone,
      currentStepIndex: 0,
      status: 'active',
      nextRunAt: new Date(),
      stopOnReply: true,
      stepLogs: [],
    });

    const stopped = await service.advanceEnrollment(enrollment, wfDoc, {
      forceSkipDelays: true,
    });

    expect(stopped.status).toBe('stopped_on_reply');
    expect(mockInboxService.dispatchAutomatedWhatsApp).not.toHaveBeenCalled();
  });
});
