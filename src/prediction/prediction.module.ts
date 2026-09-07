import { Module } from '@nestjs/common';
import { PredictionService } from './prediction.service';
import { HeuristicStrategy } from './strategies/heuristic.strategy';
import { TrainedModelStrategy } from './strategies/trained-model.strategy';
import { IngestionModule } from '../ingestion/ingestion.module';

@Module({
  imports: [IngestionModule],
  providers: [PredictionService, HeuristicStrategy, TrainedModelStrategy],
  exports: [PredictionService],
})
export class PredictionModule {}
