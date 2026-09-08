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

  // Loud on failure, not silent — ARCHITECTURE.md §10 risk table: execution
  // failure should alert, not fail quietly.
  async sendExecutionResult(
    proposal: Proposal,
    success: boolean,
    detail?: string,
  ): Promise<void> {
    const text = success
      ? `✅ *GW${proposal.gameweekId} lineup applied* — captain/lineup changes are live on your FPL team.`
      : `🚨 *GW${proposal.gameweekId} execution FAILED*\nYour approval was recorded, but applying it to FPL failed:\n${detail ?? 'unknown error'}\n\nYou'll need to make this change manually before the deadline.`;
    await this.telegram.sendMessage(text);
  }

  // Thin passthroughs so callers outside AlertModule (e.g. TeamStateService)
  // never need TelegramAdapter injected directly — AlertModule only exports
  // AlertService, keeping the Telegram bot instance encapsulated.
  async sendMessage(text: string): Promise<void> {
    await this.telegram.sendMessage(text);
  }

  async sendYesNoPrompt(question: string, callbackData: string): Promise<void> {
    await this.telegram.sendYesNoPrompt(question, callbackData);
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
      lines.push(
        proposal.hitCost > 0
          ? `💸 Hit: -${proposal.hitCost} pts`
          : '✅ Hit: 0 pts (within free transfers)',
      );
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
