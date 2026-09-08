import { Column, Entity, PrimaryColumn } from 'typeorm';
import { Gameweek } from '../../common/types/domain.types';

// Mutable "current state of this gameweek" — deadline/is_current/is_next
// shift as FPL updates bootstrap-static (blank/double gameweeks included),
// so rows are upserted by `(season, id)` rather than treated as immutable
// history. The historical part lives on PlayerSnapshotEntity instead.
// `id` alone isn't unique — FPL resets it to 1 every season — so `season`
// (derived, see season.util.ts) is part of the primary key.
@Entity('gameweeks')
export class GameweekEntity implements Gameweek {
  @PrimaryColumn('varchar')
  season: string;

  @PrimaryColumn('int')
  id: number;

  @Column({ type: 'timestamptz' })
  deadlineAt: string;

  @Column()
  isCurrent: boolean;

  @Column()
  isNext: boolean;

  @Column()
  finished: boolean;
}
