import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddActualPointsToPlayerSnapshots1789904403909 implements MigrationInterface {
  name = 'AddActualPointsToPlayerSnapshots1789904403909';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "player_snapshots" ADD "actualPoints" double precision`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "player_snapshots" DROP COLUMN "actualPoints"`,
    );
  }
}
