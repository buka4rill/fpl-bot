import { Test, TestingModule } from '@nestjs/testing';
import { ProposalService } from './proposal.service';
import { SquadOptimizerService } from '../optimization/squad-optimizer.service';
import { SquadOptimizationResult } from '../optimization/squad-optimizer.service';
import { ProposalStatus } from '../common/enums/proposal-status.enum';

describe('ProposalService', () => {
  let service: ProposalService;
  let squadOptimizerService: { optimizeSquad: jest.Mock };

  const optimization: SquadOptimizationResult = {
    targetGameweek: {
      id: 4,
      deadlineAt: '2026-09-12T12:30:00Z',
      isCurrent: false,
      isNext: true,
      finished: false,
    },
    squad: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    transfers: [],
    hitCost: 0,
    startingXI: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    benchGoalkeeperId: 12,
    benchOutfieldIds: [13, 14, 15],
    captainId: 1,
    viceCaptainId: 2,
    totalPredictedPoints: 55.5,
  };

  beforeEach(async () => {
    squadOptimizerService = {
      optimizeSquad: jest.fn().mockResolvedValue(optimization),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProposalService,
        { provide: SquadOptimizerService, useValue: squadOptimizerService },
      ],
    }).compile();

    service = module.get<ProposalService>(ProposalService);
  });

  it('builds a PENDING proposal from the optimizer result', async () => {
    const proposal = await service.generateProposal();

    expect(proposal.gameweekId).toBe(4);
    expect(proposal.deadlineAt).toBe('2026-09-12T12:30:00Z');
    expect(proposal.lineup).toEqual(optimization.startingXI);
    expect(proposal.captainId).toBe(1);
    expect(proposal.viceCaptainId).toBe(2);
    expect(proposal.expectedGain).toBe(55.5);
    expect(proposal.transfers).toEqual([]);
    expect(proposal.hitCost).toBe(0);
    expect(proposal.status).toBe(ProposalStatus.PENDING);
    expect(proposal.id).toBeTruthy();
    expect(proposal.createdAt).toBeTruthy();
  });

  it('stores the proposal so it can be retrieved by id', async () => {
    const proposal = await service.generateProposal();

    expect(service.findById(proposal.id)).toEqual(proposal);
    expect(service.findById('nonexistent')).toBeUndefined();
  });

  it('lists only PENDING proposals', async () => {
    const first = await service.generateProposal();
    const second = await service.generateProposal();
    service.updateStatus(first.id, ProposalStatus.APPROVED);

    const pending = service.findAllPending();

    expect(pending.map((p) => p.id)).toEqual([second.id]);
  });

  it('updates status and persists the change', async () => {
    const proposal = await service.generateProposal();

    const updated = service.updateStatus(proposal.id, ProposalStatus.REJECTED);

    expect(updated.status).toBe(ProposalStatus.REJECTED);
    expect(service.findById(proposal.id)?.status).toBe(ProposalStatus.REJECTED);
  });

  it('throws when updating the status of an unknown proposal', () => {
    expect(() =>
      service.updateStatus('nonexistent', ProposalStatus.APPROVED),
    ).toThrow('No proposal found');
  });

  it('carries transfers/hitCost through and nets the hit off expectedGain', async () => {
    squadOptimizerService.optimizeSquad.mockResolvedValue({
      ...optimization,
      transfers: [{ playerOutId: 6, playerInId: 16 }],
      hitCost: 4,
    });

    const proposal = await service.generateProposal();

    expect(proposal.transfers).toEqual([{ playerOutId: 6, playerInId: 16 }]);
    expect(proposal.hitCost).toBe(4);
    expect(proposal.expectedGain).toBe(51.5); // 55.5 - 4
  });

  it('passes freeTransfers through to the optimizer', async () => {
    await service.generateProposal(2);

    expect(squadOptimizerService.optimizeSquad).toHaveBeenCalledWith(2);
  });
});
