import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ProposalService } from './proposal.service';
import { SquadOptimizerService } from '../optimization/squad-optimizer.service';
import { SquadOptimizationResult } from '../optimization/squad-optimizer.service';
import { ProposalStatus } from '../common/enums/proposal-status.enum';
import { ProposalEntity } from '../persistence/entities/proposal.entity';

// Minimal in-memory stand-in for Repository<ProposalEntity>, covering only
// the methods ProposalService actually calls — mirrors the real Postgres
// table's identity/upsert-by-id semantics without needing a live DB.
class FakeProposalRepository {
  private readonly rows = new Map<string, ProposalEntity>();

  create(entity: ProposalEntity): ProposalEntity {
    return entity;
  }

  async save(entity: ProposalEntity): Promise<ProposalEntity> {
    this.rows.set(entity.id, entity);
    return entity;
  }

  async findOneBy(
    where: Partial<ProposalEntity>,
  ): Promise<ProposalEntity | null> {
    const rows = [...this.rows.values()];
    if (where.id !== undefined) {
      return rows.find((row) => row.id === where.id) ?? null;
    }
    if (where.gameweekId !== undefined) {
      return rows.find((row) => row.gameweekId === where.gameweekId) ?? null;
    }
    return null;
  }

  async findBy(where: Partial<ProposalEntity>): Promise<ProposalEntity[]> {
    return [...this.rows.values()].filter(
      (row) => row.status === where.status,
    );
  }
}

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
        {
          provide: getRepositoryToken(ProposalEntity),
          useClass: FakeProposalRepository,
        },
      ],
    }).compile();

    service = module.get<ProposalService>(ProposalService);
  });

  it('builds a PENDING proposal from the optimizer result', async () => {
    const proposal = await service.generateProposal();

    expect(proposal.gameweekId).toBe(4);
    expect(proposal.deadlineAt).toBe('2026-09-12T12:30:00Z');
    expect(proposal.lineup).toEqual(optimization.startingXI);
    expect(proposal.benchGoalkeeperId).toBe(12);
    expect(proposal.benchOutfieldIds).toEqual([13, 14, 15]);
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

    expect(await service.findById(proposal.id)).toEqual(proposal);
    expect(await service.findById('nonexistent')).toBeUndefined();
  });

  it('finds a proposal by gameweek id', async () => {
    const proposal = await service.generateProposal();

    expect(await service.findByGameweekId(4)).toEqual(proposal);
    expect(await service.findByGameweekId(999)).toBeUndefined();
  });

  it('lists only PENDING proposals', async () => {
    const first = await service.generateProposal();
    const second = await service.generateProposal();
    await service.updateStatus(first.id, ProposalStatus.APPROVED);

    const pending = await service.findAllPending();

    expect(pending.map((p) => p.id)).toEqual([second.id]);
  });

  it('updates status and persists the change', async () => {
    const proposal = await service.generateProposal();

    const updated = await service.updateStatus(
      proposal.id,
      ProposalStatus.REJECTED,
    );

    expect(updated.status).toBe(ProposalStatus.REJECTED);
    expect((await service.findById(proposal.id))?.status).toBe(
      ProposalStatus.REJECTED,
    );
  });

  it('throws when updating the status of an unknown proposal', async () => {
    await expect(
      service.updateStatus('nonexistent', ProposalStatus.APPROVED),
    ).rejects.toThrow('No proposal found');
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
