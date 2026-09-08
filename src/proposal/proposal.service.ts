import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { SquadOptimizerService } from '../optimization/squad-optimizer.service';
import { Proposal } from '../common/types/domain.types';
import { ProposalStatus } from '../common/enums/proposal-status.enum';
import { ProposalEntity } from '../persistence/entities/proposal.entity';
import { FplChip } from '../common/enums/chip.enum';

@Injectable()
export class ProposalService {
  constructor(
    private readonly squadOptimizerService: SquadOptimizerService,
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
  ): Promise<Proposal> {
    const optimization = await this.squadOptimizerService.optimizeSquad(
      freeTransfers,
      chip,
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
    });
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

  // Restart-safe "have we already proposed for this gameweek" lookup —
  // consumed by DeadlineWatcherService instead of an in-memory dedupe flag.
  // `season` is required alongside `gameweekId`: FPL resets gameweek ids to
  // 1 every season, so a lookup on `gameweekId` alone would match a prior
  // season's proposal and silently skip generating a new one. Not unique by
  // (season, gameweekId) either (see ProposalEntity's comment), so this
  // returns whichever proposal was created first for the pair.
  async findBySeasonAndGameweekId(
    season: string,
    gameweekId: number,
  ): Promise<Proposal | undefined> {
    const proposal = await this.proposalRepository.findOneBy({
      season,
      gameweekId,
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
