import { Injectable, Logger } from '@nestjs/common';
import { IngestionService } from '../ingestion/ingestion.service';
import { ProposalService } from '../proposal/proposal.service';
import { TeamStateService } from '../team-state/team-state.service';
import { AuthService } from '../auth/auth.service';
import { AlertService } from '../alert/alert.service';

const HELP_TEXT = [
  '🤖 *Available commands*',
  '/status — live free transfers + chip availability',
  '/propose — generate and send a fresh proposal now',
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
  ) {}

  // Best-effort per command: any failure is caught and reported back over
  // Telegram (with the underlying error's own message — AuthService's
  // errors, for instance, are already written as "here's what to do") so
  // a command never just silently does nothing, the exact complaint that
  // motivated building this in the first place.
  async handleCommand(text: string): Promise<void> {
    // Strip a group-chat "@BotName" suffix and any arguments — none of
    // these commands take one today.
    const command = text.trim().split(/[\s@]/)[0].toLowerCase();
    try {
      switch (command) {
        case '/status':
          await this.handleStatus();
          break;
        case '/propose':
          await this.handlePropose();
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
    const proposal = await this.proposalService.generateProposal(
      teamState.freeTransfers,
    );
    await this.alertService.sendProposal(proposal, players, snapshots);
  }

  private async handleLoginStatus(): Promise<void> {
    const authenticated = await this.authService.isAuthenticated();
    const text = authenticated
      ? '✅ Logged in — the FPL session is currently valid.'
      : '🔐 Not logged in. Run `pnpm run auth:login` from your own terminal (not over Telegram — the login step needs a real browser) to log back in.';
    await this.alertService.sendMessage(text);
  }
}
