import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { SquadOptimizerService } from '../optimization/squad-optimizer.service';
import {
  ChipCandidate,
  ChipEvaluatorService,
} from '../optimization/chip-evaluator.service';
import { Proposal } from '../common/types/domain.types';
import { ProposalStatus } from '../common/enums/proposal-status.enum';
import { ProposalEntity } from '../persistence/entities/proposal.entity';
import { FplChip } from '../common/enums/chip.enum';
import { TriggerSource } from '../common/enums/trigger-source.enum';

@Injectable()
export class ProposalService {
  constructor(
    private readonly squadOptimizerService: SquadOptimizerService,
    private readonly chipEvaluatorService: ChipEvaluatorService,
    @InjectRepository(ProposalEntity)
    private readonly proposalRepository: Repository<ProposalEntity>,
  ) {}

  // `freeTransfers` can't be derived from the public API (see CurrentSquad's
  // doc comment) — passed through to SquadOptimizerService, which defaults
  // it to the standard weekly amount if not given. `chip` is a manual
  // declaration ("I've decided to play this chip this week") — nothing
  // currently decides this automatically (ChipEvaluatorService is a stub).
  async generateProposal(
    freeTransfers?: number,
    chip?: FplChip,
    source: TriggerSource = TriggerSource.MANUAL,
  ): Promise<Proposal> {
    const optimization = await this.squadOptimizerService.optimizeSquad(
      freeTransfers,
      chip,
      source,
    );

    return this.store({
      gameweekId: optimization.targetGameweek.id,
      season: optimization.targetGameweek.season,
      deadlineAt: optimization.targetGameweek.deadlineAt,
      transfers: optimization.transfers,
      lineup: optimization.startingXI,
      benchGoalkeeperId: optimization.benchGoalkeeperId,
      benchOutfieldIds: optimization.benchOutfieldIds,
      captainId: optimization.captainId,
      viceCaptainId: optimization.viceCaptainId,
      chip,
      // Net of hit cost — "how many more points is this plan expected to
      // earn." Not a delta against the current squad's own predicted points
      // (that would need re-running the lineup selection on the unchanged
      // squad too); this is the new plan's own expected total.
      expectedGain: optimization.totalPredictedPoints - optimization.hitCost,
      hitCost: optimization.hitCost,
      source,
    });
  }

  // "Decide for me" path — compares no chip against every chip currently
  // available for this account (see ChipEvaluatorService) and proposes
  // whichever nets the highest real expected points, rather than always
  // assuming chip-free like generateProposal does when called without one.
  async generateBestProposal(
    freeTransfers?: number,
    availableChips?: FplChip[],
    source: TriggerSource = TriggerSource.MANUAL,
  ): Promise<{ proposal: Proposal; candidates: ChipCandidate[] }> {
    const { best, candidates } =
      await this.chipEvaluatorService.evaluateBestStrategy(
        freeTransfers,
        availableChips,
        source,
      );
    // ChipEvaluatorService always evaluates a chip-free candidate too —
    // persisted here (only when the winner actually has a chip) so
    // "Approve (without chip)" has a real, already-computed plan to fall
    // back to, potentially hours after this proposal was generated.
    const noChip = candidates.find((c) => c.chip === undefined);
    const noChipAlternative =
      best.chip !== undefined && noChip
        ? {
            transfers: noChip.optimization.transfers,
            lineup: noChip.optimization.startingXI,
            benchGoalkeeperId: noChip.optimization.benchGoalkeeperId,
            benchOutfieldIds: noChip.optimization.benchOutfieldIds,
            captainId: noChip.optimization.captainId,
            viceCaptainId: noChip.optimization.viceCaptainId,
            expectedGain: noChip.netExpectedPoints,
            hitCost: noChip.optimization.hitCost,
          }
        : undefined;

    const proposal = await this.store({
      gameweekId: best.optimization.targetGameweek.id,
      season: best.optimization.targetGameweek.season,
      deadlineAt: best.optimization.targetGameweek.deadlineAt,
      transfers: best.optimization.transfers,
      lineup: best.optimization.startingXI,
      benchGoalkeeperId: best.optimization.benchGoalkeeperId,
      benchOutfieldIds: best.optimization.benchOutfieldIds,
      captainId: best.optimization.captainId,
      viceCaptainId: best.optimization.viceCaptainId,
      chip: best.chip,
      expectedGain: best.netExpectedPoints,
      hitCost: best.optimization.hitCost,
      noChipAlternative,
      source,
    });
    return { proposal, candidates };
  }

