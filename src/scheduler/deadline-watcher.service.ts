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
import { ApprovalService } from '../approval/approval.service';

// Polls hourly rather than daily (ARCHITECTURE.md's "coarse, e.g. daily"
// suggestion) so the trigger window is never missed even with a small
// DEADLINE_LEAD_HOURS. Polling also self-corrects if FPL reschedules a
// deadline after we last checked — no stale timer to cancel/recompute,
// unlike pre-computing a single setTimeout for a specific instant.
const POLL_INTERVAL_MS = 60 * 60 * 1000;

@Injectable()
export class DeadlineWatcherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DeadlineWatcherService.name);
  private intervalHandle: NodeJS.Timeout | undefined;
  // In-memory — resets on restart, same placeholder status as ProposalService's
  // store (CLAUDE.md: no persistence layer chosen yet). Worst case on
  // restart mid-window is one duplicate proposal/alert for the same
  // gameweek, not a missed or double-applied change (nothing executes
  // without a separate explicit approval).
  private lastProposedGameweekId: number | undefined;

  constructor(
    private readonly ingestionService: IngestionService,
    private readonly proposalService: ProposalService,
    private readonly alertService: AlertService,
    private readonly approvalService: ApprovalService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    this.intervalHandle = setInterval(() => {
      this.runCheck();
    }, POLL_INTERVAL_MS);
    this.runCheck(); // don't wait a full interval for the first check
  }

  onModuleDestroy(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
    }
  }

  private runCheck(): void {
    this.checkDeadline().catch((error: unknown) => {
      this.logger.error(`Deadline check failed: ${String(error)}`);
    });
  }

  // Always reads the real deadline from bootstrap-static — never assumes a
  // fixed weekday/time, since blank/double gameweeks shift it.
  async checkDeadline(): Promise<void> {
    this.approvalService.expireOverdue();

    const { gameweeks, players, snapshots } =
      await this.ingestionService.getBootstrapSnapshot();
    const targetGameweek = gameweeks.find((gameweek) => gameweek.isNext);
    if (!targetGameweek) {
      return;
    }

    if (this.lastProposedGameweekId === targetGameweek.id) {
      return; // already proposed + alerted for this gameweek
    }

    const leadHours = Number(
      this.config.get<number>('scheduler.deadlineLeadHours') ?? 24,
    );
    const deadlineMs = new Date(targetGameweek.deadlineAt).getTime();
    const triggerAtMs = deadlineMs - leadHours * 60 * 60 * 1000;
    const now = Date.now();

    // Outside the trigger window: too early, or the deadline already passed
    // (e.g. the bot was down through it) — either way, nothing to do.
    if (now < triggerAtMs || now >= deadlineMs) {
      return;
    }

    // Claim this gameweek synchronously, before any further `await` — two
    // overlapping checks (e.g. the immediate on-init check racing a manual
    // trigger, or a slow check still running when the next poll tick fires)
    // would otherwise both pass the guard above, since the actual work
    // below involves real network calls with a real time gap. Rolled back
    // on failure so a transient error still gets retried next poll rather
    // than silently never alerting for this gameweek.
    this.lastProposedGameweekId = targetGameweek.id;
    try {
      this.logger.log(
        `Generating proposal for gameweek ${targetGameweek.id} (deadline ${targetGameweek.deadlineAt})...`,
      );
      const proposal = await this.proposalService.generateProposal();
      await this.alertService.sendProposal(proposal, players, snapshots);
    } catch (error) {
      this.lastProposedGameweekId = undefined;
      throw error;
    }
  }
}
