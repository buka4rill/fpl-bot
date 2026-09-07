import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { SquadOptimizerService } from '../optimization/squad-optimizer.service';
import { Proposal } from '../common/types/domain.types';
import { ProposalStatus } from '../common/enums/proposal-status.enum';

@Injectable()
export class ProposalService {
  // Placeholder store until a persistence layer is chosen (CLAUDE.md — no
  // ORM installed yet). State resets on restart; swap for a real repository
  // once the DB decision is made.
  private readonly proposals = new Map<string, Proposal>();

  constructor(private readonly squadOptimizerService: SquadOptimizerService) {}

  // `freeTransfers` can't be derived from the public API (see CurrentSquad's
  // doc comment) — passed through to SquadOptimizerService, which defaults
  // it to the standard weekly amount if not given.
  async generateProposal(freeTransfers?: number): Promise<Proposal> {
    const optimization =
      await this.squadOptimizerService.optimizeSquad(freeTransfers);

    const proposal: Proposal = {
      id: randomUUID(),
      gameweekId: optimization.targetGameweek.id,
      deadlineAt: optimization.targetGameweek.deadlineAt,
      transfers: optimization.transfers,
      lineup: optimization.startingXI,
      benchGoalkeeperId: optimization.benchGoalkeeperId,
      benchOutfieldIds: optimization.benchOutfieldIds,
      captainId: optimization.captainId,
      viceCaptainId: optimization.viceCaptainId,
      // Net of hit cost — "how many more points is this plan expected to
      // earn." Not a delta against the current squad's own predicted points
      // (that would need re-running the lineup selection on the unchanged
      // squad too); this is the new plan's own expected total.
      expectedGain: optimization.totalPredictedPoints - optimization.hitCost,
      hitCost: optimization.hitCost,
      status: ProposalStatus.PENDING,
      createdAt: new Date().toISOString(),
    };

    this.proposals.set(proposal.id, proposal);
    return proposal;
  }

  findById(id: string): Proposal | undefined {
    return this.proposals.get(id);
  }

  findAllPending(): Proposal[] {
    return [...this.proposals.values()].filter(
      (proposal) => proposal.status === ProposalStatus.PENDING,
    );
  }

  updateStatus(id: string, status: ProposalStatus): Proposal {
    const proposal = this.proposals.get(id);
    if (!proposal) {
      throw new Error(`No proposal found with id ${id}.`);
    }
    const updated: Proposal = { ...proposal, status };
    this.proposals.set(id, updated);
    return updated;
  }
}
