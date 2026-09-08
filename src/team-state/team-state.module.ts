import { Module } from '@nestjs/common';
import { TeamStateService } from './team-state.service';
import { TeamStateController } from './team-state.controller';
import { AlertModule } from '../alert/alert.module';
import { IngestionModule } from '../ingestion/ingestion.module';
import { ExecutionModule } from '../execution/execution.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AlertModule, IngestionModule, ExecutionModule, AuthModule],
  controllers: [TeamStateController],
  providers: [TeamStateService],
  exports: [TeamStateService],
})
export class TeamStateModule {}
