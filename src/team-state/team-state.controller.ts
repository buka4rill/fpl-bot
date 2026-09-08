import { Controller, Post } from '@nestjs/common';
import { TeamStateService, TeamState } from './team-state.service';
import { IngestionService } from '../ingestion/ingestion.service';

@Controller('team-state')
export class TeamStateController {
  constructor(
    private readonly teamStateService: TeamStateService,
    private readonly ingestionService: IngestionService,
  ) {}

  // Manual trigger for testing: send the team-status report now instead of
  // waiting for DeadlineWatcherService's automatic trigger window — same
  // idea as ProposalController's captain-swap override.
  @Post('report')
  async triggerReport(): Promise<{ gameweekId: number; state: TeamState }> {
    const { gameweeks } = await this.ingestionService.getBootstrapSnapshot();
    const targetGameweek = gameweeks.find((gameweek) => gameweek.isNext);
    if (!targetGameweek) {
      throw new Error('No upcoming gameweek found to report on.');
    }

    const state = await this.teamStateService.reportTeamState(
      targetGameweek.id,
    );
    return { gameweekId: targetGameweek.id, state };
  }
}
