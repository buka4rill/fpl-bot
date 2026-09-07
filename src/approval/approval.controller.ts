import { Body, Controller, Post } from '@nestjs/common';
import { ApprovalService } from './approval.service';

@Controller('approval')
export class ApprovalController {
  constructor(private readonly approvalService: ApprovalService) {}

  // TODO: receive the Telegram callback for an approve/reject decision.
  @Post('telegram-callback')
  handleTelegramCallback(@Body() payload: unknown) {
    return;
  }
}
