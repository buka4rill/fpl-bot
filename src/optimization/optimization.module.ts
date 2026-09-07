import { Module } from '@nestjs/common';
import { SquadOptimizerService } from './squad-optimizer.service';
import { ChipEvaluatorService } from './chip-evaluator.service';
import { PredictionModule } from '../prediction/prediction.module';

@Module({
  imports: [PredictionModule],
  providers: [SquadOptimizerService, ChipEvaluatorService],
  exports: [SquadOptimizerService, ChipEvaluatorService],
})
export class OptimizationModule {}
