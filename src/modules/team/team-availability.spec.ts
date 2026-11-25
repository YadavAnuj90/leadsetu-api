import { Types } from 'mongoose';
import { LeadRoutingService } from '../lead-routing/lead-routing.service';
import { TeamService } from './team.module';

describe('Rep Shift Availability & User 360 Scorecard', () => {
  const tenantId = new Types.ObjectId();
  const repOnLeaveId = new Types.ObjectId();
  const repAvailableId = new Types.ObjectId();
  const ownerId = new Types.ObjectId();

  describe('LeadRoutingService availability synchronization', () => {
    it('automatically skips reps marked on_leave or away and routes to available rep', async () => {
      const routingDoc: any = {
        _id: new Types.ObjectId(),
        tenantId,
        enabled: true,
        mode: 'round_robin',
        applyToSources: ['indiamart', 'meta_ads'],
        respectDailyCap: true,
        defaultDailyCap: 25,
        repConfigs: [
          { userId: repOnLeaveId.toString(), eligible: true, dailyCap: 25, territories: [] },
          { userId: repAvailableId.toString(), eligible: true, dailyCap: 25, territories: [] },
        ],
        rules: [],
        roundRobinCursor: 0,
        recentLogs: [],
        markModified: jest.fn(),
        save: jest.fn().mockResolvedValue(true),
      };

      const mockRoutingModel: any = {
        findOne: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue(routingDoc),
        }),
      };

      const mockLeadModel: any = {
        aggregate: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue([]),
        }),
      };

      const mockUserModel: any = {
        find: jest.fn().mockReturnValue({
          sort: () => ({
            exec: jest.fn().mockResolvedValue([
              {
                _id: repOnLeaveId,
                name: 'Rohit (On Leave)',
                email: 'rohit@co.in',
                role: 'agent',
                userCode: '1111111111',
                availabilityStatus: 'on_leave',
                isActive: true,
              },
              {
                _id: repAvailableId,
                name: 'Ananya (Available)',
                email: 'ananya@co.in',
                role: 'agent',
                userCode: '2222222222',
                availabilityStatus: 'available',
                isActive: true,
              },
            ]),
          }),
        }),
      };

      const service = new LeadRoutingService(
        mockRoutingModel,
        mockLeadModel,
        mockUserModel,
        {} as any,
        { get: jest.fn().mockReturnValue('') } as any,
      );

      const res = await service.resolveAssigneeForLead(tenantId.toString(), {
        source: 'indiamart',
        city: 'Noida',
        commit: true,
      });

      expect(res.assignedUserId).toBe(repAvailableId.toString());
      expect(res.assignedUserName).toBe('Ananya (Available)');
    });
  });

  describe('TeamService Scorecard, Availability & Session Revocation', () => {
    const makeTeamService = () => {
      const targetUser: any = {
        _id: repAvailableId,
        tenantId,
        userCode: '2222222222',
        name: 'Ananya Sharma',
        email: 'ananya@co.in',
        phone: '+919876543210',
        role: 'agent',
        isActive: true,
        twoFactorEnabled: true,
        sessionVersion: 2,
        lastLoginAt: new Date('2026-11-25T10:00:00.000Z'),
        availabilityStatus: 'available',
        shiftStart: '09:30',
        shiftEnd: '19:30',
        leaveNote: '',
        aiDailyCallLimit: 50,
        aiCallsToday: 12,
        aiCallsDayKey: new Date().toISOString().slice(0, 10),
        monthlyTarget: 500000,
        save: jest.fn().mockResolvedValue(true),
        toObject() {
          return this;
        },
      };

      const ownerUser: any = {
        _id: ownerId,
        tenantId,
        userCode: '0000000001',
        name: 'Workspace Owner',
        email: 'owner@co.in',
        role: 'owner',
        isActive: true,
      };

      const tenantDoc: any = {
        _id: tenantId,
        plan: 'growth',
        featureOverrides: {},
      };

      const mockDb = {
        collection: jest.fn((colName: string) => {
          if (colName === 'leads') {
            return {
              countDocuments: jest.fn().mockResolvedValue(7),
              aggregate: jest.fn().mockReturnValue({
                toArray: jest.fn().mockResolvedValue([]),
              }),
              find: jest.fn().mockReturnValue({
                project: () => ({
                  sort: () => ({
                    limit: () => ({
                      toArray: jest.fn().mockResolvedValue([
                        {
                          createdAt: '2026-11-25T09:00:00.000Z',
                          activities: [
                            { type: 'call', createdAt: '2026-11-25T09:08:00.000Z' },
                          ],
                        },
                      ]),
                    }),
                  }),
                }),
              }),
            };
          }
          if (colName === 'audit_logs') {
            return {
              find: jest.fn().mockReturnValue({
                sort: () => ({
                  limit: () => ({
                    toArray: jest.fn().mockResolvedValue([
                      {
                        _id: new Types.ObjectId(),
                        action: 'lead.created',
                        entityType: 'lead',
                        entityLabel: 'Buyer A',
                        summary: 'Captured IndiaMART lead',
                        actorName: 'Ananya Sharma',
                        createdAt: new Date(),
                      },
                    ]),
                  }),
                }),
              }),
            };
          }
          return {
            countDocuments: jest.fn().mockResolvedValue(3),
            aggregate: jest.fn().mockReturnValue({
              toArray: jest.fn().mockResolvedValue([]),
            }),
          };
        }),
      };

      const mockUserModel: any = {
        db: mockDb,
        findOne: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue(targetUser),
        }),
      };

      const mockAuditService: any = {
        record: jest.fn().mockResolvedValue(true),
      };

      const service = new TeamService(
        mockUserModel,
        {} as any,
        {} as any,
        { get: jest.fn().mockReturnValue('') } as any,
        mockAuditService,
      );

      return { service, targetUser, ownerUser, tenantDoc, mockAuditService };
    };

    it('updates availability to on_leave while keeping CRM login active (isActive=true)', async () => {
      const { service, targetUser, ownerUser, tenantDoc, mockAuditService } =
        makeTeamService();

      const updated = await service.updateAvailability(
        { user: ownerUser, tenant: tenantDoc },
        repAvailableId.toString(),
        {
          availabilityStatus: 'on_leave',
          shiftStart: '10:00',
          shiftEnd: '18:00',
          leaveNote: 'Client factory audit',
        },
      );

      expect(updated.isActive).toBe(true);
      expect(updated.availabilityStatus).toBe('on_leave');
      expect(updated.availableForLeads).toBe(false);
      expect(targetUser.leaveNote).toBe('Client factory audit');
      expect(mockAuditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'team.availability_updated' }),
      );
    });

    it('returns User 360 Scorecard with 2FA status, lastLoginAt, AI quota, workload, SLA response speed & audit logs', async () => {
      const { service, ownerUser, tenantDoc } = makeTeamService();

      const scorecard = await service.getMemberScorecard(
        { user: ownerUser, tenant: tenantDoc },
        repAvailableId.toString(),
      );

      expect(scorecard.security.twoFactorEnabled).toBe(true);
      expect(scorecard.security.sessionVersion).toBe(2);
      expect(scorecard.member.aiCallsToday).toBe(12);
      expect(scorecard.member.aiDailyCallLimit).toBe(50);
      expect(scorecard.workload.openLeadsCount).toBe(7);
      expect(scorecard.workload.avgSlaResponseMinutes).toBe(8);
      expect(scorecard.recentAuditEvents).toHaveLength(1);
    });

    it('force-revokes member sessions by incrementing sessionVersion & clearing refreshTokenHash', async () => {
      const { service, targetUser, ownerUser, tenantDoc, mockAuditService } =
        makeTeamService();

      const res = await service.revokeMemberSessions(
        { user: ownerUser, tenant: tenantDoc },
        repAvailableId.toString(),
      );

      expect(res.success).toBe(true);
      expect(res.sessionVersion).toBe(3);
      expect(targetUser.refreshTokenHash).toBeNull();
      expect(mockAuditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'security.sessions_revoked' }),
      );
    });
  });
});
