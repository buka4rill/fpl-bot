import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { ExecutionLog } from '../../common/types/domain.types';

@Entity('execution_logs')
export class ExecutionLogEntity implements ExecutionLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column('uuid')
  proposalId: string;

  @Column('jsonb')
  requestPayload: unknown;

  @Column('jsonb')
  responsePayload: unknown;

  @Column({ type: 'timestamptz' })
  appliedAt: string;

  @Column()
  success: boolean;
}
