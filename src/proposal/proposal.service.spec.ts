import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ProposalService } from './proposal.service';
import { SquadOptimizerService } from '../optimization/squad-optimizer.service';
import { SquadOptimizationResult } from '../optimization/squad-optimizer.service';
import {
  ChipCandidate,
  ChipEvaluatorService,
} from '../optimization/chip-evaluator.service';
import { ProposalStatus } from '../common/enums/proposal-status.enum';
import { ProposalEntity } from '../persistence/entities/proposal.entity';
import { FplChip } from '../common/enums/chip.enum';
import { TriggerSource } from '../common/enums/trigger-source.enum';

// Minimal in-memory stand-in for Repository<ProposalEntity>, covering only
// the methods ProposalService actually calls — mirrors the real Postgres
// table's identity/upsert-by-id semantics without needing a live DB.
class FakeProposalRepository {
  private readonly rows = new Map<string, ProposalEntity>();

  create(entity: ProposalEntity): ProposalEntity {
    return entity;
  }

  save(entity: ProposalEntity): Promise<ProposalEntity> {
    this.rows.set(entity.id, entity);
    return Promise.resolve(entity);
  }

  findOneBy(where: Partial<ProposalEntity>): Promise<ProposalEntity | null> {
    const rows = [...this.rows.values()];
    if (where.id !== undefined) {
      return Promise.resolve(rows.find((row) => row.id === where.id) ?? null);
    }
    if (where.gameweekId !== undefined) {
      return Promise.resolve(
        rows.find(
          (row) =>
            row.gameweekId === where.gameweekId &&
            (where.season === undefined || row.season === where.season) &&
            (where.source === undefined || row.source === where.source),
        ) ?? null,
      );
    }
    return Promise.resolve(null);
  }

  findBy(where: Partial<ProposalEntity>): Promise<ProposalEntity[]> {
    return Promise.resolve(
      [...this.rows.values()].filter((row) => row.status === where.status),
    );
  }

  // Minimal stand-in for TypeORM's `find({ where: [...] })` OR-condition
  // shape, as used by findUnreportedTerminal — only supports what that
  // query actually needs: a status match plus an IsNull() check.
  find(options: {
    where: Array<{ status: ProposalStatus; resultReportedAt: unknown }>;
  }): Promise<ProposalEntity[]> {
    return Promise.resolve(
      [...this.rows.values()].filter((row) =>
        options.where.some(
          (clause) =>
            row.status === clause.status && row.resultReportedAt == null,
        ),
      ),
    );
  }
}

