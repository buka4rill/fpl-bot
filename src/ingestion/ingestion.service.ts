import { Injectable } from '@nestjs/common';
import { FplPublicClient } from './clients/fpl-public.client';
import { StatsProviderClient } from './clients/stats-provider.client';

@Injectable()
export class IngestionService {
  constructor(
    private readonly fplPublicClient: FplPublicClient,
    private readonly statsProviderClient: StatsProviderClient,
  ) {}

  // TODO: orchestrate a full gameweek pull and normalize into domain types
  // (Gameweek, PlayerSnapshot). Idempotent — safe to re-run per gameweek.
}
