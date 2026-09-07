import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { DeadlineWatcherService } from './deadline-watcher.service';
import { IngestionModule } from '../ingestion/ingestion.module';

@Module({
  imports: [ScheduleModule.forRoot(), IngestionModule],
  providers: [DeadlineWatcherService],
})
export class SchedulerModule {}
