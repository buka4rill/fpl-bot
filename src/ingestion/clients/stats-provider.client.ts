import { Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';

// Underlying-stats source (xG/xA) the FPL API doesn't expose. Provider TBD.
@Injectable()
export class StatsProviderClient {
  constructor(private readonly http: HttpService) {}

  // TODO: fetch xG/xA per player for the current gameweek.
}
