import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ExecutionService } from './execution.service';
import { ExecutionLogEntity } from '../persistence/entities/execution-log.entity';
import { IngestionModule } from '../ingestion/ingestion.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([ExecutionLogEntity]),
    IngestionModule,
    AuthModule,
  ],
  providers: [ExecutionService],
  exports: [ExecutionService],
})
export class ExecutionModule {}
