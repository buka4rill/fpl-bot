import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ApprovalStateMachine } from './approval.state-machine';
import { ProposalService } from '../proposal/proposal.service';
import { ExecutionService } from '../execution/execution.service';
import { AlertService } from '../alert/alert.service';
import { Approval, Proposal } from '../common/types/domain.types';
import { ProposalStatus } from '../common/enums/proposal-status.enum';
import { ApprovalEntity } from '../persistence/entities/approval.entity';

type Decision = ProposalStatus.APPROVED | ProposalStatus.REJECTED;

@Injectable()
export class ApprovalService {
  private readonly logger = new Logger(ApprovalService.name);

  constructor(
    private readonly stateMachine: ApprovalStateMachine,
    private readonly proposalService: ProposalService,
    private readonly executionService: ExecutionService,
    private readonly alertService: AlertService,
    @InjectRepository(ApprovalEntity)
    private readonly approvalRepository: Repository<ApprovalEntity>,
  ) {}

  async decide(
    proposalId: string,
    decision: Decision,
    decidedBy: string,
  ): Promise<Approval> {
    const proposal = await this.proposalService.findById(proposalId);
    if (!proposal) {
      throw new Error(`No proposal found with id ${proposalId}.`);
    }

    if (this.isPastDeadline(proposal.deadlineAt)) {
      // A late reply never applies, even "approve" — expire instead of
      // honoring it. The fallback on silence/lateness is always "do nothing."
      await this.expire(proposalId);
      throw new Error(
        'Deadline has already passed; proposal expired instead of being decided.',
      );
    }

    this.stateMachine.assertTransition(proposal.status, decision);
    const updated = await this.proposalService.updateStatus(
      proposalId,
      decision,
    );

    const approval: Approval = {
      proposalId,
      decidedBy,
      decision,
      decidedAt: new Date().toISOString(),
    };
    await this.approvalRepository.save(
      this.approvalRepository.create(approval),
    );

    if (decision === ProposalStatus.APPROVED) {
      // Best-effort: an execution failure shouldn't undo the recorded
      // approval — it's surfaced loudly via Telegram instead (ARCHITECTURE.md
      // §10), and the caller (Telegram webhook) still gets a clean response.
      await this.applyApproved(updated);
    }

    return approval;
  }

  private async applyApproved(proposal: Proposal): Promise<void> {
    try {
      await this.executionService.apply(proposal);
      await this.alertService.sendExecutionResult(proposal, true);
    } catch (error) {
      this.logger.error(
        `Execution failed for proposal ${proposal.id}: ${String(error)}`,
      );
      await this.alertService.sendExecutionResult(
        proposal,
        false,
        String(error),
      );
    }
  }

  // Idempotent — safe to call on a proposal that's already terminal (no-op).
  async expire(proposalId: string): Promise<void> {
    const proposal = await this.proposalService.findById(proposalId);
    if (!proposal) return;
    if (
      !this.stateMachine.canTransition(proposal.status, ProposalStatus.EXPIRED)
    ) {
      return;
    }
    await this.proposalService.updateStatus(proposalId, ProposalStatus.EXPIRED);
  }

  // Sweeps every PENDING proposal whose deadline has passed without a reply.
  // Intended to be called on a schedule (SchedulerModule).
  async expireOverdue(): Promise<void> {
    for (const proposal of await this.proposalService.findAllPending()) {
      if (this.isPastDeadline(proposal.deadlineAt)) {
        await this.expire(proposal.id);
      }
    }
  }

  private isPastDeadline(deadlineAt: string): boolean {
    return new Date(deadlineAt).getTime() <= Date.now();
  }
}
