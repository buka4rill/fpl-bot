import { Body, Controller, Logger, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { ApprovalService } from './approval.service';
import { ProposalStatus } from '../common/enums/proposal-status.enum';

// Minimal shape of the fields we read from a Telegram callback_query update
// — see https://core.telegram.org/bots/api#update. Deliberately not the full
// Update type: ApprovalModule doesn't depend on telegraf, only AlertModule
// (which sends messages) does.
interface TelegramCallbackUpdate {
  callback_query?: {
    id: string;
    data?: string;
    from?: { id: number };
    message?: { chat?: { id: number } };
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

@Controller('approval')
export class ApprovalController {
  private readonly logger = new Logger(ApprovalController.name);

  constructor(
    private readonly approvalService: ApprovalService,
    private readonly config: ConfigService,
    private readonly http: HttpService,
  ) {}

  // Telegram webhook target. Always acknowledges (2xx) regardless of outcome
  // — a non-2xx response makes Telegram retry the same update repeatedly.
  // Also answers the callback_query itself: without that, the tapped
  // button's loading spinner never clears, which we found live — Telegram
  // resends (or the user re-taps) a callback whose spinner never stopped,
  // and the approval state machine has to reject the resulting duplicate.
  @Post('telegram-callback')
  async handleTelegramCallback(
    @Body() update: TelegramCallbackUpdate,
  ): Promise<{ ok: true }> {
    let toast: string;
    try {
      toast = this.process(update);
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

  private process(update: TelegramCallbackUpdate): string {
    const query = update.callback_query;
    if (!query?.data) return '';

    const chatId = query.message?.chat?.id;
    const configuredChatId = this.config.get<string>('telegram.chatId');
    if (!chatId || String(chatId) !== configuredChatId) {
      throw new Error(`callback from unrecognized chat: ${String(chatId)}`);
    }

    const [action, proposalId] = query.data.split(':');
    const decision = ACTION_TO_DECISION[action];
    if (!decision || !proposalId) {
      throw new Error(`unrecognized callback data: ${query.data}`);
    }

    const decidedBy = query.from ? String(query.from.id) : String(chatId);
    this.approvalService.decide(proposalId, decision, decidedBy);
    return DECISION_TOAST[decision];
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
