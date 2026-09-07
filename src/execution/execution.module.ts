import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ExecutionService } from './execution.service';
import { FplAuthClient } from './clients/fpl-auth.client';
import { ExecutionLogEntity } from '../persistence/entities/execution-log.entity';

@Module({
  imports: [HttpModule, TypeOrmModule.forFeature([ExecutionLogEntity])],
  providers: [ExecutionService, FplAuthClient],
  exports: [ExecutionService],
})
export class ExecutionModule {}
