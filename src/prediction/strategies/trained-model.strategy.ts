import { Injectable } from '@nestjs/common';
import { PredictionStrategy } from '../../common/interfaces/prediction-strategy.interface';
import { PlayerSnapshot } from '../../common/types/domain.types';

// v2, later — see ARCHITECTURE.md §11 step 5. Needs backtestable PlayerSnapshot
// history from the heuristic strategy before this is worth building.
@Injectable()
export class TrainedModelStrategy implements PredictionStrategy {
  async predict(players: PlayerSnapshot[]): Promise<PlayerSnapshot[]> {
    throw new Error('Not implemented yet.');
  }
}
