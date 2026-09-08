import { Column, Entity, PrimaryColumn } from 'typeorm';
import { PlayerSnapshot } from '../../common/types/domain.types';

// One row per (season, gameweek, player) — not overwritten across
// gameweeks, so this is the backtestable history ARCHITECTURE.md §6 calls
// for. Written best-effort from PredictionService.predictGameweek() at the
// moment a proposal is generated, capturing what the model actually saw.
// `season` (persistence-only — not on the PlayerSnapshot domain interface,
// same pattern as `capturedAt` below; set explicitly by
// PredictionService.recordSnapshotHistory from the target Gameweek's own
// `season`) is part of the primary key because `gameweekId` alone resets to
// 1 every season — without it, next season's GW4 snapshot for a player
// would silently overwrite this season's GW4 snapshot for the same player.
@Entity('player_snapshots')
export class PlayerSnapshotEntity implements PlayerSnapshot {
  @PrimaryColumn('varchar')
  season: string;

  @PrimaryColumn('int')
  gameweekId: number;

  @PrimaryColumn('int')
  playerId: number;

  @Column('float')
  price: number;

  @Column('float')
  ownershipPct: number;

  @Column({ type: 'float', nullable: true })
  predictedPoints?: number;

  @Column({ type: 'float', nullable: true })
  form?: number;

  @Column({ type: 'float', nullable: true })
  xg?: number;

  @Column({ type: 'float', nullable: true })
  xa?: number;

  @Column({ type: 'int', nullable: true })
  minutesPlayed?: number;

  @Column({ type: 'varchar', nullable: true })
  status?: string;

  @Column({ type: 'int', nullable: true })
  chanceOfPlayingNextRound?: number | null;

  @Column({ type: 'int', nullable: true })
  nextFixtureDifficulty?: number;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  capturedAt: string;
}
