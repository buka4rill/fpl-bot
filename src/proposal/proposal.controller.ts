import { Body, Controller, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ProposalService } from './proposal.service';
import { ExecutionService } from '../execution/execution.service';
import { AlertService } from '../alert/alert.service';
import { IngestionService } from '../ingestion/ingestion.service';
import { TeamStateService } from '../team-state/team-state.service';
import { AuthService } from '../auth/auth.service';
import { Proposal } from '../common/types/domain.types';
import { FplChip } from '../common/enums/chip.enum';

@Controller('proposal')
export class ProposalController {
  constructor(
    private readonly proposalService: ProposalService,
    private readonly executionService: ExecutionService,
    private readonly alertService: AlertService,
    private readonly ingestionService: IngestionService,
    private readonly teamStateService: TeamStateService,
    private readonly authService: AuthService,
    private readonly config: ConfigService,
  ) {}

  // Manual trigger for testing: runs the real optimizer-driven flow
  // (live team state -> SquadOptimizerService -> Telegram alert) right now,
  // rather than waiting for DeadlineWatcherService's lead-time window —
  // same idea as captain-swap/chip above, but exercising the actual
  // transfer-recommending path instead of a hand-built low-risk proposal.
  @Post('generate')
  async generateNow(): Promise<{ proposalId: string }> {
    await this.authService.assertAuthenticated();
    const { gameweeks, players, snapshots } =
      await this.ingestionService.getBootstrapSnapshot();
    const targetGameweek = gameweeks.find((gameweek) => gameweek.isNext);
    if (!targetGameweek) {
      throw new Error('No upcoming gameweek found to propose for.');
    }

    const teamState = await this.teamStateService.reportTeamState(
      targetGameweek.id,
    );
    const proposal = await this.proposalService.generateProposal(
      teamState.freeTransfers,
    );

    await this.alertService.sendProposal(proposal, players, snapshots);
    return { proposalId: proposal.id };
  }

  // Manual override, independent of SquadOptimizerService: proposes swapping
  // captain <-> vice-captain on your currently-live squad, unchanged
  // otherwise. Lower-stakes than a full optimizer proposal (no transfers/
  // lineup changes) — useful for exercising the approve -> execute path
  // without risking a real transfer/lineup call. Still goes through the same
  // Telegram approve/reject gate as any other proposal (CLAUDE.md: no
  // autonomous execution).
  @Post('captain-swap')
  async proposeCaptainSwap(): Promise<{ proposalId: string }> {
    await this.authService.assertAuthenticated();
    const teamId = Number(this.config.get<string>('fpl.teamId'));
    const [squad, { gameweeks, players, snapshots }] = await Promise.all([
      this.executionService.getCurrentSquadShape(teamId),
      this.ingestionService.getBootstrapSnapshot(),
    ]);

    const targetGameweek = gameweeks.find((gameweek) => gameweek.isNext);
    if (!targetGameweek) {
      throw new Error('No upcoming gameweek found to propose a swap for.');
    }

    const proposal: Proposal = await this.proposalService.store({
      gameweekId: targetGameweek.id,
      season: targetGameweek.season,
      deadlineAt: targetGameweek.deadlineAt,
      transfers: [],
      lineup: squad.lineup,
      benchGoalkeeperId: squad.benchGoalkeeperId,
      benchOutfieldIds: squad.benchOutfieldIds,
      captainId: squad.viceCaptainId, // swapped
      viceCaptainId: squad.captainId, // swapped
      expectedGain: 0,
      hitCost: 0,
    });

    await this.alertService.sendProposal(proposal, players, snapshots);
    return { proposalId: proposal.id };
  }

