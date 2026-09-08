import { Module } from '@nestjs/common';
import { DeadlineWatcherService } from './deadline-watcher.service';
import { IngestionModule } from '../ingestion/ingestion.module';
import { ProposalModule } from '../proposal/proposal.module';
import { AlertModule } from '../alert/alert.module';
import { ApprovalModule } from '../approval/approval.module';
import { TeamStateModule } from '../team-state/team-state.module';

@Module({
  imports: [
    IngestionModule,
    ProposalModule,
    AlertModule,
    ApprovalModule,
    TeamStateModule,
  ],
  providers: [DeadlineWatcherService],
})
export class SchedulerModule {}
