import { Body, Controller, Logger, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApprovalService } from './approval.service';
import { ProposalStatus } from '../common/enums/proposal-status.enum';

// Minimal shape of the fields we read from a Telegram callback_query update
// — see https://core.telegram.org/bots/api#update. Deliberately not the full
// Update type: ApprovalModule doesn't depend on telegraf, only AlertModule
// (which sends messages) does.
interface TelegramCallbackUpdate {
  callback_query?: {
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

@Controller('approval')
export class ApprovalController {
  private readonly logger = new Logger(ApprovalController.name);

  constructor(
    private readonly approvalService: ApprovalService,
    private readonly config: ConfigService,
  ) {}

  // Telegram webhook target. Always acknowledges (2xx) regardless of outcome
  // — a non-2xx response makes Telegram retry the same update repeatedly.
  @Post('telegram-callback')
  handleTelegramCallback(@Body() update: TelegramCallbackUpdate): { ok: true } {
    try {
      this.process(update);
    } catch (error) {
      // Expected failures (unknown proposal, already decided, deadline
      // passed, wrong chat) land here — logged, not surfaced to Telegram.
      this.logger.warn(`Telegram callback not applied: ${String(error)}`);
    }
    return { ok: true };
  }

  private process(update: TelegramCallbackUpdate): void {
    const query = update.callback_query;
    if (!query?.data) return;

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
  }
}
