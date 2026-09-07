import { Injectable } from '@nestjs/common';
import { HeuristicStrategy } from './strategies/heuristic.strategy';
import { IngestionService } from '../ingestion/ingestion.service';
import {
  Fixture,
  Gameweek,
  Player,
  PlayerSnapshot,
  SquadRules,
} from '../common/types/domain.types';

export interface PredictionResult {
  players: Player[];
  rules: SquadRules;
  targetGameweek: Gameweek;
  predictions: PlayerSnapshot[];
}

@Injectable()
export class PredictionService {
  constructor(
    private readonly strategy: HeuristicStrategy,
    private readonly ingestionService: IngestionService,
  ) {}

  async predictGameweek(): Promise<PredictionResult> {
    const [{ players, snapshots, rules, gameweeks }, fixtures] =
      await Promise.all([
        this.ingestionService.getBootstrapSnapshot(),
        this.ingestionService.getFixtures(),
      ]);

    const targetGameweek = gameweeks.find((gameweek) => gameweek.isNext);
    if (!targetGameweek) {
      // Nothing actionable to propose a change for — don't fabricate a
      // deadline by falling back to the current (already locked) gameweek.
      throw new Error(
        'No upcoming gameweek found in bootstrap-static (is_next missing).',
      );
    }

    const enriched = this.withNextFixtureDifficulty(
      players,
      snapshots,
      fixtures,
    );
    const predictions = await this.strategy.predict(enriched);
    return { players, rules, targetGameweek, predictions };
  }

  private withNextFixtureDifficulty(
    players: Player[],
    snapshots: PlayerSnapshot[],
    fixtures: Fixture[],
  ): PlayerSnapshot[] {
    const teamIdByPlayerId = new Map(players.map((p) => [p.id, p.teamId]));
    const nextDifficultyByTeamId = this.nextFixtureDifficultyByTeam(fixtures);

    return snapshots.map((snapshot) => {
      const teamId = teamIdByPlayerId.get(snapshot.playerId);
      const nextFixtureDifficulty =
        teamId !== undefined ? nextDifficultyByTeamId.get(teamId) : undefined;
      return { ...snapshot, nextFixtureDifficulty };
    });
  }

  // Earliest unfinished, scheduled fixture per team — not the literal "next
  // gameweek," since blank/double gameweeks mean that isn't always the same
  // thing per team.
  private nextFixtureDifficultyByTeam(
    fixtures: Fixture[],
  ): Map<number, number> {
    const upcoming = fixtures
      .filter((fixture) => !fixture.finished && fixture.gameweekId !== null)
      .sort((a, b) => (a.gameweekId ?? 0) - (b.gameweekId ?? 0));

    const nextDifficultyByTeamId = new Map<number, number>();
    for (const fixture of upcoming) {
      if (!nextDifficultyByTeamId.has(fixture.homeTeamId)) {
        nextDifficultyByTeamId.set(fixture.homeTeamId, fixture.homeDifficulty);
      }
      if (!nextDifficultyByTeamId.has(fixture.awayTeamId)) {
        nextDifficultyByTeamId.set(fixture.awayTeamId, fixture.awayDifficulty);
      }
    }
    return nextDifficultyByTeamId;
  }
}
