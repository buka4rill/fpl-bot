import { Controller, Post } from '@nestjs/common';
import { ResultsService } from './results.service';

@Controller('results')
export class ResultsController {
  constructor(private readonly resultsService: ResultsService) {}

  // Manual trigger for testing: runs the same check ResultsService's hourly
  // poll does, right now — same idea as ProposalController's captain-swap
  // override or TeamStateController's report trigger.
  @Post('report')
  async triggerCheck(): Promise<{ checked: true }> {
    await this.resultsService.checkFinishedGameweeks();
    return { checked: true };
  }
}
