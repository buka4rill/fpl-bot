import { Injectable } from '@nestjs/common';
import { TelegramAdapter } from './adapters/telegram.adapter';
import { Player, PlayerSnapshot, Proposal } from '../common/types/domain.types';
import { Position } from '../common/enums/position.enum';

const POSITION_ORDER: Position[] = [
  Position.GKP,
  Position.DEF,
  Position.MID,
  Position.FWD,
];

@Injectable()
export class AlertService {
  constructor(private readonly telegram: TelegramAdapter) {}

  // `players`/`snapshots` are passed in rather than fetched here —
  // AlertModule only renders and sends, it doesn't depend on IngestionModule
  // (per ARCHITECTURE.md §2's PROPOSAL --> ALERT edge). Whoever generates
  // the proposal already has both from PredictionService/IngestionService.
  async sendProposal(
    proposal: Proposal,
    players: Player[],
    snapshots: PlayerSnapshot[],
  ): Promise<void> {
    const text = this.renderMessage(proposal, players, snapshots);
    await this.telegram.sendProposalAlert(text, proposal.id);
  }

  private renderMessage(
    proposal: Proposal,
    players: Player[],
    snapshots: PlayerSnapshot[],
  ): string {
    const playerById = new Map(players.map((p) => [p.id, p]));
    const priceById = new Map(snapshots.map((s) => [s.playerId, s.price]));
    const name = (id: number): string =>
      playerById.get(id)?.webName ?? `#${id}`;
    const priced = (id: number): string => {
      const price = priceById.get(id);
      return price === undefined
        ? name(id)
        : `${name(id)} (£${price.toFixed(1)}m)`;
    };
    const withPosition = (id: number): string => {
      const position = playerById.get(id)?.position;
      return position ? `${name(id)} (${position})` : name(id);
    };
    const byPosition = (a: number, b: number): number =>
      POSITION_ORDER.indexOf(playerById.get(a)?.position as Position) -
      POSITION_ORDER.indexOf(playerById.get(b)?.position as Position);

    const lines = [
      `🤖 *FPL Assistant — GW${proposal.gameweekId} Proposal*`,
      '',
    ];

    if (proposal.transfers.length === 0) {
      lines.push('✅ No transfers — squad unchanged');
    } else {
      for (const transfer of proposal.transfers) {
        lines.push(
          `🔄 Selling ${priced(transfer.playerOutId)} ➔ Buying ${priced(transfer.playerInId)}`,
        );
      }
      if (proposal.hitCost > 0) {
        lines.push(`💸 Hit: -${proposal.hitCost} pts`);
      }
    }

    const bench = [proposal.benchGoalkeeperId, ...proposal.benchOutfieldIds]
      .map(name)
      .join(', ');

    lines.push(
      '',
      `⚽ Starting XI: ${[...proposal.lineup].sort(byPosition).map(withPosition).join(', ')}`,
      `👑 Captain: ${name(proposal.captainId)} (VC: ${name(proposal.viceCaptainId)})`,
      `🪑 Bench: ${bench}`,
      `📊 Predicted Points: ${proposal.expectedGain.toFixed(1)} xP`,
      '',
      `⏰ Deadline: ${new Date(proposal.deadlineAt).toUTCString()}`,
      'Reply below before the deadline — no reply means no changes are made.',
    );

    return lines.join('\n');
  }
}
