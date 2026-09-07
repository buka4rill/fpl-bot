import { Injectable } from '@nestjs/common';
import { PredictionStrategy } from '../../common/interfaces/prediction-strategy.interface';
import { PlayerSnapshot } from '../../common/types/domain.types';

// v1 — a hand-tuned linear heuristic, not a fitted model. Weights below are
// reasonable guesses, not backtested. See ARCHITECTURE.md §11 step 5 for the
// plan to replace this with a trained model once there's backtestable
// PlayerSnapshot history to validate against.

// Season-cumulative xG/xA need a meaningful minutes sample before their
// per-90 rate means anything — otherwise one great cameo skews the score.
const MINUTES_THRESHOLD_FOR_UNDERLYING_STATS = 180;
const UNDERLYING_STATS_WEIGHT = 2;
const UNAVAILABLE_STATUSES = new Set(['i', 's', 'u']); // injured, suspended, unavailable

@Injectable()
export class HeuristicStrategy implements PredictionStrategy {
  predict(players: PlayerSnapshot[]): Promise<PlayerSnapshot[]> {
    return Promise.resolve(
      players.map((player) => ({
        ...player,
        predictedPoints: this.score(player),
      })),
    );
  }

  private score(player: PlayerSnapshot): number {
    const base = player.form ?? 0;
    const underlyingStatsBonus = this.underlyingStatsBonus(player);
    const fixtureMultiplier = this.fixtureMultiplier(
      player.nextFixtureDifficulty,
    );
    const availabilityMultiplier = this.availabilityMultiplier(player);

    return (
      (base + underlyingStatsBonus) * fixtureMultiplier * availabilityMultiplier
    );
  }

  // FPL difficulty runs 1 (easiest) to 5 (hardest), 3 is average — scaled so
  // an average fixture leaves the base score unchanged.
  private fixtureMultiplier(difficulty?: number): number {
    if (difficulty === undefined) return 1;
    return (6 - difficulty) / 3;
  }

  private availabilityMultiplier(player: PlayerSnapshot): number {
    if (player.status && UNAVAILABLE_STATUSES.has(player.status)) {
      return 0;
    }
    // null/undefined means FPL is reporting no fitness doubt.
    if (
      player.chanceOfPlayingNextRound === null ||
      player.chanceOfPlayingNextRound === undefined
    ) {
      return 1;
    }
    return player.chanceOfPlayingNextRound / 100;
  }

  private underlyingStatsBonus(player: PlayerSnapshot): number {
    const minutes = player.minutesPlayed ?? 0;
    if (minutes < MINUTES_THRESHOLD_FOR_UNDERLYING_STATS) {
      return 0;
    }
    const per90Factor = 90 / minutes;
    const xgPer90 = (player.xg ?? 0) * per90Factor;
    const xaPer90 = (player.xa ?? 0) * per90Factor;
    return (xgPer90 + xaPer90) * UNDERLYING_STATS_WEIGHT;
  }
}
