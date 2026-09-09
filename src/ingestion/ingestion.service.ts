import { Injectable } from '@nestjs/common';
import { FplPublicClient } from './clients/fpl-public.client';
import { StatsProviderClient } from './clients/stats-provider.client';
import {
  CurrentSquad,
  Fixture,
  GameweekOutcome,
  Gameweek,
  Player,
  PlayerGameweekStats,
  PlayerRecentForm,
  PlayerSnapshot,
  SquadRules,
  Team,
} from '../common/types/domain.types';
import { POSITION_BY_ELEMENT_TYPE } from '../common/enums/position.enum';
import { FplChip } from '../common/enums/chip.enum';
import { computeSeason } from '../common/utils/season.util';
import {
  BootstrapStaticResponse,
  ElementSummaryResponse,
  EntryPicksResponse,
  LiveGameweekResponse,
  RawEntry,
  RawFixture,
} from './clients/fpl-api.types';

export interface BootstrapSnapshot {
  gameweeks: Gameweek[];
  teams: Team[];
  players: Player[];
  snapshots: PlayerSnapshot[];
  rules: SquadRules;
}

@Injectable()
export class IngestionService {
  constructor(
    private readonly fplPublicClient: FplPublicClient,
    private readonly statsProviderClient: StatsProviderClient,
  ) {}

  async getBootstrapSnapshot(): Promise<BootstrapSnapshot> {
    const raw = await this.fplPublicClient.bootstrapStatic();
    return this.normalizeBootstrap(raw);
  }

  async getFixtures(gameweek?: number): Promise<Fixture[]> {
    const raw = await this.fplPublicClient.fixtures(gameweek);
    return this.normalizeFixtures(raw);
  }

  // Per-player upcoming fixtures + recent-gameweek history. Not normalized
  // into a domain type yet — the useful shape depends on how PredictionModule
  // ends up consuming form/minutes-risk, which isn't decided.
  getElementSummary(playerId: number): Promise<ElementSummaryResponse> {
    return this.fplPublicClient.elementSummary(playerId);
  }

  // Rolling xG/xA over a player's last `matchWindow` fixtures — built for
  // issue #8 (Telegram narrative layer), which needs a "last N matches" form
  // claim that PlayerSnapshot.xg/xa (season-cumulative) can't support. One
  // call per player, so this is meant to be called for the handful of
  // players an alert is actually about (a transfer pair, a captain), not
  // the whole player pool. Sorted by round defensively — live captures have
  // so far returned history in ascending order already, but nothing in the
  // API contract guarantees it.
  async getRecentForm(
    playerId: number,
    matchWindow = 4,
  ): Promise<PlayerRecentForm> {
    const raw = await this.fplPublicClient.elementSummary(playerId);
    const recent = [...raw.history]
      .sort((a, b) => a.round - b.round)
      .slice(-matchWindow);

    const minutesConsidered = recent.reduce((sum, m) => sum + m.minutes, 0);
    const xgTotal = recent.reduce(
      (sum, m) => sum + Number(m.expected_goals),
      0,
    );
    const xaTotal = recent.reduce(
      (sum, m) => sum + Number(m.expected_assists),
      0,
    );
    const per90Factor = minutesConsidered > 0 ? 90 / minutesConsidered : 0;

    return {
      playerId,
      matchesConsidered: recent.length,
      minutesConsidered,
      xgPer90: xgTotal * per90Factor,
      xaPer90: xaTotal * per90Factor,
    };
  }

  // Actual per-player performance once a gameweek is underway/finished, for
  // post-hoc comparison against PlayerSnapshot.predictedPoints (ARCHITECTURE.md
  // §4). Not normalized yet — no backtesting/evaluation consumer exists to
  // dictate the shape.
  getLiveGameweek(gameweek: number): Promise<LiveGameweekResponse> {
    return this.fplPublicClient.liveGameweek(gameweek);
  }

  // ResultsService's first real consumer of live-gameweek data — normalized
  // into a lookup by player id, keyed for the autosub/scoring simulation in
  // gameweek-scoring.util.ts.
  async getGameweekPlayerStats(
    gameweek: number,
  ): Promise<Map<number, PlayerGameweekStats>> {
    const raw = await this.fplPublicClient.liveGameweek(gameweek);
    return new Map(
      raw.elements.map((element) => [
        element.id,
        {
          playerId: element.id,
          totalPoints: element.stats.total_points,
          minutes: element.stats.minutes,
          played: element.stats.played,
        },
      ]),
    );
  }

