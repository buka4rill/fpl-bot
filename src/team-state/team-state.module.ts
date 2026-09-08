import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TeamStateService } from './team-state.service';
import { TeamStateEntity } from '../persistence/entities/team-state.entity';
import { AlertModule } from '../alert/alert.module';

@Module({
  imports: [TypeOrmModule.forFeature([TeamStateEntity]), AlertModule],
  providers: [TeamStateService],
  exports: [TeamStateService],
})
export class TeamStateModule {}
