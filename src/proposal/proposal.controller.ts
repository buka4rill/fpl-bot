import { Body, Controller, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ProposalService } from './proposal.service';
import { ExecutionService } from '../execution/execution.service';
import { AlertService } from '../alert/alert.service';
import { IngestionService } from '../ingestion/ingestion.service';
import { Proposal } from '../common/types/domain.types';
import { FplChip } from '../common/enums/chip.enum';

@Controller('proposal')
export class ProposalController {
  constructor(
    private readonly proposalService: ProposalService,
    private readonly executionService: ExecutionService,
    private readonly alertService: AlertService,
    private readonly ingestionService: IngestionService,
    private readonly config: ConfigService,
  ) {}

  // Manual override, independent of SquadOptimizerService: proposes swapping
  // captain <-> vice-captain on your currently-live squad, unchanged
  // otherwise. Lower-stakes than a full optimizer proposal (no transfers/
  // lineup changes) — useful for exercising the approve -> execute path
  // without risking a real transfer/lineup call. Still goes through the same
  // Telegram approve/reject gate as any other proposal (CLAUDE.md: no
  // autonomous execution).
  @Post('captain-swap')
  async proposeCaptainSwap(): Promise<{ proposalId: string }> {
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

    const [proposal, { players, snapshots }] = await Promise.all([
      this.proposalService.generateProposal(body.freeTransfers, body.chip),
      this.ingestionService.getBootstrapSnapshot(),
    ]);

    await this.alertService.sendProposal(proposal, players, snapshots);
    return { proposalId: proposal.id };
  }
}
