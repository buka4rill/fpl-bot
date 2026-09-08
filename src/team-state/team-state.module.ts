import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TeamStateService } from './team-state.service';
import { TeamStateController } from './team-state.controller';
import { TeamStateEntity } from '../persistence/entities/team-state.entity';
import { AlertModule } from '../alert/alert.module';
import { IngestionModule } from '../ingestion/ingestion.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([TeamStateEntity]),
    AlertModule,
    IngestionModule,
  ],
  controllers: [TeamStateController],
  providers: [TeamStateService],
  exports: [TeamStateService],
})
export class TeamStateModule {}
