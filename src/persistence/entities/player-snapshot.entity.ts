import { Column, Entity, PrimaryColumn } from 'typeorm';
import { PlayerSnapshot } from '../../common/types/domain.types';

// One row per (gameweek, player) — not overwritten across gameweeks, so this
// is the backtestable history ARCHITECTURE.md §6 calls for. Written
// best-effort from PredictionService.predictGameweek() at the moment a
// proposal is generated, capturing what the model actually saw.
@Entity('player_snapshots')
export class PlayerSnapshotEntity implements PlayerSnapshot {
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