  // The real points actually scored that gameweek, plus what was actually
  // live at kickoff (chip/captain/starting XI) — ResultsService compares
  // the former against the proposal's simulated score, and the latter
  // against the proposal's stored plan to detect a post-approval manual
  // edit (see GameweekOutcome's doc comment). A separate method from
  // getCurrentSquad below since that one is pinned to entry.current_event —
  // this needs an arbitrary past gameweek instead.
  async getGameweekResult(
    teamId: number,
    gameweek: number,
  ): Promise<GameweekOutcome> {
    const picks = await this.fplPublicClient.getEntryPicks(teamId, gameweek);
    return {
      actualPoints: picks.entry_history.points,
      activeChip: this.matchChip(picks.active_chip),
      captainId: picks.picks.find((pick) => pick.is_captain)?.element,
      startingXI: picks.picks
        .filter((pick) => pick.position <= 11)
        .map((pick) => pick.element),
    };
  }

  // No `freeTransfers` on the result — the public API doesn't expose your
  // accumulated free-transfer count. Callers that need it must supply it.
  async getCurrentSquad(teamId: number): Promise<CurrentSquad> {
    const entry = await this.fplPublicClient.getEntry(teamId);
    const picks = await this.fplPublicClient.getEntryPicks(
      teamId,
      entry.current_event,
    );
    return this.normalizeCurrentSquad(entry, picks);
  }

  private normalizeBootstrap(raw: BootstrapStaticResponse): BootstrapSnapshot {
    const currentGameweek = raw.events.find((event) => event.is_current);

    const gameweeks: Gameweek[] = raw.events.map((event) => ({
      id: event.id,
      deadlineAt: event.deadline_time,
      isCurrent: event.is_current,
      isNext: event.is_next,
      finished: event.finished,
      season: computeSeason(event.deadline_time),
    }));

    const teams: Team[] = raw.teams.map((team) => ({
      id: team.id,
      name: team.name,
      shortName: team.short_name,
    }));

    const players: Player[] = raw.elements.map((element) => ({
      id: element.id,
      webName: element.web_name,
      fullName: `${element.first_name} ${element.second_name}`.trim(),
      teamId: element.team,
      position: POSITION_BY_ELEMENT_TYPE[element.element_type],
    }));

    // now_cost is in tenths of £m (60 -> £6.0m); percentage/form fields are
    // numeric strings in the API and parsed here.
    const snapshots: PlayerSnapshot[] = raw.elements.map((element) => ({
      gameweekId: currentGameweek?.id ?? 0,
      playerId: element.id,
      price: element.now_cost / 10,
      ownershipPct: Number(element.selected_by_percent),
      form: Number(element.form),
      xg: Number(element.expected_goals),
      xa: Number(element.expected_assists),
      minutesPlayed: element.minutes,
      status: element.status,
      chanceOfPlayingNextRound: element.chance_of_playing_next_round,
      position: POSITION_BY_ELEMENT_TYPE[element.element_type],
      defensiveContribution: Number(element.defensive_contribution),
    }));

    // squad_total_spend is in tenths of £m, same unit as now_cost.
    const rules: SquadRules = {
      squadSize: raw.game_settings.squad_squadsize,
      startingSize: raw.game_settings.squad_squadplay,
      maxPerClub: raw.game_settings.squad_team_limit,
      budget: raw.game_settings.squad_total_spend / 10,
      positions: raw.element_types.map((elementType) => ({
        position: POSITION_BY_ELEMENT_TYPE[elementType.id],
        squadCount: elementType.squad_select,
        minStarting: elementType.squad_min_play,
        maxStarting: elementType.squad_max_play,
      })),
    };

    return { gameweeks, teams, players, snapshots, rules };
  }

  private normalizeFixtures(raw: RawFixture[]): Fixture[] {
    return raw.map((fixture) => ({
      id: fixture.id,
      gameweekId: fixture.event,
      homeTeamId: fixture.team_h,
      awayTeamId: fixture.team_a,
      kickoffAt: fixture.kickoff_time,
      finished: fixture.finished,
      homeDifficulty: fixture.team_h_difficulty,
      awayDifficulty: fixture.team_a_difficulty,
    }));
  }

  // Shared by normalizeCurrentSquad and getGameweekResult — FPL's
  // active_chip is a raw string (or null), matched against FplChip's enum
  // values to get an `undefined`-means-none result consistent with the
  // rest of the domain.
  private matchChip(rawChip: string | null): FplChip | undefined {
    return Object.values(FplChip).find((chip) => chip === rawChip);
  }

  private normalizeCurrentSquad(
    entry: RawEntry,
    picks: EntryPicksResponse,
  ): CurrentSquad {
    const activeChip = this.matchChip(picks.active_chip);

    return {
      teamId: entry.id,
      gameweekId: picks.entry_history.event,
      playerIds: picks.picks.map((pick) => pick.element),
      bank: picks.entry_history.bank / 10,
      teamValue: picks.entry_history.value / 10,
      activeChip,
    };
  }
}
