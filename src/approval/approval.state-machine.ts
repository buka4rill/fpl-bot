import { Injectable } from '@nestjs/common';
import { ProposalStatus } from '../common/enums/proposal-status.enum';

// PENDING -> APPROVED / REJECTED / EXPIRED, bound to a specific proposal ID
// so a stray reply can't approve the wrong gameweek. Silence before the
// deadline resolves to EXPIRED — never APPROVED. All three outcomes are
// terminal: once decided (or expired), nothing can flip the status again —
// including a late "approve" arriving after an EXPIRED sweep.
const VALID_TRANSITIONS: Record<ProposalStatus, ProposalStatus[]> = {
  [ProposalStatus.PENDING]: [
    ProposalStatus.APPROVED,
    ProposalStatus.REJECTED,
    ProposalStatus.EXPIRED,
  ],
  [ProposalStatus.APPROVED]: [],
  [ProposalStatus.REJECTED]: [],
  [ProposalStatus.EXPIRED]: [],
};

@Injectable()
export class ApprovalStateMachine {
  canTransition(from: ProposalStatus, to: ProposalStatus): boolean {
    return VALID_TRANSITIONS[from].includes(to);
  }

  assertTransition(from: ProposalStatus, to: ProposalStatus): void {
    if (!this.canTransition(from, to)) {
      throw new Error(`Cannot transition a proposal from ${from} to ${to}.`);
    }
  }
}
