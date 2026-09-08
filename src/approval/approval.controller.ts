import { Body, Controller, Logger, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { ApprovalService } from './approval.service';
import { TelegramCommandsService } from '../telegram-commands/telegram-commands.service';
import { ProposalStatus } from '../common/enums/proposal-status.enum';

// Minimal shape of the fields we read from a Telegram Update — see
// https://core.telegram.org/bots/api#update. Deliberately not the full
// Update type: ApprovalModule doesn't depend on telegraf, only AlertModule
// (which sends messages) does. Two update shapes are handled: callback_query
// (approve/reject/appliedyes/appliedno buttons) and message (slash commands
// — /status, /propose, /login, see TelegramCommandsService). See git history
// for the weekly free-transfer/chip prompt this used to also route
// (chipavail: callbacks and a plain-text free-transfer reply), superseded
// 2026-09-08 by TeamStateService reading that data straight from FPL.
interface TelegramUpdate {
  callback_query?: {
    id: string;
    data?: string;
    from?: { id: number };
    message?: { chat?: { id: number } };
  };
  message?: {
    text?: string;
    chat?: { id: number };
  };
}

const ACTION_TO_DECISION: Record<
  string,
  ProposalStatus.APPROVED | ProposalStatus.REJECTED
> = {
  approve: ProposalStatus.APPROVED,
  reject: ProposalStatus.REJECTED,
};

const DECISION_TOAST: Record<
  ProposalStatus.APPROVED | ProposalStatus.REJECTED,
  string
> = {
  [ProposalStatus.APPROVED]: 'Approved.',
  [ProposalStatus.REJECTED]: 'Rejected.',
};

// Post-deadline "did you apply it yourself?" check-in — a separate action
// namespace from approve/reject since it labels an already-EXPIRED
// proposal's outcome rather than deciding it (see ApprovalService.
// recordAppliedManually).
const ACTION_TO_APPLIED: Record<string, boolean> = {
  appliedyes: true,
  appliedno: false,
};

@Controller('approval')
export class ApprovalController {
  private readonly logger = new Logger(ApprovalController.name);

  constructor(
    private readonly approvalService: ApprovalService,
    private readonly telegramCommandsService: TelegramCommandsService,
    private readonly config: ConfigService,
    private readonly http: HttpService,
  ) {}

  // Telegram webhook target — the single URL Telegram posts every update
  // type to (button taps and plain messages alike). Always acknowledges
  // (2xx) regardless of outcome — a non-2xx response makes Telegram retry
  // the same update repeatedly. Also answers the callback_query itself
  // when there is one: without that, the tapped button's loading spinner
  // never clears, which we found live — Telegram resends (or the user
  // re-taps) a callback whose spinner never stopped, and the approval
  // state machine has to reject the resulting duplicate.
  @Post('telegram-callback')
  async handleTelegramCallback(
    @Body() update: TelegramUpdate,
  ): Promise<{ ok: true }> {
    let toast: string;
    try {
      toast = await this.process(update);
    } catch (error) {
      // Expected failures (unknown proposal, already decided, deadline
      // passed, wrong chat) land here — logged, not surfaced to Telegram
      // beyond a generic toast.
      this.logger.warn(`Telegram callback not applied: ${String(error)}`);
      toast = 'Already handled — no change made.';
    }

    const callbackQueryId = update.callback_query?.id;
    if (callbackQueryId) {
      await this.answerCallbackQuery(callbackQueryId, toast);
    }
    return { ok: true };
  }

  private async process(update: TelegramUpdate): Promise<string> {
    if (update.callback_query) {
      return this.processCallbackQuery(update.callback_query);
    }
    if (update.message) {
      return this.processCommand(update.message);
    }
    return '';
  }

  private async processCallbackQuery(
    query: NonNullable<TelegramUpdate['callback_query']>,
  ): Promise<string> {
    if (!query.data) {
      return '';
    }

    const chatId = this.assertConfiguredChat(query.message?.chat?.id);

    const [action, proposalId] = query.data.split(':');
    if (!proposalId) {
      throw new Error(`unrecognized callback data: ${query.data}`);
    }

    if (action in ACTION_TO_APPLIED) {
      await this.approvalService.recordAppliedManually(
        proposalId,
        ACTION_TO_APPLIED[action],
      );
      return 'Thanks — noted.';
    }

    const decision = ACTION_TO_DECISION[action];
    if (!decision) {
      throw new Error(`unrecognized callback data: ${query.data}`);
    }

    const decidedBy = query.from ? String(query.from.id) : String(chatId);
    await this.approvalService.decide(proposalId, decision, decidedBy);
    return DECISION_TOAST[decision];
  }

  // Slash commands (/status, /propose, /login, /help) — see
  // TelegramCommandsService for what each one does. No toast to return
  // here: there's no callback_query spinner to clear for a plain message,
  // and each command sends its own Telegram reply once it's done.
  private async processCommand(
    message: NonNullable<TelegramUpdate['message']>,
  ): Promise<string> {
    if (!message.text?.startsWith('/')) {
      return '';
    }
    this.assertConfiguredChat(message.chat?.id);
    await this.telegramCommandsService.handleCommand(message.text);
    return '';
  }

  private assertConfiguredChat(chatId: number | undefined): number {
    const configuredChatId = this.config.get<string>('telegram.chatId');
    if (!chatId || String(chatId) !== configuredChatId) {
      throw new Error(`update from unrecognized chat: ${String(chatId)}`);
    }
    return chatId;
  }

  // Clears the button's loading spinner and shows a small toast in
  // Telegram. Best-effort — a failure here shouldn't fail the webhook
  // response, since the actual decision has already been applied.
  private async answerCallbackQuery(
    callbackQueryId: string,
    text: string,
  ): Promise<void> {
    const botToken = this.config.get<string>('telegram.botToken');
    if (!botToken) return;

    try {
      await firstValueFrom(
        this.http.post(
          `https://api.telegram.org/bot${botToken}/answerCallbackQuery`,
          { callback_query_id: callbackQueryId, text },
        ),
      );
    } catch (error) {
      this.logger.warn(
        `Failed to answer Telegram callback query: ${String(error)}`,
      );
    }
  }
}
