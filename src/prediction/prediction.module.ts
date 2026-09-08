import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PredictionService } from './prediction.service';
import { HeuristicStrategy } from './strategies/heuristic.strategy';
import { TrainedModelStrategy } from './strategies/trained-model.strategy';
import { IngestionModule } from '../ingestion/ingestion.module';
import { ExecutionModule } from '../execution/execution.module';
import { GameweekEntity } from '../persistence/entities/gameweek.entity';
import { PlayerSnapshotEntity } from '../persistence/entities/player-snapshot.entity';

@Module({
  imports: [
    IngestionModule,
    ExecutionModule,
    TypeOrmModule.forFeature([GameweekEntity, PlayerSnapshotEntity]),
  ],
  providers: [PredictionService, HeuristicStrategy, TrainedModelStrategy],
  exports: [PredictionService],
})
export class PredictionModule {}
