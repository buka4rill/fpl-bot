import { Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';

// Public, unauthenticated FPL API — bootstrap-static, fixtures, element-summary,
// event/live. See ARCHITECTURE.md §4 for the endpoint list.
@Injectable()
export class FplPublicClient {
  private readonly baseUrl = 'https://fantasy.premierleague.com/api';

  constructor(private readonly http: HttpService) {}

  // TODO: bootstrapStatic(), fixtures(gameweek?), elementSummary(playerId), liveGameweek(gameweek)
}
