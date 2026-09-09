import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ApprovalService } from './approval.service';
import { ApprovalStateMachine } from './approval.state-machine';
import { ProposalService } from '../proposal/proposal.service';
import { ExecutionService } from '../execution/execution.service';
import { AlertService } from '../alert/alert.service';
import { Approval, Proposal } from '../common/types/domain.types';
import { ProposalStatus } from '../common/enums/proposal-status.enum';
import { FplChip } from '../common/enums/chip.enum';
import { TriggerSource } from '../common/enums/trigger-source.enum';
import { ApprovalEntity } from '../persistence/entities/approval.entity';

describe('ApprovalService', () => {
  let service: ApprovalService;
  let proposalService: {
    findById: jest.Mock;
    findAllPending: jest.Mock;
    updateStatus: jest.Mock;
    recordAppliedManually: jest.Mock;
    applyNoChipAlternative: jest.Mock;
  };
  let executionService: { apply: jest.Mock };
  let alertService: {
    sendExecutionResult: jest.Mock;
    sendAppliedCheckIn: jest.Mock;
  };
  let approvalRepository: { create: jest.Mock; save: jest.Mock };

  const baseProposal = (overrides: Partial<Proposal> = {}): Proposal => ({
    id: 'p1',
    gameweekId: 4,
    season: '26_27',
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
    source: TriggerSource.AUTO,
    ...overrides,
  });

  beforeEach(async () => {
    proposalService = {
      findById: jest.fn(),
      findAllPending: jest.fn().mockResolvedValue([]),
      updateStatus: jest
        .fn()
        .mockImplementation((id: string, status: ProposalStatus) =>
          Promise.resolve(baseProposal({ id, status })),
        ),
      recordAppliedManually: jest
        .fn()
        .mockImplementation((id: string, applied: boolean) =>
          Promise.resolve(baseProposal({ id, appliedManually: applied })),
        ),
      applyNoChipAlternative: jest.fn(),
    };
    executionService = {
      apply: jest.fn().mockResolvedValue({ success: true }),
    };
    alertService = {
      sendExecutionResult: jest.fn().mockResolvedValue(undefined),
      sendAppliedCheckIn: jest.fn().mockResolvedValue(undefined),
    };
    approvalRepository = {
      create: jest.fn((approval: Approval) => approval),
      save: jest
        .fn()
        .mockImplementation((approval) => Promise.resolve(approval)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ApprovalService,
        ApprovalStateMachine,
        { provide: ProposalService, useValue: proposalService },
        { provide: ExecutionService, useValue: executionService },
        { provide: AlertService, useValue: alertService },
        {
          provide: getRepositoryToken(ApprovalEntity),
          useValue: approvalRepository,
        },
      ],
    }).compile();

    service = module.get<ApprovalService>(ApprovalService);
  });

  describe('decide', () => {
    it('approves a PENDING proposal before the deadline', async () => {
      proposalService.findById.mockResolvedValue(baseProposal());

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

    it('persists the approval record', async () => {
      proposalService.findById.mockResolvedValue(baseProposal());

      await service.decide('p1', ProposalStatus.APPROVED, 'user1');

      expect(approvalRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          proposalId: 'p1',
          decision: ProposalStatus.APPROVED,
          decidedBy: 'user1',
        }),
      );
    });

    it('triggers execution and a success alert once approved', async () => {
      proposalService.findById.mockResolvedValue(baseProposal());

      await service.decide('p1', ProposalStatus.APPROVED, 'user1');

      expect(executionService.apply).toHaveBeenCalled();
      expect(alertService.sendExecutionResult).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'p1' }),
        true,
      );
    });

    it('alerts loudly instead of throwing when execution fails', async () => {
      proposalService.findById.mockResolvedValue(baseProposal());
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
      proposalService.findById.mockResolvedValue(baseProposal());

      await service.decide('p1', ProposalStatus.REJECTED, 'user1');

      expect(proposalService.updateStatus).toHaveBeenCalledWith(
        'p1',
        ProposalStatus.REJECTED,
      );
      expect(executionService.apply).not.toHaveBeenCalled();
    });

    it('throws for an unknown proposal', async () => {
      proposalService.findById.mockResolvedValue(undefined);

      await expect(
        service.decide('missing', ProposalStatus.APPROVED, 'user1'),
      ).rejects.toThrow('No proposal found');
    });

    it('expires (not approves) a reply that arrives after the deadline', async () => {
      proposalService.findById.mockResolvedValue(
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
      proposalService.findById.mockResolvedValue(
        baseProposal({ status: ProposalStatus.APPROVED }),
      );

      await expect(
        service.decide('p1', ProposalStatus.REJECTED, 'user1'),
      ).rejects.toThrow('Cannot transition');
    });

    describe('{ withoutChip: true }', () => {
      it('swaps in the chip-free alternative before executing', async () => {
        proposalService.findById.mockResolvedValue(
          baseProposal({ chip: FplChip.WILDCARD }),
        );
        const swapped = baseProposal({ chip: undefined, captainId: 99 });
        proposalService.applyNoChipAlternative.mockResolvedValue(swapped);
        // Simulates the real implementation: applyNoChipAlternative
        // persists the swap, so updateStatus's own fresh DB read (mocked
        // generically elsewhere in this file) picks it up here too.
        proposalService.updateStatus.mockResolvedValueOnce({
          ...swapped,
          status: ProposalStatus.APPROVED,
        });

        await service.decide('p1', ProposalStatus.APPROVED, 'user1', {
          withoutChip: true,
        });

        expect(proposalService.applyNoChipAlternative).toHaveBeenCalledWith(
          'p1',
        );
        // Execution operates on the swapped proposal, not the original
        // with-chip one.
        expect(executionService.apply).toHaveBeenCalledWith(
          expect.objectContaining({ captainId: 99, chip: undefined }),
        );
      });

      it('propagates the error when the proposal has no alternative to fall back to', async () => {
        proposalService.findById.mockResolvedValue(
          baseProposal({ chip: FplChip.WILDCARD }),
        );
        proposalService.applyNoChipAlternative.mockRejectedValue(
          new Error('has no chip-free alternative to approve'),
        );

        await expect(
          service.decide('p1', ProposalStatus.APPROVED, 'user1', {
            withoutChip: true,
          }),
        ).rejects.toThrow('has no chip-free alternative');
        expect(executionService.apply).not.toHaveBeenCalled();
      });

      it('does not touch the alternative on a plain decide (no options)', async () => {
        proposalService.findById.mockResolvedValue(baseProposal());

        await service.decide('p1', ProposalStatus.APPROVED, 'user1');

        expect(proposalService.applyNoChipAlternative).not.toHaveBeenCalled();
      });
    });
  });

  describe('expire', () => {
    it('moves a PENDING proposal to EXPIRED', async () => {
      proposalService.findById.mockResolvedValue(baseProposal());

      await service.expire('p1');

      expect(proposalService.updateStatus).toHaveBeenCalledWith(
        'p1',
        ProposalStatus.EXPIRED,
      );
    });

    it('is a no-op for an unknown proposal', async () => {
      proposalService.findById.mockResolvedValue(undefined);

      await expect(service.expire('missing')).resolves.not.toThrow();
      expect(proposalService.updateStatus).not.toHaveBeenCalled();
    });

    it('is a no-op for an already-terminal proposal', async () => {
      proposalService.findById.mockResolvedValue(
        baseProposal({ status: ProposalStatus.REJECTED }),
      );

      await service.expire('p1');

      expect(proposalService.updateStatus).not.toHaveBeenCalled();
      expect(alertService.sendAppliedCheckIn).not.toHaveBeenCalled();
    });

    it('sends a post-deadline applied-manually check-in for a newly-expired proposal', async () => {
      proposalService.findById.mockResolvedValue(baseProposal());

      await service.expire('p1');

      expect(alertService.sendAppliedCheckIn).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'p1', status: ProposalStatus.EXPIRED }),
      );
    });

    it('does not throw when the applied-manually check-in fails to send', async () => {
      proposalService.findById.mockResolvedValue(baseProposal());
      alertService.sendAppliedCheckIn.mockRejectedValue(
        new Error('telegram down'),
      );

      await expect(service.expire('p1')).resolves.not.toThrow();
    });
  });

  describe('recordAppliedManually', () => {
    it('delegates to ProposalService', async () => {
      const approval = await service.recordAppliedManually('p1', true);

      expect(proposalService.recordAppliedManually).toHaveBeenCalledWith(
        'p1',
        true,
      );
      expect(approval.appliedManually).toBe(true);
    });
  });

  describe('expireOverdue', () => {
    it('expires only PENDING proposals past their deadline', async () => {
      const overdue = baseProposal({
        id: 'overdue',
        deadlineAt: '2000-01-01T00:00:00Z',
      });
      const notYetDue = baseProposal({ id: 'not-due' });
      proposalService.findAllPending.mockResolvedValue([overdue, notYetDue]);
      proposalService.findById.mockImplementation((id: string) =>
        Promise.resolve([overdue, notYetDue].find((p) => p.id === id)),
      );

      await service.expireOverdue();

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
