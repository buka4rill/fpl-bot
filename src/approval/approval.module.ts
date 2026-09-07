import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ApprovalController } from './approval.controller';
import { ApprovalService } from './approval.service';
import { ApprovalStateMachine } from './approval.state-machine';
import { ProposalModule } from '../proposal/proposal.module';

@Module({
  imports: [ProposalModule, HttpModule],
  controllers: [ApprovalController],
  providers: [ApprovalService, ApprovalStateMachine],
  exports: [ApprovalService],
})
export class ApprovalModule {}
