import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ExecutionService } from './execution.service';
import { FplAuthClient } from './clients/fpl-auth.client';

@Module({
  imports: [HttpModule],
  providers: [ExecutionService, FplAuthClient],
  exports: [ExecutionService],
})
export class ExecutionModule {}
