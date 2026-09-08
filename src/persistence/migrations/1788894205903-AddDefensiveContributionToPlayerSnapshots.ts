import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddDefensiveContributionToPlayerSnapshots1788894205903 implements MigrationInterface {
  name = 'AddDefensiveContributionToPlayerSnapshots1788894205903';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "player_snapshots" ADD "position" character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "player_snapshots" ADD "defensiveContribution" integer`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "player_snapshots" DROP COLUMN "defensiveContribution"`,
    );
    await queryRunner.query(
      `ALTER TABLE "player_snapshots" DROP COLUMN "position"`,
    );
  }
}
