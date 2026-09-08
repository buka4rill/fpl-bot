import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ExecutionService } from './execution.service';
import { FplAuthClient } from './clients/fpl-auth.client';
import { ExecutionLogEntity } from '../persistence/entities/execution-log.entity';
import { IngestionModule } from '../ingestion/ingestion.module';

@Module({
  imports: [
    HttpModule,
    TypeOrmModule.forFeature([ExecutionLogEntity]),
    IngestionModule,
  ],
  providers: [ExecutionService, FplAuthClient],
  exports: [ExecutionService],
})
export class ExecutionModule {}
