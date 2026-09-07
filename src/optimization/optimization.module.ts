import { Module } from '@nestjs/common';
import { SquadOptimizerService } from './squad-optimizer.service';
import { ChipEvaluatorService } from './chip-evaluator.service';

@Module({
  providers: [SquadOptimizerService, ChipEvaluatorService],
  exports: [SquadOptimizerService, ChipEvaluatorService],
})
export class OptimizationModule {}
