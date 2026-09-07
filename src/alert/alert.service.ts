import { Injectable } from '@nestjs/common';
import { TelegramAdapter } from './adapters/telegram.adapter';

@Injectable()
export class AlertService {
  constructor(private readonly telegram: TelegramAdapter) {}

  // TODO: render a Proposal into a human-readable message and send it.
}
