import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddDivergedFromPlanToProposals1788962719585 implements MigrationInterface {
  name = 'AddDivergedFromPlanToProposals1788962719585';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "proposals" ADD "divergedFromPlan" boolean`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "proposals" DROP COLUMN "divergedFromPlan"`,
    );
  }
}
