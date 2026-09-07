import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from './config/configuration';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { IngestionModule } from './ingestion/ingestion.module';
import { TrendsModule } from './trends/trends.module';
import { PredictionModule } from './prediction/prediction.module';
import { OptimizationModule } from './optimization/optimization.module';
import { ProposalModule } from './proposal/proposal.module';
import { AlertModule } from './alert/alert.module';
import { ApprovalModule } from './approval/approval.module';
import { ExecutionModule } from './execution/execution.module';
import { SchedulerModule } from './scheduler/scheduler.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    IngestionModule,
    TrendsModule,
    PredictionModule,
    OptimizationModule,
    ProposalModule,
    AlertModule,
    ApprovalModule,
    ExecutionModule,
    SchedulerModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
