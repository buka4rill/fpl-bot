import { Injectable } from '@nestjs/common';
import { PredictionService } from '../prediction/prediction.service';
import {
  SquadOptimizationResult,
  SquadOptimizerService,
} from './squad-optimizer.service';
import { FplChip } from '../common/enums/chip.enum';

export interface ChipCandidate {
  chip?: FplChip;
  optimization: SquadOptimizationResult;
  // Real expected total, unlike SquadOptimizationResult.totalPredictedPoints
  // (starting XI only, captain counted once) — includes the extra captain
  // multiplier and Bench Boost's bench points, net of hit cost. Needed for
  // a fair comparison: totalPredictedPoints alone can't tell Bench
  // Boost/Triple Captain apart from doing nothing.
  netExpectedPoints: number;
}

@Injectable()
export class ChipEvaluatorService {
  constructor(
    private readonly predictionService: PredictionService,
    private readonly squadOptimizerService: SquadOptimizerService,
  ) {}

  // Compares "no chip" against every chip FPL currently reports as
  // available for this account (pass TeamState.chips filtered to
  // status_for_entry === 'available', mapped to FplChip by `.name`; omit
  // to consider all four, e.g. in a standalone test) — fetches predictions
  // exactly once regardless of how many candidates are evaluated.
  async evaluateBestStrategy(
    freeTransfers?: number,
    availableChips: FplChip[] = Object.values(FplChip),
  ): Promise<{ best: ChipCandidate; candidates: ChipCandidate[] }> {
    const prediction = await this.predictionService.predictGameweek();
    const pointsByPlayerId = new Map(
      prediction.predictions.map((p) => [p.playerId, p.predictedPoints ?? 0]),
    );

    const chipsToConsider: (FplChip | undefined)[] = [
      undefined,
      ...availableChips,
    ];

    const candidates: ChipCandidate[] = chipsToConsider.map((chip) => {
      const optimization = this.squadOptimizerService.evaluateStrategy(
        prediction,
        freeTransfers,
        chip,
      );
      return {
        chip,
        optimization,
        netExpectedPoints: this.netExpectedPoints(
          optimization,
          chip,
          pointsByPlayerId,
        ),
      };
    });

    // "No chip" is first — on a tie (or no benefit from any chip), the
    // reduce below only replaces on a strictly greater value, so it wins
    // by default rather than burning a chip for zero gain.
    const best = candidates.reduce((a, b) =>
      b.netExpectedPoints > a.netExpectedPoints ? b : a,
    );
    return { best, candidates };
  }

  // XI total (captain counted once) + the extra captain multiplier +
  // Bench Boost's bench points - hit cost.
  private netExpectedPoints(
    optimization: SquadOptimizationResult,
    chip: FplChip | undefined,
    pointsByPlayerId: Map<number, number>,
  ): number {
    const captainPoints = pointsByPlayerId.get(optimization.captainId) ?? 0;
    const captainMultiplier = chip === FplChip.TRIPLE_CAPTAIN ? 3 : 2;
    const benchBoostBonus =
      chip === FplChip.BENCH_BOOST
        ? (pointsByPlayerId.get(optimization.benchGoalkeeperId) ?? 0) +
          optimization.benchOutfieldIds.reduce(
            (sum, id) => sum + (pointsByPlayerId.get(id) ?? 0),
            0,
          )
        : 0;
    return (
      optimization.totalPredictedPoints +
      captainPoints * (captainMultiplier - 1) +
      benchBoostBonus -
      optimization.hitCost
    );
  }
}
