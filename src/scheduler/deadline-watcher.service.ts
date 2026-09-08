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
import { TeamStateService } from '../team-state/team-state.service';

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
  // In-process only — NOT the restart-safe dedupe (that's the DB check
  // below via ProposalService.findByGameweekId). This exists purely to
  // close the race between two overlapping checkDeadline() calls in the
  // same running process (e.g. the immediate on-init check racing the
  // hourly poll): both can pass the DB check above before either's
  // generateProposal() call has actually persisted a row, since that's the
  // only atomic point. Resets on restart by design — a restart mid-window
  // is exactly what the DB check now covers.
  private lastClaimedGameweekId: number | undefined;

  constructor(
    private readonly ingestionService: IngestionService,
    private readonly proposalService: ProposalService,
    private readonly alertService: AlertService,
    private readonly approvalService: ApprovalService,
    private readonly teamStateService: TeamStateService,
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
    await this.approvalService.expireOverdue();

    const { gameweeks, players, snapshots } =
      await this.ingestionService.getBootstrapSnapshot();
    const targetGameweek = gameweeks.find((gameweek) => gameweek.isNext);
    if (!targetGameweek) {
      return;
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

    // Restart-safe dedupe — was a proposal for this gameweek already
    // persisted, e.g. by a run before a restart?
    const alreadyProposed = await this.proposalService.findByGameweekId(
      targetGameweek.id,
    );
    if (alreadyProposed) {
      return;
    }

    // Block until this week's free-transfer/chip prompt is answered —
    // never fall back to a stale/default free-transfer count. The warn
    // logs on every poll while blocked (not just once at prompt-start), so
    // a stuck state (e.g. TELEGRAM_BOT_TOKEN unset, which makes
    // TelegramAdapter silently no-op) stays visible rather than going
    // quiet after the first attempt.
    if (!(await this.teamStateService.isFreshFor(targetGameweek.id))) {
      this.logger.warn(
        `Gameweek ${targetGameweek.id} proposal blocked: weekly free-transfer/chip prompt not yet answered.`,
      );
      await this.teamStateService.ensureWeeklyPromptStarted(targetGameweek.id);
      return;
    }

    // Claim synchronously, before any further await (see the field's
    // comment) — rolled back on failure so a transient error still gets
    // retried next poll rather than silently never alerting for this
    // gameweek.
    if (this.lastClaimedGameweekId === targetGameweek.id) {
      return;
    }
    this.lastClaimedGameweekId = targetGameweek.id;
    try {
      this.logger.log(
        `Generating proposal for gameweek ${targetGameweek.id} (deadline ${targetGameweek.deadlineAt})...`,
      );
      const freeTransfers = await this.teamStateService.getFreeTransfers(
        targetGameweek.id,
      );
      const proposal =
        await this.proposalService.generateProposal(freeTransfers);
      await this.alertService.sendProposal(proposal, players, snapshots);
    } catch (error) {
      this.lastClaimedGameweekId = undefined;
      throw error;
    }
  }
}
