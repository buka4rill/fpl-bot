import { Module } from '@nestjs/common';
import { ProposalService } from './proposal.service';
import { ProposalController } from './proposal.controller';
import { OptimizationModule } from '../optimization/optimization.module';
import { ExecutionModule } from '../execution/execution.module';
import { AlertModule } from '../alert/alert.module';
import { IngestionModule } from '../ingestion/ingestion.module';

@Module({
  imports: [OptimizationModule, ExecutionModule, AlertModule, IngestionModule],
  controllers: [ProposalController],
  providers: [ProposalService],
  exports: [ProposalService],
})
export class ProposalModule {}
