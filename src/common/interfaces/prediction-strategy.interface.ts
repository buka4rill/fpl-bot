import { PlayerSnapshot } from '../types/domain.types';

// Swappable prediction backend — start heuristic, upgrade to a trained model
// later without touching ingestion, optimization, or anything downstream.
export interface PredictionStrategy {
  predict(players: PlayerSnapshot[]): Promise<PlayerSnapshot[]>;
}
