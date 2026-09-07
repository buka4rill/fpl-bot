import { MigrationInterface, QueryRunner } from 'typeorm';

export class Init1788815396281 implements MigrationInterface {
  name = 'Init1788815396281';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Needed for execution_logs.id's uuid_generate_v4() default — ships
    // in postgres:16-alpine's contrib package but isn't enabled by default.
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await queryRunner.query(
      `CREATE TYPE "public"."approvals_decision_enum" AS ENUM('APPROVED', 'REJECTED')`,
    );
    await queryRunner.query(
      `CREATE TABLE "approvals" ("proposalId" uuid NOT NULL, "decidedBy" character varying NOT NULL, "decision" "public"."approvals_decision_enum" NOT NULL, "decidedAt" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_7e28664f316daeae730bb8e6def" PRIMARY KEY ("proposalId"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "execution_logs" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "proposalId" uuid NOT NULL, "requestPayload" jsonb NOT NULL, "responsePayload" jsonb NOT NULL, "appliedAt" TIMESTAMP WITH TIME ZONE NOT NULL, "success" boolean NOT NULL, CONSTRAINT "PK_9db55f176b2d494e695536f03a7" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_7c7c578a6516264dbdca36330b" ON "execution_logs"  ("proposalId") `,
    );
    await queryRunner.query(
      `CREATE TABLE "player_snapshots" ("gameweekId" integer NOT NULL, "playerId" integer NOT NULL, "price" double precision NOT NULL, "ownershipPct" double precision NOT NULL, "predictedPoints" double precision, "form" double precision, "xg" double precision, "xa" double precision, "minutesPlayed" integer, "status" character varying, "chanceOfPlayingNextRound" integer, "nextFixtureDifficulty" integer, "capturedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_d0c0920b5915e40d4ae8b8c95bc" PRIMARY KEY ("gameweekId", "playerId"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "gameweeks" ("id" integer NOT NULL, "deadlineAt" TIMESTAMP WITH TIME ZONE NOT NULL, "isCurrent" boolean NOT NULL, "isNext" boolean NOT NULL, "finished" boolean NOT NULL, CONSTRAINT "PK_5838cf0a51140681c92c28e8114" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."proposals_chip_enum" AS ENUM('wildcard', 'freehit', 'bboost', '3xc')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."proposals_status_enum" AS ENUM('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED')`,
    );
    await queryRunner.query(
      `CREATE TABLE "proposals" ("id" uuid NOT NULL, "gameweekId" integer NOT NULL, "deadlineAt" TIMESTAMP WITH TIME ZONE NOT NULL, "transfers" jsonb NOT NULL, "lineup" jsonb NOT NULL, "benchGoalkeeperId" integer NOT NULL, "benchOutfieldIds" jsonb NOT NULL, "captainId" integer NOT NULL, "viceCaptainId" integer NOT NULL, "chip" "public"."proposals_chip_enum", "expectedGain" double precision NOT NULL, "hitCost" double precision NOT NULL, "status" "public"."proposals_status_enum" NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_db524c8db8e126a38a2f16d8cac" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_44a62b46ab073625f5239bee42" ON "proposals"  ("gameweekId") `,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."IDX_44a62b46ab073625f5239bee42"`,
    );
    await queryRunner.query(`DROP TABLE "proposals"`);
    await queryRunner.query(`DROP TYPE "public"."proposals_status_enum"`);
    await queryRunner.query(`DROP TYPE "public"."proposals_chip_enum"`);
    await queryRunner.query(`DROP TABLE "gameweeks"`);
    await queryRunner.query(`DROP TABLE "player_snapshots"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_7c7c578a6516264dbdca36330b"`,
    );
    await queryRunner.query(`DROP TABLE "execution_logs"`);
    await queryRunner.query(`DROP TABLE "approvals"`);
    await queryRunner.query(`DROP TYPE "public"."approvals_decision_enum"`);
  }
}
