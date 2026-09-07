import { Module } from '@nestjs/common';
import { ApprovalController } from './approval.controller';
import { ApprovalService } from './approval.service';
import { ApprovalStateMachine } from './approval.state-machine';

@Module({
  controllers: [ApprovalController],
  providers: [ApprovalService, ApprovalStateMachine],
  exports: [ApprovalService],
})
export class ApprovalModule {}
