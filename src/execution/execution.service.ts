import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FplAuthClient } from './clients/fpl-auth.client';
import {
  FplChipStatus,
  FplPick,
  FplTransferSubmission,
  FplTransfersState,
} from './clients/fpl-auth.types';
import { Proposal, ExecutionLog } from '../common/types/domain.types';
import { ExecutionLogEntity } from '../persistence/entities/execution-log.entity';
import { IngestionService } from '../ingestion/ingestion.service';
import { FplChip } from '../common/enums/chip.enum';

export interface CurrentSquadShape {
  lineup: number[];
  benchGoalkeeperId: number;
  benchOutfieldIds: number[];
  captainId: number;
  viceCaptainId: number;
}

export interface TeamStateShape {
  chips: FplChipStatus[];
  transfers: FplTransfersState;
}

const TRANSFER_CHIPS = new Set([FplChip.WILDCARD, FplChip.FREE_HIT]);
const MY_TEAM_CHIPS = new Set([FplChip.BENCH_BOOST, FplChip.TRIPLE_CAPTAIN]);

// Handles lineup/captain, transfers, and chips (ARCHITECTURE.md §11 build
// order step 4). The /api/transfers/ contract this relies on was never
// captured live (unlike /api/my-team/, see project memory
// fpl-write-api-contract) — sourced from a community library instead (see
// fpl-auth.types.ts) and needs live confirmation the first time this
// actually runs against a real transfer or chip.
@Injectable()
export class ExecutionService {
  constructor(
    private readonly fplAuthClient: FplAuthClient,
    private readonly config: ConfigService,
    private readonly ingestionService: IngestionService,
    @InjectRepository(ExecutionLogEntity)
    private readonly executionLogRepository: Repository<ExecutionLogEntity>,
  ) {}

  // Only ever call this from an APPROVED proposal, before its deadline.
  async apply(proposal: Proposal): Promise<ExecutionLog> {
    if (new Date(proposal.deadlineAt).getTime() <= Date.now()) {
      throw new Error(
        `Deadline for proposal ${proposal.id} has passed — refusing to execute.`,
      );
    }

    const teamId = Number(this.config.get<string>('fpl.teamId'));
    const usesTransferEndpoint =
      proposal.transfers.length > 0 ||
      (proposal.chip !== undefined && TRANSFER_CHIPS.has(proposal.chip));

    let transfersResult: unknown;
    if (usesTransferEndpoint) {
      try {
        transfersResult = await this.submitTransfers(teamId, proposal);
      } catch (error) {
        // Nothing applied yet (the dry-run step failed, or the commit step
        // itself did) — safe to log and abort before touching lineup at all.
        const log = await this.executionLogRepository.save(
          this.executionLogRepository.create({
            proposalId: proposal.id,
            requestPayload: { transfers: proposal.transfers },
            responsePayload: { error: String(error) },
            appliedAt: new Date().toISOString(),
            success: false,
          }),
        );
        throw new Error(
          `Transfer submission failed for proposal ${proposal.id} — see execution log ${log.id}.`,
        );
      }
    }

    const current = await this.fplAuthClient.getMyTeam(teamId);
    const picks = this.buildPicks(current.picks, proposal);
    const myTeamChip =
      proposal.chip !== undefined && MY_TEAM_CHIPS.has(proposal.chip)
        ? proposal.chip
        : null;

    let lineupResult: unknown;
    let success = true;
    try {
      lineupResult = await this.fplAuthClient.setLineup(
        teamId,
        picks,
        myTeamChip,
      );
    } catch (error) {
      success = false;
      lineupResult = { error: String(error) };
    }

    const log = await this.executionLogRepository.save(
      this.executionLogRepository.create({
        proposalId: proposal.id,
        requestPayload: { transfers: proposal.transfers, picks },
        responsePayload: { transfersResult, lineupResult },
        appliedAt: new Date().toISOString(),
        success,
      }),
    );

    if (!success) {
      // The transfer (if any) already went through by this point — the
      // squad has changed even though this "failed." Say so plainly rather
      // than a generic failure message (CLAUDE.md: fail loudly, never
      // silently, and never understate what actually happened).
      const message = usesTransferEndpoint
        ? `Transfers were applied for proposal ${proposal.id}, but setting the final lineup/captain failed — check the FPL app directly. See execution log ${log.id}.`
        : `Execution failed for proposal ${proposal.id} — see execution log ${log.id}.`;
      throw new Error(message);
    }
    return log;
  }

