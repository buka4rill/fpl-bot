import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddNoChipAlternativeToProposals1788903062648 implements MigrationInterface {
  name = 'AddNoChipAlternativeToProposals1788903062648';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "proposals" ADD "noChipAlternative" jsonb`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "proposals" DROP COLUMN "noChipAlternative"`,
    );
  }
}
