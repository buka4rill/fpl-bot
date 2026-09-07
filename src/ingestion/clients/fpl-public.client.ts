import { Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { BootstrapStaticResponse } from './fpl-api.types';

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

  // TODO: fixtures(gameweek?), elementSummary(playerId), liveGameweek(gameweek)
}
