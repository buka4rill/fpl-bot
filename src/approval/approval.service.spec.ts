import { Test, TestingModule } from '@nestjs/testing';
import { ApprovalService } from './approval.service';
import { ApprovalStateMachine } from './approval.state-machine';
import { ProposalService } from '../proposal/proposal.service';
import { ExecutionService } from '../execution/execution.service';
import { AlertService } from '../alert/alert.service';
import { Proposal } from '../common/types/domain.types';
import { ProposalStatus } from '../common/enums/proposal-status.enum';

describe('ApprovalService', () => {
  let service: ApprovalService;
  let proposalService: {
    findById: jest.Mock;
    findAllPending: jest.Mock;
    updateStatus: jest.Mock;
  };
  let executionService: { apply: jest.Mock };
  let alertService: { sendExecutionResult: jest.Mock };

  const baseProposal = (overrides: Partial<Proposal> = {}): Proposal => ({
    id: 'p1',
    gameweekId: 4,
    deadlineAt: '2099-01-01T00:00:00Z', // far future — not overdue
    transfers: [],
    lineup: [],
    benchGoalkeeperId: 12,
    benchOutfieldIds: [13, 14, 15],
    captainId: 1,
    viceCaptainId: 2,
    expectedGain: 10,
    hitCost: 0,
    status: ProposalStatus.PENDING,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  });

  beforeEach(async () => {
    proposalService = {
      findById: jest.fn(),
      findAllPending: jest.fn().mockReturnValue([]),
      updateStatus: jest
        .fn()
        .mockImplementation((id: string, status: ProposalStatus) =>
          baseProposal({ id, status }),
        ),
    };
    executionService = {
      apply: jest.fn().mockResolvedValue({ success: true }),
    };
    alertService = {
      sendExecutionResult: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ApprovalService,
        ApprovalStateMachine,
        { provide: ProposalService, useValue: proposalService },
        { provide: ExecutionService, useValue: executionService },
        { provide: AlertService, useValue: alertService },
      ],
    }).compile();

    service = module.get<ApprovalService>(ApprovalService);
  });

  describe('decide', () => {
    it('approves a PENDING proposal before the deadline', async () => {
      proposalService.findById.mockReturnValue(baseProposal());

      const approval = await service.decide(
        'p1',
        ProposalStatus.APPROVED,
        'user1',
      );

      expect(proposalService.updateStatus).toHaveBeenCalledWith(
        'p1',
        ProposalStatus.APPROVED,
      );
      expect(approval.proposalId).toBe('p1');
      expect(approval.decision).toBe(ProposalStatus.APPROVED);
      expect(approval.decidedBy).toBe('user1');
      expect(approval.decidedAt).toBeTruthy();
    });

    it('triggers execution and a success alert once approved', async () => {
      proposalService.findById.mockReturnValue(baseProposal());

      await service.decide('p1', ProposalStatus.APPROVED, 'user1');

      expect(executionService.apply).toHaveBeenCalled();
      expect(alertService.sendExecutionResult).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'p1' }),
        true,
      );
    });

    it('alerts loudly instead of throwing when execution fails', async () => {
      proposalService.findById.mockReturnValue(baseProposal());
      executionService.apply.mockRejectedValue(new Error('FPL API down'));

      const approval = await service.decide(
        'p1',
        ProposalStatus.APPROVED,
        'user1',
      );

      expect(approval.decision).toBe(ProposalStatus.APPROVED);
      expect(alertService.sendExecutionResult).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'p1' }),
        false,
        expect.stringContaining('FPL API down'),
      );
    });

    it('rejects a PENDING proposal before the deadline', async () => {
      proposalService.findById.mockReturnValue(baseProposal());

      await service.decide('p1', ProposalStatus.REJECTED, 'user1');

      expect(proposalService.updateStatus).toHaveBeenCalledWith(
        'p1',
        ProposalStatus.REJECTED,
      );
      expect(executionService.apply).not.toHaveBeenCalled();
    });

    it('throws for an unknown proposal', async () => {
      proposalService.findById.mockReturnValue(undefined);

      await expect(
        service.decide('missing', ProposalStatus.APPROVED, 'user1'),
      ).rejects.toThrow('No proposal found');
    });

    it('expires (not approves) a reply that arrives after the deadline', async () => {
      proposalService.findById.mockReturnValue(
        baseProposal({ deadlineAt: '2000-01-01T00:00:00Z' }),
      );

      await expect(
        service.decide('p1', ProposalStatus.APPROVED, 'user1'),
      ).rejects.toThrow('Deadline has already passed');

      expect(proposalService.updateStatus).toHaveBeenCalledWith(
        'p1',
        ProposalStatus.EXPIRED,
      );
      expect(proposalService.updateStatus).not.toHaveBeenCalledWith(
        'p1',
        ProposalStatus.APPROVED,
      );
    });

    it('refuses to re-decide an already-terminal proposal', async () => {
      proposalService.findById.mockReturnValue(
        baseProposal({ status: ProposalStatus.APPROVED }),
      );

      await expect(
        service.decide('p1', ProposalStatus.REJECTED, 'user1'),
      ).rejects.toThrow('Cannot transition');
    });
  });

  describe('expire', () => {
    it('moves a PENDING proposal to EXPIRED', () => {
      proposalService.findById.mockReturnValue(baseProposal());

      service.expire('p1');

      expect(proposalService.updateStatus).toHaveBeenCalledWith(
        'p1',
        ProposalStatus.EXPIRED,
      );
    });

    it('is a no-op for an unknown proposal', () => {
      proposalService.findById.mockReturnValue(undefined);

      expect(() => service.expire('missing')).not.toThrow();
      expect(proposalService.updateStatus).not.toHaveBeenCalled();
    });

    it('is a no-op for an already-terminal proposal', () => {
      proposalService.findById.mockReturnValue(
        baseProposal({ status: ProposalStatus.REJECTED }),
      );

      service.expire('p1');

      expect(proposalService.updateStatus).not.toHaveBeenCalled();
    });
  });

  describe('expireOverdue', () => {
    it('expires only PENDING proposals past their deadline', () => {
      const overdue = baseProposal({
        id: 'overdue',
        deadlineAt: '2000-01-01T00:00:00Z',
      });
      const notYetDue = baseProposal({ id: 'not-due' });
      proposalService.findAllPending.mockReturnValue([overdue, notYetDue]);
      proposalService.findById.mockImplementation((id: string) =>
        [overdue, notYetDue].find((p) => p.id === id),
      );

      service.expireOverdue();

      expect(proposalService.updateStatus).toHaveBeenCalledWith(
        'overdue',
        ProposalStatus.EXPIRED,
      );
      expect(proposalService.updateStatus).not.toHaveBeenCalledWith(
        'not-due',
        expect.anything(),
      );
    });
  });
});
