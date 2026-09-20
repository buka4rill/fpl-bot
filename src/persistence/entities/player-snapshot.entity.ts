import { Column, Entity, PrimaryColumn } from 'typeorm';
import { PlayerSnapshot } from '../../common/types/domain.types';
import { Position } from '../../common/enums/position.enum';
import { TriggerSource } from '../../common/enums/trigger-source.enum';

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

  @Column({ type: 'varchar', nullable: true })
  position?: Position;

  @Column({ type: 'int', nullable: true })
  defensiveContribution?: number;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  capturedAt: string;

  // Persistence-only, same pattern as `season` above — not on the
  // PlayerSnapshot domain interface, since PredictionService.recordSnapshotHistory
  // is the only place this is known when a snapshot entity is created.
  // Defaults to MANUAL at the DB level purely so the migration can backfill
  // existing rows safely (see ProposalEntity.source's comment).
  @Column({ type: 'enum', enum: TriggerSource, default: TriggerSource.MANUAL })
  source: TriggerSource;

  // Persistence-only, same pattern as `capturedAt`/`source` above — unknown
  // at snapshot time (a prediction is always for an upcoming gameweek), so
  // starts null and is filled in by ResultsService's hourly poll once the
  // gameweek this row is for actually finishes, from the same public
  // live-gameweek data IngestionService.getGameweekPlayerStats already
  // normalizes for the proposal-level result report. This is the join
  // ARCHITECTURE.md §11 step 5's backtesting needs against `predictedPoints`
  // above — added ahead of that work (2026-09-20) specifically so it starts
  // accumulating from GW5 rather than only from whenever step 5 begins.
  @Column({ type: 'float', nullable: true })
  actualPoints?: number | null;
}
