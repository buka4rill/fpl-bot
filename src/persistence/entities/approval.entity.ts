import { Column, Entity, PrimaryColumn } from 'typeorm';
import { Approval } from '../../common/types/domain.types';
import { ProposalStatus } from '../../common/enums/proposal-status.enum';

// proposalId as primary key, not a generated id: ApprovalStateMachine only
// allows one approve/reject decision per proposal, so this is a true 1:1.
@Entity('approvals')
export class ApprovalEntity implements Approval {
  @PrimaryColumn('uuid')
  proposalId: string;

  @Column('varchar')
  decidedBy: string;

  @Column({
    type: 'enum',
    enum: [ProposalStatus.APPROVED, ProposalStatus.REJECTED],
  })
  decision: ProposalStatus.APPROVED | ProposalStatus.REJECTED;

  @Column({ type: 'timestamptz' })
  decidedAt: string;
}
