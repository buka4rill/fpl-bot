import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAppliedManuallyToProposals1788873829501 implements MigrationInterface {
  name = 'AddAppliedManuallyToProposals1788873829501';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "proposals" ADD "appliedManually" boolean`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "proposals" DROP COLUMN "appliedManually"`,
    );
  }
}
