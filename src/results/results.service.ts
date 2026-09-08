import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IngestionService } from '../ingestion/ingestion.service';
import { ProposalService } from '../proposal/proposal.service';
import { AlertService } from '../alert/alert.service';
import { Player, Proposal, SquadRules } from '../common/types/domain.types';
import { computeProposalActualScore } from './gameweek-scoring.util';

// Same interval as DeadlineWatcherService — results roll in over days, not
// hours, so this doesn't need to be more frequent; reusing the constant
// would couple the two services together for no real benefit.
const POLL_INTERVAL_MS = 60 * 60 * 1000;

// Post-gameweek "how did my suggestion actually score" report — connects
// the proposal that was made to what actually happened, for every terminal
// outcome (APPROVED/REJECTED/EXPIRED), once the gameweek it was for
// actually finishes (days after its deadline, so this is a genuinely
// separate trigger from ApprovalService's post-deadline check-in, not a
// replacement for it). Entirely public-API driven — no authenticated call
// needed, so this runs independent of the FPL auth story's fragility.
@Injectable()
export class ResultsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ResultsService.name);
  private intervalHandle: NodeJS.Timeout | undefined;

  constructor(
    private readonly ingestionService: IngestionService,
    private readonly proposalService: ProposalService,
    private readonly alertService: AlertService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    this.intervalHandle = setInterval(() => {
      this.runCheck();
    }, POLL_INTERVAL_MS);
    this.runCheck();
  }

  onModuleDestroy(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
    }
  }

  private runCheck(): void {
    this.checkFinishedGameweeks().catch((error: unknown) => {
      this.logger.error(`Results check failed: ${String(error)}`);
    });
  }

  async checkFinishedGameweeks(): Promise<void> {
    const { gameweeks, players, rules } =
      await this.ingestionService.getBootstrapSnapshot();
    // Keyed by (season, id) — plain gameweek-id membership would match a
    // finished gameweek from a prior season with the same number (CLAUDE.md:
    // FPL resets gameweek ids every season).
    const finishedKeys = new Set(
      gameweeks
        .filter((gameweek) => gameweek.finished)
        .map((gameweek) => `${gameweek.season}:${gameweek.id}`),
    );

    const candidates = await this.proposalService.findUnreportedTerminal();
    for (const proposal of candidates) {
      if (!finishedKeys.has(`${proposal.season}:${proposal.gameweekId}`)) {
        continue;
      }
      await this.reportResult(proposal, players, rules);
    }
  }

  // Best-effort per proposal — one failure (e.g. a transient fetch error)
  // must not stop the rest of the batch, and leaving resultReportedAt unset
  // means it's simply retried on the next poll.
  private async reportResult(
    proposal: Proposal,
    players: Player[],
    rules: SquadRules,
  ): Promise<void> {
    try {
      const [playerStats, { actualPoints }] = await Promise.all([
        this.ingestionService.getGameweekPlayerStats(proposal.gameweekId),
        this.ingestionService.getGameweekResult(
          this.teamId(),
          proposal.gameweekId,
        ),
      ]);
      const predictedScore = computeProposalActualScore(
        proposal,
        playerStats,
        players,
        rules,
      );
      await this.alertService.sendResultReport(
        proposal,
        predictedScore,
        actualPoints,
      );
      await this.proposalService.markResultReported(proposal.id);
    } catch (error) {
      this.logger.warn(
        `Failed to report result for proposal ${proposal.id}: ${String(error)}`,
      );
    }
  }

  private teamId(): number {
    return Number(this.config.get<string>('fpl.teamId'));
  }
}
