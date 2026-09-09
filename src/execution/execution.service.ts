import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FplAuthClient } from '../auth/clients/fpl-auth.client';
import {
  FplChipStatus,
  FplMyTeam,
  FplPick,
  FplTransferSubmission,
  FplTransfersState,
} from '../auth/clients/fpl-auth.types';
import {
  CurrentSquad,
  Proposal,
  ExecutionLog,
} from '../common/types/domain.types';
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

// FPL's setLineup response can lag its own backend — confirmed live
// 2026-09-08 (and again 2026-09-09, twice, which is what pushed the budget
// below from config.execution.* — see its own comment) that a chip which
// had genuinely landed still showed unplayed (played_by_entry: []) for a
// while after. Re-checking a few times before concluding a chip actually
// failed avoids reporting a false "execution FAILED" alert for something
// that actually succeeded.
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Handles lineup/captain, transfers, and chips (ARCHITECTURE.md §11 build
// order step 4). The /api/transfers/ contract this relies on was never
// captured live (unlike /api/my-team/, see project memory
// fpl-write-api-contract) — sourced from a community library instead (see
// fpl-auth.types.ts) and needs live confirmation the first time this
// actually runs against a real transfer or chip.
@Injectable()
export class ExecutionService {
  private readonly logger = new Logger(ExecutionService.name);

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

    let lineupResult: FplMyTeam | { error: string };
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

    // A clean HTTP response from setLineup/submitTransfers only means FPL
    // didn't reject the request — confirmed live 2026-09-08 that a declared
    // chip can be silently dropped rather than rejected (this account's
    // Free Hit: submitTransfers returned its usual empty-body 200, but the
    // my-team state setLineup returns straight after still showed
    // status_for_entry: 'unavailable', played_by_entry: [] for freehit —
    // exactly the same shape a genuine failure would leave, just without an
    // error to catch). The signal that actually confirms a chip landing is
    // played_by_entry including the *gameweek* it was played in — see
    // isChipPlayed's own comment for the real bug this was until
    // 2026-09-09 (it compared against the team id instead, which can never
    // match).
    let chipConfirmed = true;
    // Captured regardless of outcome (2026-09-09) — persisted into the
    // execution log below so a false negative can actually be diagnosed
    // afterward instead of guessing. The first three real occurrences of
    // this false-negative failure mode (2026-09-08, then twice more
    // 2026-09-09 even after widening the retry budget once already) left
    // zero trail beyond "it failed, then a later unrelated check showed it
    // had actually landed" — nothing recorded what each retry actually saw.
    const chipConfirmationAttempts: Array<{
      attempt: number;
      confirmed: boolean;
      chips: FplChipStatus[];
    }> = [];
    if (success && proposal.chip !== undefined) {
      const declaredChipName: string = proposal.chip;
      chipConfirmed = this.isChipPlayed(
        (lineupResult as FplMyTeam).chips,
        declaredChipName,
        proposal.gameweekId,
      );
      chipConfirmationAttempts.push({
        attempt: 0,
        confirmed: chipConfirmed,
        chips: (lineupResult as FplMyTeam).chips,
      });
      this.logger.log(
        `Chip confirmation for proposal ${proposal.id} ("${declaredChipName}"), initial setLineup response: confirmed=${chipConfirmed}`,
      );
      const retries = Number(
        this.config.get<number>('execution.chipConfirmationRetries') ?? 15,
      );
      const retryDelayMs = Number(
        this.config.get<number>('execution.chipConfirmationRetryDelayMs') ??
          8000,
      );
      for (let attempt = 1; !chipConfirmed && attempt <= retries; attempt++) {
        await sleep(retryDelayMs);
        const recheck = await this.fplAuthClient.getMyTeam(teamId);
        chipConfirmed = this.isChipPlayed(
          recheck.chips,
          declaredChipName,
          proposal.gameweekId,
        );
        chipConfirmationAttempts.push({
          attempt,
          confirmed: chipConfirmed,
          chips: recheck.chips,
        });
        this.logger.log(
          `Chip confirmation for proposal ${proposal.id} ("${declaredChipName}"), retry ${attempt}/${retries}: confirmed=${chipConfirmed}`,
        );
      }
      if (!chipConfirmed) {
        this.logger.warn(
          `Chip confirmation for proposal ${proposal.id} ("${declaredChipName}") never confirmed after ${retries} retries (${(retries * retryDelayMs) / 1000}s) — reporting execution as failed. Last chips seen: ${JSON.stringify(chipConfirmationAttempts.at(-1)?.chips)}`,
        );
        success = false;
      }
    }

    const log = await this.executionLogRepository.save(
      this.executionLogRepository.create({
        proposalId: proposal.id,
        requestPayload: { transfers: proposal.transfers, picks },
        responsePayload: {
          transfersResult,
          lineupResult,
          chipConfirmationAttempts,
        },
        appliedAt: new Date().toISOString(),
        success,
      }),
    );

    if (!success) {
      // The transfer (if any) already went through by this point — the
      // squad has changed even though this "failed." Say so plainly rather
      // than a generic failure message (CLAUDE.md: fail loudly, never
      // silently, and never understate what actually happened).
      const message = !chipConfirmed
        ? `Transfers/lineup were applied for proposal ${proposal.id}, but FPL still hasn't confirmed the "${proposal.chip}" chip as played after ${chipConfirmationAttempts.length - 1} retries — this has turned out to be a false alarm before (FPL's own confirmation can lag longer than this check waits), so check /status yourself before assuming it genuinely failed. See execution log ${log.id}.`
        : usesTransferEndpoint
          ? `Transfers were applied for proposal ${proposal.id}, but setting the final lineup/captain failed — check the FPL app directly. See execution log ${log.id}.`
          : `Execution failed for proposal ${proposal.id} — see execution log ${log.id}.`;
      throw new Error(message);
    }
    return log;
  }

  // The real bug behind three false "execution FAILED" alerts in two days
  // (2026-09-09) — `played_by_entry` is FPL's list of *gameweek/event ids*
  // this chip was played in (a chip can be played at most once per half of
  // the season, so this is a short list of event numbers, e.g. `[4]`
  // meaning "played in gameweek 4" — not, as this used to assume, a list of
  // team/entry ids). Comparing it against `teamId` could never match any
  // real account (the response is already scoped to *your* team by the
  // `/my-team/{teamId}/` URL itself — there's no other team to disambiguate
  // from), so this confirmation check was structurally incapable of ever
  // succeeding regardless of how many retries or how long the delay — every
  // widening of the retry budget that day was chasing the wrong root cause.
  // Diagnosed from the `chipConfirmationAttempts` log added the same day:
  // the very last retry's own recorded data showed the chip genuinely
  // active with `played_by_entry: [4]` (gameweek 4, correctly), yet still
  // read as unconfirmed because `4 !== teamId` (10594985 for this account).
  private isChipPlayed(
    chips: FplChipStatus[],
    declaredChipName: string,
    gameweekId: number,
  ): boolean {
    return chips.some(
      (status) =>
        status.name === declaredChipName &&
        status.played_by_entry.includes(gameweekId),
    );
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

  // Same CurrentSquad shape IngestionService.getCurrentSquad() produces
  // from the *public* entry/picks endpoint, but sourced from the
  // authenticated my-team endpoint instead — added 2026-09-08 because the
  // public path 404s for an account with no completed-gameweek picks
  // history (discovered testing against the disposable test account;
  // PredictionService now calls this instead so the optimizer-driven
  // proposal flow — including the automatic weekly one — doesn't silently
  // depend on that account quirk). `gameweekId` isn't available from
  // my-team the way the public endpoint's `entry_history.event` gives it
  // directly, so the caller supplies the gameweek it's actually predicting
  // for — not load-bearing for SquadOptimizerService either way (it only
  // reads `playerIds`/`bank`/`teamValue`).
  async getCurrentSquad(
    teamId: number,
    gameweekId: number,
  ): Promise<CurrentSquad> {
    const current = await this.fplAuthClient.getMyTeam(teamId);
    const activeChipStatus = current.chips.find(
      (chip) => chip.status_for_entry === 'active',
    );
    const knownChipNames: readonly string[] = Object.values(FplChip);
    const activeChip =
      activeChipStatus && knownChipNames.includes(activeChipStatus.name)
        ? (activeChipStatus.name as FplChip)
        : undefined;

    return {
      teamId,
      gameweekId,
      playerIds: current.picks.map((pick) => pick.element),
      bank: current.transfers.bank / 10,
      teamValue: current.transfers.value / 10,
      activeChip,
    };
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
