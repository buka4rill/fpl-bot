import { Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import {
  BootstrapStaticResponse,
  ElementSummaryResponse,
  EntryPicksResponse,
  LiveGameweekResponse,
  RawEntry,
  RawFixture,
} from './fpl-api.types';

// Public, unauthenticated FPL API — bootstrap-static, fixtures, element-summary,
// event/live. See ARCHITECTURE.md §4 for the endpoint list.
@Injectable()
export class FplPublicClient {
  private readonly baseUrl = 'https://fantasy.premierleague.com/api';

  constructor(private readonly http: HttpService) {}

  async bootstrapStatic(): Promise<BootstrapStaticResponse> {
    const { data } = await firstValueFrom(
      this.http.get<BootstrapStaticResponse>(
        `${this.baseUrl}/bootstrap-static/`,
      ),
    );
    return data;
  }

  async fixtures(gameweek?: number): Promise<RawFixture[]> {
    const { data } = await firstValueFrom(
      this.http.get<RawFixture[]>(`${this.baseUrl}/fixtures/`, {
        params: gameweek ? { event: gameweek } : undefined,
      }),
    );
    return data;
  }

  async elementSummary(playerId: number): Promise<ElementSummaryResponse> {
    const { data } = await firstValueFrom(
      this.http.get<ElementSummaryResponse>(
        `${this.baseUrl}/element-summary/${playerId}/`,
      ),
    );
    return data;
  }

  async liveGameweek(gameweek: number): Promise<LiveGameweekResponse> {
    const { data } = await firstValueFrom(
      this.http.get<LiveGameweekResponse>(
        `${this.baseUrl}/event/${gameweek}/live/`,
      ),
    );
    return data;
  }

  async getEntry(teamId: number): Promise<RawEntry> {
    const { data } = await firstValueFrom(
      this.http.get<RawEntry>(`${this.baseUrl}/entry/${teamId}/`),
    );
    return data;
  }

  async getEntryPicks(
    teamId: number,
    gameweek: number,
  ): Promise<EntryPicksResponse> {
    const { data } = await firstValueFrom(
      this.http.get<EntryPicksResponse>(
        `${this.baseUrl}/entry/${teamId}/event/${gameweek}/picks/`,
      ),
    );
    return data;
  }
}
