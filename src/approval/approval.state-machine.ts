import { Injectable } from '@nestjs/common';

// PENDING -> APPROVED / REJECTED / EXPIRED, bound to a specific proposal ID
// so a stray reply can't approve the wrong gameweek. Silence before the
// deadline resolves to EXPIRED — never APPROVED.
@Injectable()
export class ApprovalStateMachine {
  // TODO: implement transitions.
}
