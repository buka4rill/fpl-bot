import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
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
import { TeamStateModule } from './team-state/team-state.module';
import { AuthModule } from './auth/auth.module';
import { ResultsModule } from './results/results.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        // DATABASE_URL (set in production — e.g. `fly postgres attach`
        // injects this) takes priority over the discrete fields, which
        // local dev's docker-compose Postgres still uses.
        const url = config.get<string>('database.url');
        const connection = url
          ? { url }
          : {
              host: config.get<string>('database.host'),
              port: config.get<number>('database.port'),
              database: config.get<string>('database.name'),
              username: config.get<string>('database.user'),
              password: config.get<string>('database.password'),
            };
        return {
          type: 'postgres' as const,
          ...connection,
          entities: [__dirname + '/persistence/entities/*.entity.{ts,js}'],
          migrations: [__dirname + '/persistence/migrations/*.{ts,js}'],
          synchronize: false,
          migrationsRun: true,
        };
      },
    }),
    IngestionModule,
    TrendsModule,
    PredictionModule,
    OptimizationModule,
    TeamStateModule,
    ProposalModule,
    AlertModule,
    ApprovalModule,
    ExecutionModule,
    SchedulerModule,
    AuthModule,
    ResultsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
