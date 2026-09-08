import { Injectable, Logger } from '@nestjs/common';
import { IngestionService } from '../ingestion/ingestion.service';
import { ProposalService } from '../proposal/proposal.service';
import { TeamStateService } from '../team-state/team-state.service';
import { AuthService } from '../auth/auth.service';
import { AlertService } from '../alert/alert.service';
import { ResultsService } from '../results/results.service';
import { FplChip } from '../common/enums/chip.enum';

const CHIP_NAMES = Object.values(FplChip).join('|');

const HELP_TEXT = [
  '🤖 *Available commands*',
  '/status — live free transfers + chip availability',
  '/propose — generate and send a fresh proposal now',
  `/chip <${CHIP_NAMES}> — declare a chip and propose with it factored in`,
  '/results — check for any newly-finished gameweek results to report',
  '/login — check whether the FPL session is currently authenticated',
  '/help — show this list',
].join('\n');

// Manual triggers reachable from the Telegram chat itself — /status,
// /propose, /login are the same flows POST /team-state/report,
// POST /proposal/generate, and AuthService.isAuthenticated() already
// expose over HTTP (ApprovalController's testing convenience endpoints),
// just callable without a terminal. ApprovalController is the single
// Telegram webhook entry point (Telegram posts every update type — button
// taps and plain messages alike — to the one configured URL) and routes
// any message starting with "/" here, after its own configured-chat
// check; this service assumes that's already been done and doesn't repeat
// it.
//
// /login can only ever *report* auth status, never perform a login — the
// real login step is deliberately unscripted (DataDome-guarded, see
// CLAUDE.md's "Execution auth") and needs a real browser only
// `pnpm run auth:login`, run locally, can provide.
@Injectable()
export class TelegramCommandsService {
  private readonly logger = new Logger(TelegramCommandsService.name);

  constructor(
    private readonly ingestionService: IngestionService,
    private readonly proposalService: ProposalService,
    private readonly teamStateService: TeamStateService,
    private readonly authService: AuthService,
    private readonly alertService: AlertService,
    private readonly resultsService: ResultsService,
  ) {}

  // Best-effort per command: any failure is caught and reported back over
  // Telegram (with the underlying error's own message — AuthService's
  // errors, for instance, are already written as "here's what to do") so
  // a command never just silently does nothing, the exact complaint that
  // motivated building this in the first place.
  async handleCommand(text: string): Promise<void> {
    // Strip a group-chat "@BotName" suffix from the command itself; the
    // rest of the message (if any — only /chip takes one today) is passed
    // through as args.
    const [rawCommand, ...args] = text.trim().split(/\s+/);
    const command = rawCommand.split('@')[0].toLowerCase();
    try {
      switch (command) {
        case '/status':
          await this.handleStatus();
          break;
        case '/propose':
          await this.handlePropose();
          break;
        case '/chip':
          await this.handleChip(args);
          break;
        case '/results':
          await this.handleResults();
          break;
        case '/login':
          await this.handleLoginStatus();
          break;
        case '/help':
        case '/start':
          await this.alertService.sendMessage(HELP_TEXT);
          break;
        default:
          await this.alertService.sendMessage(
            `Unknown command: ${command}\n\n${HELP_TEXT}`,
          );
      }
    } catch (error) {
      this.logger.warn(`Command ${command} failed: ${String(error)}`);
      await this.alertService.sendMessage(
        `⚠️ ${command} failed: ${String(error)}`,
      );
    }
  }

  private async handleStatus(): Promise<void> {
    const { gameweeks } = await this.ingestionService.getBootstrapSnapshot();
    const targetGameweek = gameweeks.find((gameweek) => gameweek.isNext);
    if (!targetGameweek) {
      await this.alertService.sendMessage('No upcoming gameweek found.');
      return;
    }
    await this.teamStateService.reportTeamState(targetGameweek.id);
  }

  private async handlePropose(): Promise<void> {
    await this.authService.assertAuthenticated();
    const { gameweeks, players, snapshots } =
      await this.ingestionService.getBootstrapSnapshot();
    const targetGameweek = gameweeks.find((gameweek) => gameweek.isNext);
    if (!targetGameweek) {
      await this.alertService.sendMessage(
        'No upcoming gameweek found to propose for.',
      );
      return;
    }

    const teamState = await this.teamStateService.reportTeamState(
      targetGameweek.id,
    );
    const availableChips = teamState.chips
      .filter((c) => c.status_for_entry === 'available')
      .map((c) => c.name as FplChip);
    const { proposal, candidates } =
      await this.proposalService.generateBestProposal(
        teamState.freeTransfers,
        availableChips,
      );
    await this.alertService.sendProposal(
      proposal,
      players,
      snapshots,
      candidates,
    );
  }

  // Mirrors ProposalController.proposeChip: declares a chip and runs it
  // through the real optimizer (transfers included) rather than just
  // keeping the current squad as-is, same as the HTTP endpoint. Chip names
  // are the raw FplChip enum values (wildcard/freehit/bboost/3xc) — the
  // same strings the HTTP endpoint's body.chip already expects, so there's
  // only one contract to remember rather than a second set of chat aliases.
  private async handleChip(args: string[]): Promise<void> {
    const requested = args[0]?.toLowerCase();
    const knownChipNames: readonly string[] = Object.values(FplChip);
    const chip =
      requested && knownChipNames.includes(requested)
        ? (requested as FplChip)
        : undefined;
    if (!chip) {
      await this.alertService.sendMessage(`Usage: /chip <${CHIP_NAMES}>`);
      return;
    }
    await this.authService.assertAuthenticated();
    const [proposal, { players, snapshots }] = await Promise.all([
      this.proposalService.generateProposal(undefined, chip),
      this.ingestionService.getBootstrapSnapshot(),
    ]);
    await this.alertService.sendProposal(proposal, players, snapshots);
  }

  // Mirrors POST /results/report: runs the same check ResultsService's
  // hourly poll does, right now, rather than waiting for it.
  // checkFinishedGameweeks() already sends its own 📊 report per
  // newly-finished proposal; this only adds a message for the "nothing new
  // yet" case, so the command isn't a silent no-op when there's nothing to
  // report.
  private async handleResults(): Promise<void> {
    const reported = await this.resultsService.checkFinishedGameweeks();
    if (reported === 0) {
      await this.alertService.sendMessage(
        'No new finished-gameweek results to report yet.',
      );
    }
  }

  private async handleLoginStatus(): Promise<void> {
    const authenticated = await this.authService.isAuthenticated();
    const text = authenticated
      ? '✅ Logged in — the FPL session is currently valid.'
      : '🔐 Not logged in. Run `pnpm run auth:login` from your own terminal (not over Telegram — the login step needs a real browser) to log back in.';
    await this.alertService.sendMessage(text);
  }
}
