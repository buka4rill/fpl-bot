import { Injectable } from '@nestjs/common';
import { FplPublicClient } from './clients/fpl-public.client';
import { StatsProviderClient } from './clients/stats-provider.client';
import {
  Gameweek,
  Player,
  PlayerSnapshot,
  Team,
} from '../common/types/domain.types';
import { POSITION_BY_ELEMENT_TYPE } from '../common/enums/position.enum';
import { BootstrapStaticResponse } from './clients/fpl-api.types';

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
}
