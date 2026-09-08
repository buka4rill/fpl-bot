import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddResultReportedAtToProposals1788878902407 implements MigrationInterface {
  name = 'AddResultReportedAtToProposals1788878902407';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "proposals" ADD "resultReportedAt" TIMESTAMP WITH TIME ZONE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "proposals" DROP COLUMN "resultReportedAt"`,
    );
  }
}
