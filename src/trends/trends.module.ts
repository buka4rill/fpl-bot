import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { TrendsService } from './trends.service';

@Module({
  imports: [HttpModule],
  providers: [TrendsService],
  exports: [TrendsService],
})
export class TrendsModule {}
