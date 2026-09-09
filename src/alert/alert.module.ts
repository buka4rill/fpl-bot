import { Module } from '@nestjs/common';
import { AlertService } from './alert.service';
import { TelegramAdapter } from './adapters/telegram.adapter';
import { NarrativeModule } from '../narrative/narrative.module';

@Module({
  imports: [NarrativeModule],
  providers: [AlertService, TelegramAdapter],
  exports: [AlertService],
})
export class AlertModule {}
