import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { Proposal, TransferPlan } from '../../common/types/domain.types';
import { ProposalStatus } from '../../common/enums/proposal-status.enum';
import { FplChip } from '../../common/enums/chip.enum';

// gameweekId is deliberately indexed, not unique: ProposalController's
// manual captain-swap override can legitimately create a second proposal
// for the same gameweek (CLAUDE.md — low-risk execution testing).
@Entity('proposals')
@Index(['gameweekId'])
export class ProposalEntity implements Proposal {
  @PrimaryColumn('uuid')
  id: string;

  @Column('int')
  gameweekId: number;

  @Column({ type: 'timestamptz' })
  deadlineAt: string;

  @Column('jsonb')
  transfers: TransferPlan[];

  @Column('jsonb')
  lineup: number[];

  @Column('int')
  benchGoalkeeperId: number;

  @Column('jsonb')
  benchOutfieldIds: number[];

  @Column('int')
  captainId: number;

  @Column('int')
  viceCaptainId: number;

  @Column({ type: 'enum', enum: FplChip, nullable: true })
  chip?: FplChip;

  @Column('float')
  expectedGain: number;

  @Column('float')
  hitCost: number;

  @Column({ type: 'enum', enum: ProposalStatus })
  status: ProposalStatus;

  @Column({ type: 'timestamptz' })
  createdAt: string;

  @Column({ type: 'boolean', nullable: true })
  appliedManually?: boolean | null;
}
