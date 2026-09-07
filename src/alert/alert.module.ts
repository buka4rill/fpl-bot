import { Module } from '@nestjs/common';
import { AlertService } from './alert.service';
import { TelegramAdapter } from './adapters/telegram.adapter';

@Module({
  providers: [AlertService, TelegramAdapter],
  exports: [AlertService],
})
export class AlertModule {}