  // Swaps in the already-computed chip-free alternative (see
  // generateBestProposal) and clears `chip` — called by ApprovalService
  // before the PENDING -> APPROVED transition when the reply was
  // "Approve (without chip)", so the transition's own re-read of the
  // proposal picks up the swap rather than the original with-chip plan.
  async applyNoChipAlternative(id: string): Promise<Proposal> {
    const proposal = await this.proposalRepository.findOneBy({ id });
    if (!proposal) {
      throw new Error(`No proposal found with id ${id}.`);
    }
    if (!proposal.noChipAlternative) {
      throw new Error(
        `Proposal ${id} has no chip-free alternative to approve.`,
      );
    }
    const alt = proposal.noChipAlternative;
    const updated: ProposalEntity = {
      ...proposal,
      transfers: alt.transfers,
      lineup: alt.lineup,
      benchGoalkeeperId: alt.benchGoalkeeperId,
      benchOutfieldIds: alt.benchOutfieldIds,
      captainId: alt.captainId,
      viceCaptainId: alt.viceCaptainId,
      expectedGain: alt.expectedGain,
      hitCost: alt.hitCost,
      chip: undefined,
    };
    return this.proposalRepository.save(updated);
  }

  // Shared by any proposal source (the optimizer, or a manual override like a
  // captain-only swap) — mints the id/status/timestamp and stores it.
  async store(
    proposal: Omit<Proposal, 'id' | 'status' | 'createdAt'>,
  ): Promise<Proposal> {
    const entity = this.proposalRepository.create({
      ...proposal,
      id: randomUUID(),
      status: ProposalStatus.PENDING,
      createdAt: new Date().toISOString(),
    });
    return this.proposalRepository.save(entity);
  }

  async findById(id: string): Promise<Proposal | undefined> {
    const proposal = await this.proposalRepository.findOneBy({ id });
    return proposal ?? undefined;
  }

  // Restart-safe "have we already *automatically* proposed for this
  // gameweek" lookup — consumed by DeadlineWatcherService instead of an
  // in-memory dedupe flag. `season` is required alongside `gameweekId`: FPL
  // resets gameweek ids to 1 every season, so a lookup on `gameweekId` alone
  // would match a prior season's proposal and silently skip generating a
  // new one. Not unique by (season, gameweekId) either (see ProposalEntity's
  // comment), so this returns whichever proposal was created first for the
  // pair.
  //
  // Scoped to source: AUTO (2026-09-09 fix) — a MANUAL proposal (a testing
  // call, /propose, /chip) must never block the scheduler's own automatic
  // proposal for that gameweek. This is exactly what happened to GW4 on
  // 2026-09-08: ~10 manual execution-testing proposals persisted before this
  // fix meant the scheduler saw "already proposed" and silently never
  // generated a real automatic one for that gameweek at all.
  async findBySeasonAndGameweekId(
    season: string,
    gameweekId: number,
  ): Promise<Proposal | undefined> {
    const proposal = await this.proposalRepository.findOneBy({
      season,
      gameweekId,
      source: TriggerSource.AUTO,
    });
    return proposal ?? undefined;
  }

  async findAllPending(): Promise<Proposal[]> {
    return this.proposalRepository.findBy({ status: ProposalStatus.PENDING });
  }

  async updateStatus(id: string, status: ProposalStatus): Promise<Proposal> {
    const proposal = await this.proposalRepository.findOneBy({ id });
    if (!proposal) {
      throw new Error(`No proposal found with id ${id}.`);
    }
    const updated: ProposalEntity = { ...proposal, status };
    return this.proposalRepository.save(updated);
  }

  // Answer to the post-deadline "did you end up making the changes
  // yourself?" check-in (ApprovalService.expire) — labels an EXPIRED
  // proposal's real-world outcome for future backtesting. Doesn't validate
  // status: a duplicate/late tap on the Yes/No buttons should just
  // overwrite the same field, not throw.
  async recordAppliedManually(id: string, applied: boolean): Promise<Proposal> {
    const proposal = await this.proposalRepository.findOneBy({ id });
    if (!proposal) {
      throw new Error(`No proposal found with id ${id}.`);
    }
    const updated: ProposalEntity = { ...proposal, appliedManually: applied };
    return this.proposalRepository.save(updated);
  }

  // Every terminal proposal (APPROVED/REJECTED/EXPIRED — PENDING is
  // deliberately excluded, there's nothing to report on yet) that hasn't
  // had its post-gameweek points report sent — consumed by ResultsService,
  // which further filters to whichever of these belong to a gameweek
  // that's actually finished by now.
  async findUnreportedTerminal(): Promise<Proposal[]> {
    return this.proposalRepository.find({
      where: [
        { status: ProposalStatus.APPROVED, resultReportedAt: IsNull() },
        { status: ProposalStatus.REJECTED, resultReportedAt: IsNull() },
        { status: ProposalStatus.EXPIRED, resultReportedAt: IsNull() },
      ],
    });
  }

  // One-time-send guard for the points report, same idea as the dedupe on
  // proposal generation itself — stops ResultsService re-sending on every
  // hourly poll once a gameweek's report has gone out.
  async markResultReported(id: string): Promise<Proposal> {
    const proposal = await this.proposalRepository.findOneBy({ id });
    if (!proposal) {
      throw new Error(`No proposal found with id ${id}.`);
    }
    const updated: ProposalEntity = {
      ...proposal,
      resultReportedAt: new Date().toISOString(),
    };
    return this.proposalRepository.save(updated);
  }
}
