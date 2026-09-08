import { Column, Entity, PrimaryColumn } from 'typeorm';
import { TeamState } from '../../common/types/domain.types';

// Singleton row keyed by the real team id (fpl.teamId config) — same "real
// business key, no synthetic PK" precedent as ApprovalEntity/GameweekEntity.
// This bot serves exactly one FPL team, so one row is a genuine singleton,
// not an arbitrarily-chosen row among many.
@Entity('team_state')
export class TeamStateEntity implements TeamState {
  @PrimaryColumn('int')
  teamId: number;

  @Column({ type: 'int', nullable: true })
  freeTransfers: number | null;

  @Column({ type: 'int', nullable: true })
  freeTransfersAsOfGameweekId: number | null;

  @Column({ default: true })
  wildcard1Available: boolean;

  @Column({ default: true })
  freeHit1Available: boolean;

  @Column({ default: true })
  benchBoost1Available: boolean;

  @Column({ default: true })
  tripleCaptain1Available: boolean;

  @Column({ default: true })
  wildcard2Available: boolean;

  @Column({ default: true })
  freeHit2Available: boolean;

  @Column({ default: true })
  benchBoost2Available: boolean;

  @Column({ default: true })
  tripleCaptain2Available: boolean;

  // A TeamStateService PromptStep key, or null when no prompt is in flight.
  // Plain varchar, not a Postgres enum like proposals_chip_enum — this is
  // internal control-flow state, not domain data, and may grow new step
  // keys later without needing an ALTER TYPE migration.
  @Column({ type: 'varchar', nullable: true })
  pendingPromptStep: string | null;

  @Column({ type: 'int', nullable: true })
  pendingPromptGameweekId: number | null;
}
