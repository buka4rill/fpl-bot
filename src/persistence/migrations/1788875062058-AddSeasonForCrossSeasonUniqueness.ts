import { MigrationInterface, QueryRunner } from "typeorm";

// FPL's gameweek `id` resets to 1 every season (bootstrap-static exposes no
// season field to disambiguate — see season.util.ts), so `gameweeks`,
// `player_snapshots`, and `proposals` all need a `season` column to avoid
// silently colliding with a prior season's rows once this bot runs across a
// season rollover. This SQL mirrors season.util.ts's computeSeason() exactly
// (July/August cutover) so newly-inserted rows and this migration's backfill
// agree on the same season string for the same deadline.
const SEASON_FROM_DEADLINE = (column: string): string => `
  CASE
    WHEN EXTRACT(MONTH FROM "${column}") >= 7
    THEN LPAD((EXTRACT(YEAR FROM "${column}")::int % 100)::text, 2, '0')
      || '_' || LPAD(((EXTRACT(YEAR FROM "${column}")::int + 1) % 100)::text, 2, '0')
    ELSE LPAD(((EXTRACT(YEAR FROM "${column}")::int - 1) % 100)::text, 2, '0')
      || '_' || LPAD((EXTRACT(YEAR FROM "${column}")::int % 100)::text, 2, '0')
  END
`;

export class AddSeasonForCrossSeasonUniqueness1788875062058 implements MigrationInterface {
    name = 'AddSeasonForCrossSeasonUniqueness1788875062058'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_44a62b46ab073625f5239bee42"`);

        // proposals: has its own deadlineAt, so backfill directly.
        await queryRunner.query(`ALTER TABLE "proposals" ADD "season" character varying`);
        await queryRunner.query(`UPDATE "proposals" SET "season" = ${SEASON_FROM_DEADLINE('deadlineAt')}`);
        await queryRunner.query(`ALTER TABLE "proposals" ALTER COLUMN "season" SET NOT NULL`);

        // gameweeks: has its own deadlineAt, so backfill directly.
        await queryRunner.query(`ALTER TABLE "gameweeks" ADD "season" character varying`);
        await queryRunner.query(`UPDATE "gameweeks" SET "season" = ${SEASON_FROM_DEADLINE('deadlineAt')}`);
        await queryRunner.query(`ALTER TABLE "gameweeks" ALTER COLUMN "season" SET NOT NULL`);
        await queryRunner.query(`ALTER TABLE "gameweeks" DROP CONSTRAINT "PK_5838cf0a51140681c92c28e8114"`);
        await queryRunner.query(`ALTER TABLE "gameweeks" ADD CONSTRAINT "PK_e5be1e1740f7d1f97aa4a442dde" PRIMARY KEY ("id", "season")`);

        // player_snapshots: no deadlineAt of its own — backfill by joining
        // back to the now-populated gameweeks row for the same gameweekId.
        await queryRunner.query(`ALTER TABLE "player_snapshots" ADD "season" character varying`);
        await queryRunner.query(`UPDATE "player_snapshots" ps SET "season" = g."season" FROM "gameweeks" g WHERE g."id" = ps."gameweekId"`);
        // Pre-fix rows (before PredictionService.recordSnapshotHistory
        // started overriding gameweekId to the target gameweek) can be
        // orphaned — stamped with whatever gameweek was live at ingestion
        // time rather than the one actually being predicted for, so the
        // join above finds no matching gameweeks row. Only ever one season
        // of data exists pre-fix, so falling back to any known season is
        // safe for this one-time backfill.
        await queryRunner.query(`UPDATE "player_snapshots" SET "season" = (SELECT "season" FROM "gameweeks" LIMIT 1) WHERE "season" IS NULL`);
        await queryRunner.query(`ALTER TABLE "player_snapshots" ALTER COLUMN "season" SET NOT NULL`);
        await queryRunner.query(`ALTER TABLE "player_snapshots" DROP CONSTRAINT "PK_d0c0920b5915e40d4ae8b8c95bc"`);
        await queryRunner.query(`ALTER TABLE "player_snapshots" ADD CONSTRAINT "PK_31aaf8f10e2a352876f7868eda3" PRIMARY KEY ("gameweekId", "playerId", "season")`);

        await queryRunner.query(`CREATE INDEX "IDX_c45505a90a8d2d1bb4617b2d36" ON "proposals" ("season", "gameweekId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_c45505a90a8d2d1bb4617b2d36"`);
        await queryRunner.query(`ALTER TABLE "player_snapshots" DROP CONSTRAINT "PK_31aaf8f10e2a352876f7868eda3"`);
        await queryRunner.query(`ALTER TABLE "player_snapshots" ADD CONSTRAINT "PK_d0c0920b5915e40d4ae8b8c95bc" PRIMARY KEY ("gameweekId", "playerId")`);
        await queryRunner.query(`ALTER TABLE "player_snapshots" DROP COLUMN "season"`);
        await queryRunner.query(`ALTER TABLE "gameweeks" DROP CONSTRAINT "PK_e5be1e1740f7d1f97aa4a442dde"`);
        await queryRunner.query(`ALTER TABLE "gameweeks" ADD CONSTRAINT "PK_5838cf0a51140681c92c28e8114" PRIMARY KEY ("id")`);
        await queryRunner.query(`ALTER TABLE "gameweeks" DROP COLUMN "season"`);
        await queryRunner.query(`ALTER TABLE "proposals" DROP COLUMN "season"`);
        await queryRunner.query(`CREATE INDEX "IDX_44a62b46ab073625f5239bee42" ON "proposals" ("gameweekId") `);
    }

}
