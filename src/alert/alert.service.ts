import { Injectable } from '@nestjs/common';
import { TelegramAdapter } from './adapters/telegram.adapter';
import { Player, Proposal } from '../common/types/domain.types';

@Injectable()
export class AlertService {
  constructor(private readonly telegram: TelegramAdapter) {}

  // `players` is passed in rather than fetched here — AlertModule only
  // renders and sends, it doesn't depend on IngestionModule (per
  // ARCHITECTURE.md §2's PROPOSAL --> ALERT edge). Whoever generates the
  // proposal already has the player list from PredictionService.
  async sendProposal(proposal: Proposal, players: Player[]): Promise<void> {
    const text = this.renderMessage(proposal, players);
    await this.telegram.sendProposalAlert(text, proposal.id);
  }

  private renderMessage(proposal: Proposal, players: Player[]): string {
    const playerById = new Map(players.map((p) => [p.id, p]));
    const name = (id: number): string =>
      playerById.get(id)?.webName ?? `#${id}`;

    const lines = [
      `*Gameweek ${proposal.gameweekId} proposal*`,
      '',
      `Starting XI: ${proposal.lineup.map(name).join(', ')}`,
      `Captain: ${name(proposal.captainId)} | Vice: ${name(proposal.viceCaptainId)}`,
      `Expected points: ${proposal.expectedGain.toFixed(1)}`,
    ];

    if (proposal.hitCost > 0) {
      lines.push(`Hit cost: -${proposal.hitCost}`);
    }

    lines.push(
      '',
      `Deadline: ${new Date(proposal.deadlineAt).toUTCString()}`,
      '',
      'Reply below before the deadline. No reply means no changes are made.',
    );

    return lines.join('\n');
  }
}
