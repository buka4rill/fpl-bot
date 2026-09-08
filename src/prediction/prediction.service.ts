import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { HeuristicStrategy } from './strategies/heuristic.strategy';
import { IngestionService } from '../ingestion/ingestion.service';
import { ExecutionService } from '../execution/execution.service';
import {
  CurrentSquad,
  Fixture,
  Gameweek,
  Player,
  PlayerSnapshot,
  SquadRules,
} from '../common/types/domain.types';
import { GameweekEntity } from '../persistence/entities/gameweek.entity';
import { PlayerSnapshotEntity } from '../persistence/entities/player-snapshot.entity';

export interface PredictionResult {
  players: Player[];
  rules: SquadRules;
  targetGameweek: Gameweek;
  // Undefined when FPL_TEAM_ID isn't configured — a from-scratch
  // recommendation is still valid without a team to compare against.
  currentSquad?: CurrentSquad;
  predictions: PlayerSnapshot[];
}

@Injectable()
export class PredictionService {
  private readonly logger = new Logger(PredictionService.name);

  constructor(
    private readonly strategy: HeuristicStrategy,
    private readonly ingestionService: IngestionService,
    private readonly executionService: ExecutionService,
    private readonly config: ConfigService,
    @InjectRepository(GameweekEntity)
    private readonly gameweekRepository: Repository<GameweekEntity>,
    @InjectRepository(PlayerSnapshotEntity)
    private readonly playerSnapshotRepository: Repository<PlayerSnapshotEntity>,
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

    // Reads through the authenticated my-team endpoint (ExecutionService),
    // not IngestionService's public entry/picks path — that one 404s for
    // an account with no completed-gameweek picks history (discovered
    // 2026-09-08 testing against the disposable test account), which
    // would otherwise silently break the optimizer-driven proposal flow,
    // including the automatic weekly one. Every real caller of
    // predictGameweek() already asserts authentication before reaching
    // this point (DeadlineWatcherService, ProposalController,
    // TelegramCommandsService), so this doesn't add a new practical
    // requirement — see CLAUDE.md's "Execution auth".
    const teamId = this.config.get<string>('fpl.teamId');
    const currentSquad = teamId
      ? await this.executionService.getCurrentSquad(
          Number(teamId),
          targetGameweek.id,
        )
      : undefined;

    const enriched = this.withNextFixtureDifficulty(
      players,
      snapshots,
      fixtures,
    );
    const predictions = await this.strategy.predict(enriched);
    await this.recordSnapshotHistory(targetGameweek, predictions);
    return { players, rules, targetGameweek, currentSquad, predictions };
  }

  // Best-effort backtesting history (ARCHITECTURE.md §6) — captures exactly
  // what the model saw when it made this gameweek's recommendation. Unlike
  // Proposal/Approval/ExecutionLog, this is a supplementary audit trail, not
  // the app's actual state, so a write failure here must not block
  // generating and alerting the proposal itself (CLAUDE.md: alert → wait
  // for approval is the hard constraint, not this).
  private async recordSnapshotHistory(
    targetGameweek: Gameweek,
    predictions: PlayerSnapshot[],
  ): Promise<void> {
    try {
      await this.gameweekRepository.save(
        this.gameweekRepository.create(targetGameweek),
      );
      // Overrides gameweekId/season from the target gameweek being predicted
      // for, not whatever the snapshot's own fields say: IngestionService
      // stamps a fresh PlayerSnapshot's gameweekId with the *currently live*
      // gameweek (it's "as-of-now" player data), which is a different
      // gameweek than the one this prediction is actually for whenever a
      // proposal is generated before its target gameweek goes live —
      // without this override, this history would be keyed by the wrong
      // gameweek entirely, unable to join back to the gameweeks row this
      // same call just saved above.
      await this.playerSnapshotRepository.save(
        predictions.map((prediction) =>
          this.playerSnapshotRepository.create({
            ...prediction,
            gameweekId: targetGameweek.id,
            season: targetGameweek.season,
          }),
        ),
      );
    } catch (error) {
      this.logger.warn(
        `Failed to record snapshot history for gameweek ${targetGameweek.id}: ${String(error)}`,
      );
    }
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