  // Reads your currently-live squad shape (lineup/bench/captaincy) straight
  // from FPL — for building a manual-override proposal (e.g. a captain-only
  // swap) that doesn't go through SquadOptimizerService. Only exposes this
  // derived shape, never the raw picks/tokens, keeping FplAuthClient the one
  // place holding the authenticated session (CLAUDE.md).
  async getCurrentSquadShape(teamId: number): Promise<CurrentSquadShape> {
    const current = await this.fplAuthClient.getMyTeam(teamId);
    const sorted = [...current.picks].sort((a, b) => a.position - b.position);
    const bench = sorted.filter((p) => p.position > 11);
    const benchGoalkeeper = bench.find((p) => p.element_type === 1) ?? bench[0];
    const captain = current.picks.find((p) => p.is_captain);
    const viceCaptain = current.picks.find((p) => p.is_vice_captain);
    if (!benchGoalkeeper || !captain || !viceCaptain) {
      throw new Error(
        'Current squad is missing a bench goalkeeper, captain, or vice-captain — cannot build a manual proposal from it.',
      );
    }

    return {
      lineup: sorted.filter((p) => p.position <= 11).map((p) => p.element),
      benchGoalkeeperId: benchGoalkeeper.element,
      benchOutfieldIds: bench
        .filter((p) => p !== benchGoalkeeper)
        .map((p) => p.element),
      captainId: captain.element,
      viceCaptainId: viceCaptain.element,
    };
  }

  // Reads free-transfer count and chip availability straight from FPL, for
  // TeamStateService's weekly report — same "only exposes a derived shape,
  // keeping FplAuthClient the one place holding the authenticated session"
  // principle as getCurrentSquadShape above (CLAUDE.md's isolation
  // constraint on ExecutionModule).
  async getTeamState(teamId: number): Promise<TeamStateShape> {
    const current = await this.fplAuthClient.getMyTeam(teamId);
    return { chips: current.chips, transfers: current.transfers };
  }

  // Builds the transfer submission payload (fresh prices at execution
  // time, not proposal time — they can move before a proposal is approved)
  // and submits it. Empty `proposal.transfers` with a Wildcard/Free Hit
  // chip is valid — that's how the chip itself gets activated on a week
  // with no actual transfers.
  private async submitTransfers(
    teamId: number,
    proposal: Proposal,
  ): Promise<unknown> {
    const [current, { snapshots }] = await Promise.all([
      this.fplAuthClient.getMyTeam(teamId),
      this.ingestionService.getBootstrapSnapshot(),
    ]);
    const sellingPriceByElement = new Map(
      current.picks.map((pick) => [pick.element, pick.selling_price]),
    );
    const purchasePriceByElement = new Map(
      snapshots.map((snapshot) => [
        snapshot.playerId,
        Math.round(snapshot.price * 10),
      ]),
    );

    const submissions: FplTransferSubmission[] = proposal.transfers.map(
      (transfer) => {
        const sellingPrice = sellingPriceByElement.get(transfer.playerOutId);
        const purchasePrice = purchasePriceByElement.get(transfer.playerInId);
        if (sellingPrice === undefined || purchasePrice === undefined) {
          throw new Error(
            `Missing price data for transfer ${transfer.playerOutId} -> ${transfer.playerInId} on proposal ${proposal.id}.`,
          );
        }
        return {
          element_out: transfer.playerOutId,
          element_in: transfer.playerInId,
          selling_price: sellingPrice,
          purchase_price: purchasePrice,
        };
      },
    );

    return this.fplAuthClient.submitTransfers(
      teamId,
      proposal.gameweekId,
      submissions,
      {
        wildcard: proposal.chip === FplChip.WILDCARD,
        freehit: proposal.chip === FplChip.FREE_HIT,
      },
    );
  }

  // Squad composition after a successful transfer (or no transfer at all)
  // must exactly cover the proposal's lineup+bench — this validation holds
  // either way, and doubles as a safety check that a transfer actually
  // resulted in the expected squad.
  private buildPicks(currentPicks: FplPick[], proposal: Proposal): FplPick[] {
    const positionByElement = new Map<number, number>();
    proposal.lineup.forEach((id, i) => positionByElement.set(id, i + 1));
    [proposal.benchGoalkeeperId, ...proposal.benchOutfieldIds].forEach(
      (id, i) => positionByElement.set(id, 12 + i),
    );

    return currentPicks.map((pick) => {
      const position = positionByElement.get(pick.element);
      if (position === undefined) {
        throw new Error(
          `Proposal ${proposal.id} doesn't account for owned player ${pick.element} — lineup/bench must cover the full squad.`,
        );
      }
      const isCaptain = pick.element === proposal.captainId;
      const isViceCaptain = pick.element === proposal.viceCaptainId;
      return {
        ...pick,
        position,
        multiplier: position > 11 ? 0 : isCaptain ? 2 : 1,
        is_captain: isCaptain,
        is_vice_captain: isViceCaptain,
      };
    });
  }
}
