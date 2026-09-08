import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ApprovalController } from './approval.controller';
import { ApprovalService } from './approval.service';
import { ApprovalStateMachine } from './approval.state-machine';
import { ProposalModule } from '../proposal/proposal.module';
import { ExecutionModule } from '../execution/execution.module';
import { AlertModule } from '../alert/alert.module';
import { TeamStateModule } from '../team-state/team-state.module';
import { ApprovalEntity } from '../persistence/entities/approval.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([ApprovalEntity]),
    ProposalModule,
    ExecutionModule,
    AlertModule,
    TeamStateModule,
    HttpModule,
  ],
  controllers: [ApprovalController],
  providers: [ApprovalService, ApprovalStateMachine],
  exports: [ApprovalService],
})
export class ApprovalModule {}