describe('ProposalService', () => {
  let service: ProposalService;
  let squadOptimizerService: { optimizeSquad: jest.Mock };
  let chipEvaluatorService: { evaluateBestStrategy: jest.Mock };

  const optimization: SquadOptimizationResult = {
    targetGameweek: {
      id: 4,
      deadlineAt: '2026-09-12T12:30:00Z',
      isCurrent: false,
      isNext: true,
      finished: false,
      season: '26_27',
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
    chipEvaluatorService = {
      evaluateBestStrategy: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProposalService,
        { provide: SquadOptimizerService, useValue: squadOptimizerService },
        { provide: ChipEvaluatorService, useValue: chipEvaluatorService },
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
    expect(proposal.season).toBe('26_27');
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

  it('finds a proposal by season + gameweek id', async () => {
    const proposal = await service.generateProposal(
      undefined,
      undefined,
      TriggerSource.AUTO,
    );

    expect(await service.findBySeasonAndGameweekId('26_27', 4)).toEqual(
      proposal,
    );
    expect(
      await service.findBySeasonAndGameweekId('26_27', 999),
    ).toBeUndefined();
  });

  it("does not match a prior season's proposal for the same gameweek id", async () => {
    // Regression test: FPL resets gameweek ids to 1 each season, so a plain
    // gameweekId lookup would find last season's GW4 row and wrongly report
    // "already proposed" for the new season's GW4.
    await service.generateProposal(undefined, undefined, TriggerSource.AUTO);

    expect(await service.findBySeasonAndGameweekId('27_28', 4)).toBeUndefined();
  });

  it('does not match a MANUAL proposal — only AUTO blocks the scheduler dedupe', async () => {
    // Regression test for the real GW4 incident (2026-09-08): manual
    // testing calls (/propose, /proposal/chip, etc.) persisted proposals
    // for a gameweek the scheduler had never automatically proposed for
    // yet, and the old source-blind lookup treated that as "already
    // proposed," silently skipping the real automatic proposal forever.
    await service.generateProposal(); // defaults to MANUAL

    expect(await service.findBySeasonAndGameweekId('26_27', 4)).toBeUndefined();
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

    expect(squadOptimizerService.optimizeSquad).toHaveBeenCalledWith(
      2,
      undefined,
      TriggerSource.MANUAL,
    );
  });

  it('passes a chip through to the optimizer and onto the stored proposal', async () => {
    const proposal = await service.generateProposal(1, FplChip.WILDCARD);

    expect(squadOptimizerService.optimizeSquad).toHaveBeenCalledWith(
      1,
      FplChip.WILDCARD,
      TriggerSource.MANUAL,
    );
    expect(proposal.chip).toBe(FplChip.WILDCARD);
  });

  it('passes source through to the optimizer and onto the stored proposal', async () => {
    const proposal = await service.generateProposal(
      1,
      undefined,
      TriggerSource.AUTO,
    );

    expect(squadOptimizerService.optimizeSquad).toHaveBeenCalledWith(
      1,
      undefined,
      TriggerSource.AUTO,
    );
    expect(proposal.source).toBe(TriggerSource.AUTO);
  });

  describe('generateBestProposal', () => {
    const candidates: ChipCandidate[] = [
      { chip: undefined, optimization, netExpectedPoints: 50 },
      { chip: FplChip.WILDCARD, optimization, netExpectedPoints: 60 },
    ];

    it('stores a proposal using the winning candidate', async () => {
      chipEvaluatorService.evaluateBestStrategy.mockResolvedValue({
        best: candidates[1],
        candidates,
      });

      const { proposal, candidates: returned } =
        await service.generateBestProposal();

      expect(proposal.chip).toBe(FplChip.WILDCARD);
      expect(proposal.expectedGain).toBe(60); // netExpectedPoints, not the XI-only formula
      expect(proposal.status).toBe(ProposalStatus.PENDING);
      expect(returned).toBe(candidates);
    });

    it('passes freeTransfers/availableChips through to the evaluator', async () => {
      chipEvaluatorService.evaluateBestStrategy.mockResolvedValue({
        best: candidates[0],
        candidates,
      });

      await service.generateBestProposal(2, [FplChip.BENCH_BOOST]);

      expect(chipEvaluatorService.evaluateBestStrategy).toHaveBeenCalledWith(
        2,
        [FplChip.BENCH_BOOST],
        TriggerSource.MANUAL,
      );
    });

    it('passes source through to the evaluator and onto the stored proposal', async () => {
      chipEvaluatorService.evaluateBestStrategy.mockResolvedValue({
        best: candidates[0],
        candidates,
      });

      const { proposal } = await service.generateBestProposal(
        undefined,
        undefined,
        TriggerSource.AUTO,
      );

      expect(chipEvaluatorService.evaluateBestStrategy).toHaveBeenCalledWith(
        undefined,
        undefined,
        TriggerSource.AUTO,
      );
      expect(proposal.source).toBe(TriggerSource.AUTO);
    });

    it('persists the chip-free candidate as noChipAlternative when the winner has a chip', async () => {
      const noChipOptimization: SquadOptimizationResult = {
        ...optimization,
        transfers: [{ playerOutId: 6, playerInId: 16 }],
        startingXI: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 16],
        captainId: 2,
        hitCost: 4,
      };
      chipEvaluatorService.evaluateBestStrategy.mockResolvedValue({
        best: { chip: FplChip.WILDCARD, optimization, netExpectedPoints: 60 },
        candidates: [
          {
            chip: undefined,
            optimization: noChipOptimization,
            netExpectedPoints: 45,
          },
          { chip: FplChip.WILDCARD, optimization, netExpectedPoints: 60 },
        ],
      });

      const { proposal } = await service.generateBestProposal();

      expect(proposal.noChipAlternative).toEqual({
        transfers: [{ playerOutId: 6, playerInId: 16 }],
        lineup: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 16],
        benchGoalkeeperId: 12,
        benchOutfieldIds: [13, 14, 15],
        captainId: 2,
        viceCaptainId: 2,
        expectedGain: 45,
        hitCost: 4,
      });
    });

    it('leaves noChipAlternative unset when the winner has no chip', async () => {
      chipEvaluatorService.evaluateBestStrategy.mockResolvedValue({
        best: candidates[0], // chip: undefined
        candidates,
      });

      const { proposal } = await service.generateBestProposal();

      expect(proposal.noChipAlternative).toBeFalsy();
    });
  });

  describe('applyNoChipAlternative', () => {
    it('swaps in the alternative and clears the chip', async () => {
      chipEvaluatorService.evaluateBestStrategy.mockResolvedValue({
        best: { chip: FplChip.WILDCARD, optimization, netExpectedPoints: 60 },
        candidates: [
          {
            chip: undefined,
            optimization: {
              ...optimization,
              transfers: [{ playerOutId: 6, playerInId: 16 }],
              captainId: 2,
              hitCost: 4,
            },
            netExpectedPoints: 45,
          },
          { chip: FplChip.WILDCARD, optimization, netExpectedPoints: 60 },
        ],
      });
      const { proposal } = await service.generateBestProposal();

      const updated = await service.applyNoChipAlternative(proposal.id);

      expect(updated.chip).toBeUndefined();
      expect(updated.transfers).toEqual([{ playerOutId: 6, playerInId: 16 }]);
      expect(updated.captainId).toBe(2);
      expect(updated.hitCost).toBe(4);
      expect(updated.expectedGain).toBe(45);
    });

    it('throws when the proposal has no chip-free alternative', async () => {
      const proposal = await service.generateProposal(); // no chip, no alternative

      await expect(service.applyNoChipAlternative(proposal.id)).rejects.toThrow(
        'has no chip-free alternative',
      );
    });

    it('throws for an unknown proposal', async () => {
      await expect(
        service.applyNoChipAlternative('nonexistent'),
      ).rejects.toThrow('No proposal found');
    });
  });

  it('records the applied-manually answer and persists it', async () => {
    const proposal = await service.generateProposal();

    const updated = await service.recordAppliedManually(proposal.id, true);

    expect(updated.appliedManually).toBe(true);
    expect((await service.findById(proposal.id))?.appliedManually).toBe(true);
  });

  it('throws when recording applied-manually for an unknown proposal', async () => {
    await expect(
      service.recordAppliedManually('nonexistent', true),
    ).rejects.toThrow('No proposal found');
  });

  describe('findUnreportedTerminal', () => {
    it('finds APPROVED/REJECTED/EXPIRED proposals without a result report yet', async () => {
      const approved = await service.generateProposal();
      await service.updateStatus(approved.id, ProposalStatus.APPROVED);
      const rejected = await service.generateProposal();
      await service.updateStatus(rejected.id, ProposalStatus.REJECTED);
      const expired = await service.generateProposal();
      await service.updateStatus(expired.id, ProposalStatus.EXPIRED);
      await service.generateProposal(); // stays PENDING — excluded

      const results = await service.findUnreportedTerminal();

      expect(results.map((p) => p.id).sort()).toEqual(
        [approved.id, rejected.id, expired.id].sort(),
      );
    });

    it('excludes a proposal that has already been reported on', async () => {
      const proposal = await service.generateProposal();
      await service.updateStatus(proposal.id, ProposalStatus.APPROVED);
      await service.markResultReported(proposal.id);

      const results = await service.findUnreportedTerminal();

      expect(results).toEqual([]);
    });
  });

  describe('markResultReported', () => {
    it('stamps a timestamp and persists it', async () => {
      const proposal = await service.generateProposal();

      const updated = await service.markResultReported(proposal.id);

      expect(updated.resultReportedAt).toBeTruthy();
      expect(
        (await service.findById(proposal.id))?.resultReportedAt,
      ).toBeTruthy();
    });

    it('throws for an unknown proposal', async () => {
      await expect(service.markResultReported('nonexistent')).rejects.toThrow(
        'No proposal found',
      );
    });
  });
});
