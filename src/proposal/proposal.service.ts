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

  async generateProposal(): Promise<Proposal> {
    const optimization = await this.squadOptimizerService.optimizeSquad();

    const proposal: Proposal = {
      id: randomUUID(),
      gameweekId: optimization.targetGameweek.id,
      deadlineAt: optimization.targetGameweek.deadlineAt,
      // No current-squad ingestion yet (entry/picks endpoints) — this is a
      // from-scratch squad recommendation, not a diff against an existing
      // team, so there's nothing to compute transfers or a hit cost from.
      transfers: [],
      lineup: optimization.startingXI,
      captainId: optimization.captainId,
      viceCaptainId: optimization.viceCaptainId,
      expectedGain: optimization.totalPredictedPoints,
      hitCost: 0,
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
