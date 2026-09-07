import { Injectable } from '@nestjs/common';
import { HeuristicStrategy } from './strategies/heuristic.strategy';

@Injectable()
export class PredictionService {
  constructor(private readonly strategy: HeuristicStrategy) {}

  // TODO: run the active PredictionStrategy over ingested + trend data.
}
