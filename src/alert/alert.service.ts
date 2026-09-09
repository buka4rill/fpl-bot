import { Injectable } from '@nestjs/common';
import { TelegramAdapter } from './adapters/telegram.adapter';
import { Player, PlayerSnapshot, Proposal } from '../common/types/domain.types';
import { Position } from '../common/enums/position.enum';
import { FplChip } from '../common/enums/chip.enum';
import { ProposalStatus } from '../common/enums/proposal-status.enum';
import type { ChipCandidate } from '../optimization/chip-evaluator.service';
import type { DivergenceResult } from '../results/gameweek-scoring.util';

const POSITION_ORDER: Position[] = [
  Position.GKP,
  Position.DEF,
  Position.MID,
  Position.FWD,
];

const CHIP_LABELS: Record<FplChip, string> = {
  [FplChip.WILDCARD]: 'Wildcard',
  [FplChip.FREE_HIT]: 'Free Hit',
  [FplChip.BENCH_BOOST]: 'Bench Boost',
  [FplChip.TRIPLE_CAPTAIN]: 'Triple Captain',
};

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
    candidates?: ChipCandidate[],
  ): Promise<void> {
    const text = this.renderMessage(proposal, players, snapshots, candidates);
    await this.telegram.sendProposalAlert(
      text,
      proposal.id,
      proposal.noChipAlternative != null,
    );
  }

  // Loud on failure, not silent — ARCHITECTURE.md §10 risk table: execution
  // failure should alert, not fail quietly.
  async sendExecutionResult(
    proposal: Proposal,
    success: boolean,
    detail?: string,
  ): Promise<void> {
    // Describes what was actually in the proposal (transfers/chip) rather
    // than a fixed "captain/lineup changes" phrase — that phrase was
    // accurate for the original captain-swap-only use case but misleading
    // for anything else (confirmed live 2026-09-08: a Bench Boost execution
    // reported "captain/lineup changes are live," which wasn't what
    // happened at all). Falls back to the old phrasing only when there's
    // genuinely nothing else to report — setLineup is still called on every
    // execution, so that fallback stays accurate for a plain captain swap.
    const summary = this.summarizeChanges(proposal) ?? 'lineup/captain changes';
    const text = success
      ? `✅ *GW${proposal.gameweekId} applied* — ${summary} now live on your FPL team.`
      : `🚨 *GW${proposal.gameweekId} execution FAILED*\nYour approval was recorded, but applying it to FPL failed:\n${detail ?? 'unknown error'}\n\nYou'll need to make this change manually before the deadline.`;
    await this.telegram.sendMessage(text);
  }

  // Post-deadline check-in for a proposal that went unanswered (or whose
  // reply arrived too late) — purely to label the real-world outcome for
  // future backtesting (CLAUDE.md step 5). Never gates or re-triggers
  // execution; the hard "silence means do nothing" rule already applied
  // before this fires.
  async sendAppliedCheckIn(proposal: Proposal): Promise<void> {
    const changeSummary = this.summarizeChanges(proposal) ?? 'no changes';

    const text = [
      `❓ *GW${proposal.gameweekId} — the deadline has passed.*`,
      `The proposal was: ${changeSummary}.`,
      "Did you apply my suggestion? (Just for my own tracking — doesn't affect anything.)",
    ].join('\n');

    await this.telegram.sendAppliedCheckIn(text, proposal.id);
  }

  // Post-gameweek "how did my suggestion actually score" report —
  // ResultsService's output, sent for every terminal proposal (APPROVED/
  // REJECTED/EXPIRED) once its gameweek finishes. `predictedScore` is the
  // proposal's simulated actual score (gameweek-scoring.util.ts — real
  // player points, autosubs, and chip effects applied to what was
  // *proposed*, not what happened); `actualScore` is what the account
  // really scored that gameweek, independent of this proposal's fate.
  // `divergence` — only ever passed for APPROVED proposals (ResultsService
  // never computes it for REJECTED/EXPIRED, see detectDivergence's doc
  // comment) — flags when what FPL shows was actually live at kickoff no
  // longer matches what this proposal says was executed, e.g. the owner
  // cancelled a chip or edited the lineup in the FPL app after approval.
  // When that's happened, the predicted-vs-actual delta below isn't a fair
  // model-accuracy check (the "actual" score reflects the owner's later
  // edit, not the model's plan), so the report says so explicitly instead
  // of silently presenting a misleading comparison.
  async sendResultReport(
    proposal: Proposal,
    predictedScore: number,
    actualScore: number,
    divergence?: DivergenceResult,
  ): Promise<void> {
    const delta = actualScore - predictedScore;
    const pts = (n: number): string => `${n} pt${Math.abs(n) === 1 ? '' : 's'}`;
    const deltaLine =
      delta === 0
        ? '➖ Same either way'
        : delta > 0
          ? `✅ You beat my suggestion by ${pts(delta)}`
          : `📉 My suggestion would have scored ${pts(-delta)} more`;

    const contextLine = this.resultContextLine(proposal);
    const divergenceLines = divergence?.diverged
      ? [
          '⚠️ Something changed after I applied this — not a fair model comparison:',
          ...divergence.reasons.map((reason) => `• ${reason}`),
        ]
      : [];
    const text = [
      `📊 *GW${proposal.gameweekId} Result*`,
      ...(contextLine ? [contextLine] : []),
      ...divergenceLines,
      `My suggestion: ${predictedScore} pts`,
      `Your actual score: ${actualScore} pts`,
      deltaLine,
    ].join('\n');

    await this.telegram.sendMessage(text);
  }

  // One line of context on what actually happened to the proposal — skipped
  // for APPROVED (self-evident: the bot applied it itself, so this message
  // is really a model-accuracy check rather than a "what if"). For EXPIRED,
  // draws on whatever sendAppliedCheckIn's answer was, if any — it's
  // usually already been answered by the time the gameweek finishes, days
  // after the deadline passed.
  private resultContextLine(proposal: Proposal): string | undefined {
    switch (proposal.status) {
      case ProposalStatus.REJECTED:
        return '(You rejected this proposal.)';
      case ProposalStatus.EXPIRED:
        if (proposal.appliedManually === true) {
          return '(You told me you applied it anyway.)';
        }
        if (proposal.appliedManually === false) {
          return "(You told me you didn't apply it.)";
        }
        return '(The deadline passed without a reply.)';
      default:
        return undefined;
    }
  }

  // Shared by sendExecutionResult/sendAppliedCheckIn — undefined when the
  // proposal has neither transfers nor a chip, so each caller can supply
  // its own accurate fallback phrase (they mean different things: "no
  // changes" vs. "lineup/captain changes" are both true in that case,
  // depending which message it's for).
  private summarizeChanges(proposal: Proposal): string | undefined {
    const parts = [
      proposal.transfers.length > 0
        ? `${proposal.transfers.length} transfer${proposal.transfers.length === 1 ? '' : 's'}`
        : undefined,
      proposal.chip ? CHIP_LABELS[proposal.chip] : undefined,
    ].filter((part): part is string => Boolean(part));

    return parts.length > 0 ? parts.join(' + ') : undefined;
  }

  // Thin passthrough so callers outside AlertModule (e.g. TeamStateService)
  // never need TelegramAdapter injected directly — AlertModule only exports
  // AlertService, keeping the Telegram bot instance encapsulated.
  async sendMessage(text: string): Promise<void> {
    await this.telegram.sendMessage(text);
  }

  private renderMessage(
    proposal: Proposal,
    players: Player[],
    snapshots: PlayerSnapshot[],
    candidates?: ChipCandidate[],
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

    // Surfaced up front, before transfers — playing a chip changes how the
    // rest of the message should be read (e.g. "No transfers" reads very
    // differently once you know Bench Boost is being played this week), and
    // burying it further down risks an approval made without this being
    // seen at all (confirmed live 2026-09-08: it wasn't shown anywhere and
    // the owner approved a Bench Boost proposal without realizing it).
    if (proposal.chip) {
      lines.push(`🃏 Chip: ${CHIP_LABELS[proposal.chip]}`, '');
    }

    // Only shown when the proposal came from comparing several candidates
    // (generateBestProposal) — explains *why* this plan was picked, right
    // alongside the chip line since that's the fact it's justifying.
    if (candidates && candidates.length > 1) {
      const chipLabel = (chip: FplChip | undefined): string =>
        chip ? CHIP_LABELS[chip] : 'No chip';
      const summary = candidates
        .map((c) => {
          const value = c.netExpectedPoints;
          const sign = value >= 0 ? '+' : '';
          return `${chipLabel(c.chip)} ${sign}${value.toFixed(1)}`;
        })
        .join(' · ');
      lines.push(
        `📊 Considered: ${summary} → picked ${chipLabel(proposal.chip)}`,
        '',
      );
    }

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
