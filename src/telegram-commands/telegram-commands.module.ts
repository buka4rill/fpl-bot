import { Module } from '@nestjs/common';
import { TelegramCommandsService } from './telegram-commands.service';
import { IngestionModule } from '../ingestion/ingestion.module';
import { ProposalModule } from '../proposal/proposal.module';
import { TeamStateModule } from '../team-state/team-state.module';
import { AuthModule } from '../auth/auth.module';
import { AlertModule } from '../alert/alert.module';
import { ResultsModule } from '../results/results.module';

@Module({
  imports: [
    IngestionModule,
    ProposalModule,
    TeamStateModule,
    AuthModule,
    AlertModule,
    ResultsModule,
  ],
  providers: [TelegramCommandsService],
  exports: [TelegramCommandsService],
})
export class TelegramCommandsModule {}
