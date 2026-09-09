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
import { ProposalStatus } from '../common/enums/proposal-status.enum';
import {
  computeProposalActualScore,
  detectDivergence,
} from './gameweek-scoring.util';

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

  // Returns how many proposals actually got a result report sent — callers
  // that surface this on demand (the /results-report HTTP endpoint, the
  // /results Telegram command) use it to say "nothing new yet" explicitly
  // rather than going quiet, the same no-silent-no-op principle the
  // Telegram slash commands were built around.
  async checkFinishedGameweeks(): Promise<number> {
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
    let reported = 0;
    for (const proposal of candidates) {
      if (!finishedKeys.has(`${proposal.season}:${proposal.gameweekId}`)) {
        continue;
      }
      if (await this.reportResult(proposal, players, rules)) {
        reported += 1;
      }
    }
    return reported;
  }

  // Best-effort per proposal — one failure (e.g. a transient fetch error)
  // must not stop the rest of the batch, and leaving resultReportedAt unset
  // means it's simply retried on the next poll. Returns whether it actually
  // sent a report, so checkFinishedGameweeks can count successes.
  private async reportResult(
    proposal: Proposal,
    players: Player[],
    rules: SquadRules,
  ): Promise<boolean> {
    try {
      const [playerStats, actual] = await Promise.all([
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
      // Only meaningful for APPROVED — REJECTED/EXPIRED never had anything
      // of the bot's own live at kickoff to diverge from (see
      // detectDivergence's doc comment).
      const divergence =
        proposal.status === ProposalStatus.APPROVED
          ? detectDivergence(proposal, actual)
          : undefined;
      await this.alertService.sendResultReport(
        proposal,
        predictedScore,
        actual.actualPoints,
        divergence,
      );
      await this.proposalService.markResultReported(
        proposal.id,
        divergence?.diverged,
      );
      return true;
    } catch (error) {
      this.logger.warn(
        `Failed to report result for proposal ${proposal.id}: ${String(error)}`,
      );
      return false;
    }
  }

  private teamId(): number {
    return Number(this.config.get<string>('fpl.teamId'));
  }
}
