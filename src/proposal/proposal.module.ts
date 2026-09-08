import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProposalService } from './proposal.service';
import { ProposalController } from './proposal.controller';
import { OptimizationModule } from '../optimization/optimization.module';
import { ExecutionModule } from '../execution/execution.module';
import { AlertModule } from '../alert/alert.module';
import { IngestionModule } from '../ingestion/ingestion.module';
import { TeamStateModule } from '../team-state/team-state.module';
import { ProposalEntity } from '../persistence/entities/proposal.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([ProposalEntity]),
    OptimizationModule,
    ExecutionModule,
    AlertModule,
    IngestionModule,
    TeamStateModule,
  ],
  controllers: [ProposalController],
  providers: [ProposalService],
  exports: [ProposalService],
})
export class ProposalModule {}
