import { Module } from '@nestjs/common';
import { ApprovalController } from './approval.controller';
import { ApprovalService } from './approval.service';
import { ApprovalStateMachine } from './approval.state-machine';
import { ProposalModule } from '../proposal/proposal.module';

@Module({
  imports: [ProposalModule],
  controllers: [ApprovalController],
  providers: [ApprovalService, ApprovalStateMachine],
  exports: [ApprovalService],
})
export class ApprovalModule {}
