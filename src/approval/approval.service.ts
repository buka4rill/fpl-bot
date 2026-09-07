import { Injectable } from '@nestjs/common';
import { ApprovalStateMachine } from './approval.state-machine';
import { ProposalService } from '../proposal/proposal.service';
import { Approval } from '../common/types/domain.types';
import { ProposalStatus } from '../common/enums/proposal-status.enum';

type Decision = ProposalStatus.APPROVED | ProposalStatus.REJECTED;

@Injectable()
export class ApprovalService {
  constructor(
    private readonly stateMachine: ApprovalStateMachine,
    private readonly proposalService: ProposalService,
  ) {}

  decide(proposalId: string, decision: Decision, decidedBy: string): Approval {
    const proposal = this.proposalService.findById(proposalId);
    if (!proposal) {
      throw new Error(`No proposal found with id ${proposalId}.`);
    }

    if (this.isPastDeadline(proposal.deadlineAt)) {
      // A late reply never applies, even "approve" — expire instead of
      // honoring it. The fallback on silence/lateness is always "do nothing."
      this.expire(proposalId);
      throw new Error(
        'Deadline has already passed; proposal expired instead of being decided.',
      );
    }

    this.stateMachine.assertTransition(proposal.status, decision);
    this.proposalService.updateStatus(proposalId, decision);

    return {
      proposalId,
      decidedBy,
      decision,
      decidedAt: new Date().toISOString(),
    };
  }

  // Idempotent — safe to call on a proposal that's already terminal (no-op).
  expire(proposalId: string): void {
    const proposal = this.proposalService.findById(proposalId);
    if (!proposal) return;
    if (
      !this.stateMachine.canTransition(proposal.status, ProposalStatus.EXPIRED)
    ) {
      return;
    }
    this.proposalService.updateStatus(proposalId, ProposalStatus.EXPIRED);
  }

  // Sweeps every PENDING proposal whose deadline has passed without a reply.
  // Intended to be called on a schedule (SchedulerModule) — not wired to a
  // cron yet, that's part of the still-unbuilt weekly-pipeline orchestration.
  expireOverdue(): void {
    for (const proposal of this.proposalService.findAllPending()) {
      if (this.isPastDeadline(proposal.deadlineAt)) {
        this.expire(proposal.id);
      }
    }
  }

  private isPastDeadline(deadlineAt: string): boolean {
    return new Date(deadlineAt).getTime() <= Date.now();
  }
}
