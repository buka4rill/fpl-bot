import { Module } from '@nestjs/common';
import { ProposalService } from './proposal.service';

@Module({
  providers: [ProposalService],
  exports: [ProposalService],
})
export class ProposalModule {}
