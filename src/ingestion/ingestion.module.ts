import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { IngestionService } from './ingestion.service';
import { FplPublicClient } from './clients/fpl-public.client';
import { StatsProviderClient } from './clients/stats-provider.client';

@Module({
  imports: [HttpModule],
  providers: [IngestionService, FplPublicClient, StatsProviderClient],
  exports: [IngestionService],
})
export class IngestionModule {}
