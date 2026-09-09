import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSourceToProposalsAndPlayerSnapshots1788955267179 implements MigrationInterface {
  name = 'AddSourceToProposalsAndPlayerSnapshots1788955267179';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."proposals_source_enum" AS ENUM('AUTO', 'MANUAL')`,
    );
    await queryRunner.query(
      `ALTER TABLE "proposals" ADD "source" "public"."proposals_source_enum" NOT NULL DEFAULT 'MANUAL'`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."player_snapshots_source_enum" AS ENUM('AUTO', 'MANUAL')`,
    );
    await queryRunner.query(
      `ALTER TABLE "player_snapshots" ADD "source" "public"."player_snapshots_source_enum" NOT NULL DEFAULT 'MANUAL'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "player_snapshots" DROP COLUMN "source"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."player_snapshots_source_enum"`,
    );
    await queryRunner.query(`ALTER TABLE "proposals" DROP COLUMN "source"`);
    await queryRunner.query(`DROP TYPE "public"."proposals_source_enum"`);
  }
}
