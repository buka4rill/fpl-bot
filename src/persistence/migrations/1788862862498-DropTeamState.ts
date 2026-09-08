import { MigrationInterface, QueryRunner } from 'typeorm';

// `migration:generate` didn't detect this table as extraneous (TypeORM's
// schema diff apparently only compares tables tracked by remaining entity
// metadata, not "table exists in DB but no entity refers to it anymore") —
// written by hand instead, mirroring AddTeamState1788829934785's own
// CREATE TABLE statement in reverse.
export class DropTeamState1788862862498 implements MigrationInterface {
  name = 'DropTeamState1788862862498';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "team_state"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "team_state" ("teamId" integer NOT NULL, "freeTransfers" integer, "freeTransfersAsOfGameweekId" integer, "wildcard1Available" boolean NOT NULL DEFAULT true, "freeHit1Available" boolean NOT NULL DEFAULT true, "benchBoost1Available" boolean NOT NULL DEFAULT true, "tripleCaptain1Available" boolean NOT NULL DEFAULT true, "wildcard2Available" boolean NOT NULL DEFAULT true, "freeHit2Available" boolean NOT NULL DEFAULT true, "benchBoost2Available" boolean NOT NULL DEFAULT true, "tripleCaptain2Available" boolean NOT NULL DEFAULT true, "pendingPromptStep" character varying, "pendingPromptGameweekId" integer, CONSTRAINT "PK_db1291a431c038a52180f905aa4" PRIMARY KEY ("teamId"))`,
    );
  }
}
