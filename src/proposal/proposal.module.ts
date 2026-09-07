import { Module } from '@nestjs/common';
import { ProposalService } from './proposal.service';
import { OptimizationModule } from '../optimization/optimization.module';

@Module({
  imports: [OptimizationModule],
  providers: [ProposalService],
  exports: [ProposalService],
})
export class ProposalModule {}
