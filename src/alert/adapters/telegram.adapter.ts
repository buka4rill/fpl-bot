import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Telegraf } from 'telegraf';

@Injectable()
export class TelegramAdapter {
  private bot: Telegraf | undefined;

  constructor(private readonly config: ConfigService) {}

  // TODO: initialize Telegraf with TELEGRAM_BOT_TOKEN, send proposal messages
  // with inline Approve/Reject buttons, forward callbacks to ApprovalService.
}
