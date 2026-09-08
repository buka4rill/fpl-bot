import { Module } from '@nestjs/common';
import { ResultsService } from './results.service';
import { ResultsController } from './results.controller';
import { IngestionModule } from '../ingestion/ingestion.module';
import { ProposalModule } from '../proposal/proposal.module';
import { AlertModule } from '../alert/alert.module';

@Module({
  imports: [IngestionModule, ProposalModule, AlertModule],
  controllers: [ResultsController],
  providers: [ResultsService],
})
export class ResultsModule {}
