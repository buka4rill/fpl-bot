import { Module } from '@nestjs/common';
import { ResultsService } from './results.service';
import { ResultsController } from './results.controller';
import { IngestionModule } from '../ingestion/ingestion.module';
import { ProposalModule } from '../proposal/proposal.module';
import { AlertModule } from '../alert/alert.module';
import { PredictionModule } from '../prediction/prediction.module';

@Module({
  imports: [IngestionModule, ProposalModule, AlertModule, PredictionModule],
  controllers: [ResultsController],
  providers: [ResultsService],
  exports: [ResultsService],
})
export class ResultsModule {}
