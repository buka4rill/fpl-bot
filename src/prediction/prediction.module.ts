import { Module } from '@nestjs/common';
import { PredictionService } from './prediction.service';
import { HeuristicStrategy } from './strategies/heuristic.strategy';
import { TrainedModelStrategy } from './strategies/trained-model.strategy';

@Module({
  providers: [PredictionService, HeuristicStrategy, TrainedModelStrategy],
  exports: [PredictionService],
})
export class PredictionModule {}
