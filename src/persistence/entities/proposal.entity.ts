import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import {
  NoChipAlternative,
  Proposal,
  TransferPlan,
} from '../../common/types/domain.types';
import { ProposalStatus } from '../../common/enums/proposal-status.enum';
import { FplChip } from '../../common/enums/chip.enum';
import { TriggerSource } from '../../common/enums/trigger-source.enum';

// (season, gameweekId) is deliberately indexed, not unique: ProposalController's
// manual captain-swap override can legitimately create a second proposal
// for the same gameweek (CLAUDE.md — low-risk execution testing). `season`
// is required alongside `gameweekId` — FPL resets gameweek ids to 1 every
// season, so ProposalService's restart-safe "already proposed this
// gameweek" lookup needs both to avoid matching a prior season's row.
// `Omit<Proposal, 'chip'>`, not the full `Proposal` (2026-09-09) — `chip`
// below is intentionally typed `FplChip | null | undefined`, wider than the
// domain interface's `FplChip | undefined`, since that's the honest
// persistence-level reality of a nullable TypeORM column (see its own
// comment). Same "persistence-only extra/wider field" pattern as
// PlayerSnapshotEntity's `season`/`capturedAt`/`source`, just on the typing
// of an existing field rather than an added one. ProposalService.toDomain
// normalizes it back to the domain contract before any Proposal ever leaves
// that service.
@Entity('proposals')
@Index(['season', 'gameweekId'])
export class ProposalEntity implements Omit<Proposal, 'chip'> {
  @PrimaryColumn('uuid')
  id: string;

  @Column('varchar')
  season: string;

  @Column('int')
  gameweekId: number;

  // Defaults to MANUAL at the DB level purely so the migration can backfill
  // existing rows safely — every code path already supplies this explicitly
  // (Proposal.source is required on the domain interface), this default is
  // defense-in-depth, not load-bearing.
  @Column({ type: 'enum', enum: TriggerSource, default: TriggerSource.MANUAL })
  source: TriggerSource;

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

  // `| null`, not just `?:` (2026-09-09 fix) — TypeORM's Postgres driver
  // returns `null` (not `undefined`) for a NULL nullable column on read, and
  // — the actual bug this fixes — silently ignores an `undefined` property
  // on `save()` rather than clearing the column, so a plain `chip: undefined`
  // could never actually clear a previously-set chip. Every other nullable
  // column on this entity was already typed `| null` (see
  // `appliedManually`/`resultReportedAt`/`noChipAlternative` below); `chip`
  // was the one that got missed, and it's the reason "Approve (without
  // chip)" could leave a stale chip value in the DB — see
  // ProposalService.toDomain/applyNoChipAlternative.
  @Column({ type: 'enum', enum: FplChip, nullable: true })
  chip?: FplChip | null;

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

  @Column({ type: 'timestamptz', nullable: true })
  resultReportedAt?: string | null;

  @Column({ type: 'boolean', nullable: true })
  divergedFromPlan?: boolean | null;

  @Column({ type: 'jsonb', nullable: true })
  noChipAlternative?: NoChipAlternative | null;
}
