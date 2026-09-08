import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Markup, Telegraf } from 'telegraf';

@Injectable()
export class TelegramAdapter {
  private readonly logger = new Logger(TelegramAdapter.name);
  private readonly bot: Telegraf | undefined;
  private readonly chatId: string;

  constructor(private readonly config: ConfigService) {
    const botToken = this.config.get<string>('telegram.botToken');
    this.chatId = this.config.get<string>('telegram.chatId') ?? '';
    this.bot = botToken ? new Telegraf(botToken) : undefined;
  }

  // Approve/Reject buttons carry the proposal ID as callback_data; Telegram
  // delivers them straight to ApprovalController's webhook on tap.
  async sendProposalAlert(text: string, proposalId: string): Promise<void> {
    if (!this.bot) {
      this.logger.warn('TELEGRAM_BOT_TOKEN not configured — skipping send.');
      return;
    }

    const keyboard = Markup.inlineKeyboard([
      Markup.button.callback('Approve', `approve:${proposalId}`),
      Markup.button.callback('Reject', `reject:${proposalId}`),
    ]);

    await this.bot.telegram.sendMessage(this.chatId, text, {
      parse_mode: 'Markdown',
      ...keyboard,
    });
  }

  async sendMessage(text: string): Promise<void> {
    if (!this.bot) {
      this.logger.warn('TELEGRAM_BOT_TOKEN not configured — skipping send.');
      return;
    }
    await this.bot.telegram.sendMessage(this.chatId, text, {
      parse_mode: 'Markdown',
    });
  }

  // Yes/No buttons carry caller-supplied callback data (e.g. the weekly
  // chip-availability prompt's `chipavail:<gameweekId>:<step>`), delivered
  // to ApprovalController's webhook on tap same as approve/reject.
  async sendYesNoPrompt(question: string, callbackData: string): Promise<void> {
    if (!this.bot) {
      this.logger.warn('TELEGRAM_BOT_TOKEN not configured — skipping send.');
      return;
    }

    const keyboard = Markup.inlineKeyboard([
      Markup.button.callback('Yes', `${callbackData}:yes`),
      Markup.button.callback('No', `${callbackData}:no`),
    ]);

    await this.bot.telegram.sendMessage(this.chatId, question, {
      parse_mode: 'Markdown',
      ...keyboard,
    });
  }
}
