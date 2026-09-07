import { Injectable } from '@nestjs/common';
import { PredictionStrategy } from '../../common/interfaces/prediction-strategy.interface';
import { PlayerSnapshot } from '../../common/types/domain.types';

// v1 — form, fixture difficulty, underlying stats, minutes risk.
@Injectable()
export class HeuristicStrategy implements PredictionStrategy {
  predict(players: PlayerSnapshot[]): Promise<PlayerSnapshot[]> {
    // TODO: implement scoring.
    return Promise.resolve(players);
  }
}
