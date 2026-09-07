import { Injectable } from '@nestjs/common';
import { FplPublicClient } from './clients/fpl-public.client';
import { StatsProviderClient } from './clients/stats-provider.client';
import {
  Fixture,
  Gameweek,
  Player,
  PlayerSnapshot,
  Team,
} from '../common/types/domain.types';
import { POSITION_BY_ELEMENT_TYPE } from '../common/enums/position.enum';
import {
  BootstrapStaticResponse,
  ElementSummaryResponse,
  LiveGameweekResponse,
  RawFixture,
} from './clients/fpl-api.types';

export interface BootstrapSnapshot {
  gameweeks: Gameweek[];
  teams: Team[];
  players: Player[];
  snapshots: PlayerSnapshot[];
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

  // Actual per-player performance once a gameweek is underway/finished, for
  // post-hoc comparison against PlayerSnapshot.predictedPoints (ARCHITECTURE.md
  // §4). Not normalized yet — no backtesting/evaluation consumer exists to
  // dictate the shape.
  getLiveGameweek(gameweek: number): Promise<LiveGameweekResponse> {
    return this.fplPublicClient.liveGameweek(gameweek);
  }

  private normalizeBootstrap(raw: BootstrapStaticResponse): BootstrapSnapshot {
    const currentGameweek = raw.events.find((event) => event.is_current);

    const gameweeks: Gameweek[] = raw.events.map((event) => ({
      id: event.id,
      deadlineAt: event.deadline_time,
      isCurrent: event.is_current,
      isNext: event.is_next,
      finished: event.finished,
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
    }));

    return { gameweeks, teams, players, snapshots };
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
}
