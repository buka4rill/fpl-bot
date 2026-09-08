import { Controller, Post } from '@nestjs/common';
import { TeamStateService } from './team-state.service';
import { IngestionService } from '../ingestion/ingestion.service';

@Controller('team-state')
export class TeamStateController {
  constructor(
    private readonly teamStateService: TeamStateService,
    private readonly ingestionService: IngestionService,
  ) {}

  // Manual trigger for testing: fire the weekly free-transfer/chip prompt
  // now instead of waiting for DeadlineWatcherService's automatic trigger
  // window — same idea as ProposalController's captain-swap override.
  // ensureWeeklyPromptStarted no-ops if a prompt is already mid-flight for
  // this gameweek, but if this week's was already fully answered, it
  // deliberately restarts the sequence — that's the point, so you can
  // re-confirm free transfers/chips on demand.
  @Post('prompt')
  async triggerWeeklyPrompt(): Promise<{ gameweekId: number }> {
    const { gameweeks } = await this.ingestionService.getBootstrapSnapshot();
    const targetGameweek = gameweeks.find((gameweek) => gameweek.isNext);
    if (!targetGameweek) {
      throw new Error('No upcoming gameweek found to prompt for.');
    }

    await this.teamStateService.ensureWeeklyPromptStarted(targetGameweek.id);
    return { gameweekId: targetGameweek.id };
  }
}
