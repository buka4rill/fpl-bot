import { Injectable } from '@nestjs/common';
import { ApprovalStateMachine } from './approval.state-machine';

@Injectable()
export class ApprovalService {
  constructor(private readonly stateMachine: ApprovalStateMachine) {}
}