  // Manual override, independent of SquadOptimizerService: proposes exactly
  // one transfer (playerOutId -> playerInId) on your currently-live squad,
  // lineup/bench/captaincy otherwise unchanged. Built from the same live
  // my-team read as captain-swap above (ExecutionService.getCurrentSquadShape),
  // not IngestionService.getCurrentSquad() — that one reads the *public*
  // entry/picks endpoint keyed off `entry.current_event`, which 404s for an
  // account with no picks history yet (e.g. a brand-new team that joined
  // mid-season, discovered 2026-09-08 testing against a disposable account).
  // Added specifically to exercise /api/transfers/ — still unverified live
  // (see CLAUDE.md's "Execution auth") — without waiting on
  // SquadOptimizerService's current-squad dependency. `hitCost`/`expectedGain`
  // are left at 0 same as captain-swap: this doesn't attempt real hit-cost
  // accounting, FPL's own transfer-cost deduction applies regardless of what
  // this field says.
  @Post('manual-transfer')
  async proposeManualTransfer(
    @Body() body: { playerOutId: number; playerInId: number },
  ): Promise<{ proposalId: string }> {
    const { playerOutId, playerInId } = body;
    if (!playerOutId || !playerInId) {
      throw new Error('playerOutId and playerInId are both required.');
    }
    if (playerOutId === playerInId) {
      throw new Error('playerOutId and playerInId must be different players.');
    }
    await this.authService.assertAuthenticated();

    const teamId = Number(this.config.get<string>('fpl.teamId'));
    const [squad, { gameweeks, players, snapshots }] = await Promise.all([
      this.executionService.getCurrentSquadShape(teamId),
      this.ingestionService.getBootstrapSnapshot(),
    ]);

    const targetGameweek = gameweeks.find((gameweek) => gameweek.isNext);
    if (!targetGameweek) {
      throw new Error('No upcoming gameweek found to propose a transfer for.');
    }
    if (
      playerOutId === squad.captainId ||
      playerOutId === squad.viceCaptainId
    ) {
      throw new Error(
        'Transferring out the captain or vice-captain is not supported by this manual test endpoint — pick a different player.',
      );
    }
    const owned = new Set([
      ...squad.lineup,
      squad.benchGoalkeeperId,
      ...squad.benchOutfieldIds,
    ]);
    if (!owned.has(playerOutId)) {
      throw new Error(`Player ${playerOutId} is not currently in your squad.`);
    }

    const replace = (id: number): number =>
      id === playerOutId ? playerInId : id;
    const proposal: Proposal = await this.proposalService.store({
      gameweekId: targetGameweek.id,
      season: targetGameweek.season,
      deadlineAt: targetGameweek.deadlineAt,
      transfers: [{ playerOutId, playerInId }],
      lineup: squad.lineup.map(replace),
      benchGoalkeeperId: replace(squad.benchGoalkeeperId),
      benchOutfieldIds: squad.benchOutfieldIds.map(replace),
      captainId: squad.captainId,
      viceCaptainId: squad.viceCaptainId,
      expectedGain: 0,
      hitCost: 0,
    });

    await this.alertService.sendProposal(proposal, players, snapshots);
    return { proposalId: proposal.id };
  }

  // Manual chip declaration: "I've decided to play this chip this week."
  // Nothing decides chip timing automatically yet (ChipEvaluatorService is
  // still a stub — that's a separate strategy problem) — this runs the
  // real optimizer with the chip factored in (Wildcard/Free Hit make
  // transfers free that week) rather than just keeping the current squad
  // as-is, since a chip decision should get the full recommendation. Still
  // goes through the normal Telegram approve/reject gate before execution.
  @Post('chip')
  async proposeChip(
    @Body() body: { chip: FplChip; freeTransfers?: number },
  ): Promise<{ proposalId: string }> {
    if (!Object.values(FplChip).includes(body.chip)) {
      throw new Error(`Unknown chip: ${String(body.chip)}`);
    }
    await this.authService.assertAuthenticated();

    const [proposal, { players, snapshots }] = await Promise.all([
      this.proposalService.generateProposal(body.freeTransfers, body.chip),
      this.ingestionService.getBootstrapSnapshot(),
    ]);

    await this.alertService.sendProposal(proposal, players, snapshots);
    return { proposalId: proposal.id };
  }
}
