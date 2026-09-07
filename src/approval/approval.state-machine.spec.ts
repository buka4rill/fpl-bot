import { ApprovalStateMachine } from './approval.state-machine';
import { ProposalStatus } from '../common/enums/proposal-status.enum';

describe('ApprovalStateMachine', () => {
  let stateMachine: ApprovalStateMachine;

  beforeEach(() => {
    stateMachine = new ApprovalStateMachine();
  });

  it.each([
    [ProposalStatus.PENDING, ProposalStatus.APPROVED],
    [ProposalStatus.PENDING, ProposalStatus.REJECTED],
    [ProposalStatus.PENDING, ProposalStatus.EXPIRED],
  ])('allows %s -> %s', (from, to) => {
    expect(stateMachine.canTransition(from, to)).toBe(true);
    expect(() => stateMachine.assertTransition(from, to)).not.toThrow();
  });

  it.each([
    [ProposalStatus.APPROVED, ProposalStatus.REJECTED],
    [ProposalStatus.APPROVED, ProposalStatus.EXPIRED],
    [ProposalStatus.APPROVED, ProposalStatus.PENDING],
    [ProposalStatus.REJECTED, ProposalStatus.APPROVED],
    [ProposalStatus.EXPIRED, ProposalStatus.APPROVED],
    [ProposalStatus.PENDING, ProposalStatus.PENDING],
  ])('rejects %s -> %s (terminal states cannot be reopened)', (from, to) => {
    expect(stateMachine.canTransition(from, to)).toBe(false);
    expect(() => stateMachine.assertTransition(from, to)).toThrow(
      `Cannot transition a proposal from ${from} to ${to}.`,
    );
  });
});
