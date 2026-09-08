import { Test, TestingModule } from '@nestjs/testing';
import { ChipEvaluatorService } from './chip-evaluator.service';
import { PredictionService } from '../prediction/prediction.service';
import {
  SquadOptimizationResult,
  SquadOptimizerService,
} from './squad-optimizer.service';
import { FplChip } from '../common/enums/chip.enum';
import { Gameweek, PlayerSnapshot } from '../common/types/domain.types';

describe('ChipEvaluatorService', () => {
  let service: ChipEvaluatorService;
  let predictionService: { predictGameweek: jest.Mock };
  let squadOptimizerService: { evaluateStrategy: jest.Mock };

  const targetGameweek: Gameweek = {
    id: 4,
    deadlineAt: '2026-09-12T12:30:00Z',
    isCurrent: false,
    isNext: true,
    finished: false,
    season: '26_27',
  };

  // captainId=1 (10 pts), benchGoalkeeperId=12 (2 pts), benchOutfieldIds
  // 13/14/15 (3/2/1 pts) — chosen so captain-multiplier and bench-boost
  // math is easy to hand-verify.
  const baseOptimization: SquadOptimizationResult = {
    targetGameweek,
    squad: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    transfers: [],
    hitCost: 0,
    startingXI: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    benchGoalkeeperId: 12,
    benchOutfieldIds: [13, 14, 15],
    captainId: 1,
    viceCaptainId: 2,
    totalPredictedPoints: 50, // XI total, captain (id 1, 10 pts) counted once
  };

  const predictions: PlayerSnapshot[] = [
    {
      gameweekId: 4,
      playerId: 1,
      price: 10,
      ownershipPct: 0,
      predictedPoints: 10,
    },
    {
      gameweekId: 4,
      playerId: 12,
      price: 4,
      ownershipPct: 0,
      predictedPoints: 2,
    },
    {
      gameweekId: 4,
      playerId: 13,
      price: 4,
      ownershipPct: 0,
      predictedPoints: 3,
    },
    {
      gameweekId: 4,
      playerId: 14,
      price: 4,
      ownershipPct: 0,
      predictedPoints: 2,
    },
    {
      gameweekId: 4,
      playerId: 15,
      price: 4,
      ownershipPct: 0,
      predictedPoints: 1,
    },
  ];

  beforeEach(async () => {
    predictionService = {
      predictGameweek: jest.fn().mockResolvedValue({
        players: [],
        rules: {} as never,
        targetGameweek,
        predictions,
      }),
    };
    squadOptimizerService = {
      // Same squad/lineup regardless of chip — only netExpectedPoints
      // (computed by ChipEvaluatorService itself) should differ.
      evaluateStrategy: jest.fn().mockReturnValue(baseOptimization),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChipEvaluatorService,
        { provide: PredictionService, useValue: predictionService },
        { provide: SquadOptimizerService, useValue: squadOptimizerService },
      ],
    }).compile();

    service = module.get<ChipEvaluatorService>(ChipEvaluatorService);
  });

  it('fetches predictions exactly once regardless of how many candidates are evaluated', async () => {
    await service.evaluateBestStrategy();

    expect(predictionService.predictGameweek).toHaveBeenCalledTimes(1);
    expect(squadOptimizerService.evaluateStrategy).toHaveBeenCalledTimes(5); // no chip + 4 chips
  });

  it('doubles the captain on top of the XI total for every candidate (real captaincy, not a chip effect)', async () => {
    const { candidates } = await service.evaluateBestStrategy();

    const noChip = candidates.find((c) => c.chip === undefined)!;
    // totalPredictedPoints (50) already has the captain counted once, so
    // +10 (captainPoints * (2x - 1)) reconstructs the real doubled total —
    // this isn't a chip bonus, plain captaincy applies every week.
    expect(noChip.netExpectedPoints).toBe(60);
  });

  it('adds one extra captain multiplier on top of normal captaincy for Triple Captain', async () => {
    const { candidates } = await service.evaluateBestStrategy();

    const tripleCaptain = candidates.find(
      (c) => c.chip === FplChip.TRIPLE_CAPTAIN,
    )!;
    // 50 (XI, captain once) + 20 (captainPoints * (3x - 1)) = captain
    // tripled instead of doubled.
    expect(tripleCaptain.netExpectedPoints).toBe(70);
  });

  it("adds the bench's points on top of normal captaincy for Bench Boost", async () => {
    const { candidates } = await service.evaluateBestStrategy();

    const benchBoost = candidates.find((c) => c.chip === FplChip.BENCH_BOOST)!;
    // 50 (XI) + 10 (normal captain doubling) + 2+3+2+1 (bench)
    expect(benchBoost.netExpectedPoints).toBe(68);
  });

  it('nets the hit cost off every candidate', async () => {
    squadOptimizerService.evaluateStrategy.mockReturnValue({
      ...baseOptimization,
      hitCost: 4,
    });

    const { candidates } = await service.evaluateBestStrategy();

    const noChip = candidates.find((c) => c.chip === undefined)!;
    expect(noChip.netExpectedPoints).toBe(56); // 60 - 4
  });

  it('picks the highest-scoring candidate as best', async () => {
    const { best } = await service.evaluateBestStrategy();

    // Triple Captain (70) beats Bench Boost (68) here — confirms best is
    // the true max across all candidates, not just "first above no chip".
    expect(best.chip).toBe(FplChip.TRIPLE_CAPTAIN);
    expect(best.netExpectedPoints).toBe(70);
  });

  it('defaults to the chip-free candidate when nothing beats it (no benefit / tie)', async () => {
    // Every candidate scores identically to "no chip" here (no hit cost,
    // and captain/bench math only diverges for Triple Captain/Bench Boost
    // above) — Wildcard/Free Hit have no scoring effect of their own, so
    // they tie with "no chip" and must not win on a tie.
    squadOptimizerService.evaluateStrategy.mockReturnValue({
      ...baseOptimization,
      captainId: 999, // no matching prediction -> captain bonus is 0
      benchGoalkeeperId: 999,
      benchOutfieldIds: [999],
    });

    const { best } = await service.evaluateBestStrategy();

    expect(best.chip).toBeUndefined();
  });

  it('restricts candidates to the given availableChips list', async () => {
    const { candidates } = await service.evaluateBestStrategy(undefined, [
      FplChip.BENCH_BOOST,
    ]);

    expect(candidates.map((c) => c.chip)).toEqual([
      undefined,
      FplChip.BENCH_BOOST,
    ]);
    expect(squadOptimizerService.evaluateStrategy).toHaveBeenCalledTimes(2);
  });

  it('passes freeTransfers through to evaluateStrategy for every candidate', async () => {
    await service.evaluateBestStrategy(2, [FplChip.WILDCARD]);

    expect(squadOptimizerService.evaluateStrategy).toHaveBeenCalledWith(
      expect.anything(),
      2,
      undefined,
    );
    expect(squadOptimizerService.evaluateStrategy).toHaveBeenCalledWith(
      expect.anything(),
      2,
      FplChip.WILDCARD,
    );
  });
});
