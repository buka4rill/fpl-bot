import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FplAuthClient } from './clients/fpl-auth.client';
import { FplPick } from './clients/fpl-auth.types';
import { Proposal, ExecutionLog } from '../common/types/domain.types';
import { ExecutionLogEntity } from '../persistence/entities/execution-log.entity';

export interface CurrentSquadShape {
  lineup: number[];
  benchGoalkeeperId: number;
  benchOutfieldIds: number[];
  captainId: number;
  viceCaptainId: number;
}

// Lineup/captain changes only (ARCHITECTURE.md §11 build order step 3) —
// transfers and chips are deferred to step 4, once the audit log and
// rollback story are proven out here first.
@Injectable()
export class ExecutionService {
  constructor(
    private readonly fplAuthClient: FplAuthClient,
    private readonly config: ConfigService,
    @InjectRepository(ExecutionLogEntity)
    private readonly executionLogRepository: Repository<ExecutionLogEntity>,
  ) {}

  // Only ever call this from an APPROVED proposal, before its deadline.
  async apply(proposal: Proposal): Promise<ExecutionLog> {
    if (new Date(proposal.deadlineAt).getTime() <= Date.now()) {
      throw new Error(
        `Deadline for proposal ${proposal.id} has passed — refusing to execute.`,
      );
    }
    if (proposal.transfers.length > 0) {
      throw new Error(
        `Proposal ${proposal.id} includes transfers — ExecutionModule only supports lineup/captain changes so far.`,
      );
    }
    if (proposal.chip) {
      throw new Error(
        `Proposal ${proposal.id} plays a chip (${proposal.chip}) — ExecutionModule only supports lineup/captain changes so far.`,
      );
    }

    const teamId = Number(this.config.get<string>('fpl.teamId'));
    const current = await this.fplAuthClient.getMyTeam(teamId);
    const picks = this.buildPicks(current.picks, proposal);

    let responsePayload: unknown;
    let success = true;
    try {
      responsePayload = await this.fplAuthClient.setLineup(teamId, picks);
    } catch (error) {
      success = false;
      responsePayload = { error: String(error) };
    }

    const log = await this.executionLogRepository.save(
      this.executionLogRepository.create({
        proposalId: proposal.id,
        requestPayload: { picks },
        responsePayload,
        appliedAt: new Date().toISOString(),
        success,
      }),
    );

    if (!success) {
      throw new Error(
        `Execution failed for proposal ${proposal.id} — see execution log.`,
      );
    }
    return log;
  }

  // Reads your currently-live squad shape (lineup/bench/captaincy) straight
  // from FPL — for building a manual-override proposal (e.g. a captain-only
  // swap) that doesn't go through SquadOptimizerService. Only exposes this
  // derived shape, never the raw picks/tokens, keeping FplAuthClient the one
  // place holding the authenticated session (CLAUDE.md).
  async getCurrentSquadShape(teamId: number): Promise<CurrentSquadShape> {
    const current = await this.fplAuthClient.getMyTeam(teamId);
    const sorted = [...current.picks].sort((a, b) => a.position - b.position);
    const bench = sorted.filter((p) => p.position > 11);
    const benchGoalkeeper = bench.find((p) => p.element_type === 1) ?? bench[0];
    const captain = current.picks.find((p) => p.is_captain);
    const viceCaptain = current.picks.find((p) => p.is_vice_captain);
    if (!benchGoalkeeper || !captain || !viceCaptain) {
      throw new Error(
        'Current squad is missing a bench goalkeeper, captain, or vice-captain — cannot build a manual proposal from it.',
      );
    }

    return {
      lineup: sorted.filter((p) => p.position <= 11).map((p) => p.element),
      benchGoalkeeperId: benchGoalkeeper.element,
      benchOutfieldIds: bench
        .filter((p) => p !== benchGoalkeeper)
        .map((p) => p.element),
      captainId: captain.element,
      viceCaptainId: viceCaptain.element,
    };
  }

  // No transfers this step, so the proposal's lineup+bench must exactly
  // cover the currently-owned 15 — only position/multiplier/captaincy change.
  private buildPicks(currentPicks: FplPick[], proposal: Proposal): FplPick[] {
    const positionByElement = new Map<number, number>();
    proposal.lineup.forEach((id, i) => positionByElement.set(id, i + 1));
    [proposal.benchGoalkeeperId, ...proposal.benchOutfieldIds].forEach(
      (id, i) => positionByElement.set(id, 12 + i),
    );

    return currentPicks.map((pick) => {
      const position = positionByElement.get(pick.element);
      if (position === undefined) {
        throw new Error(
          `Proposal ${proposal.id} doesn't account for owned player ${pick.element} — lineup/bench must cover the full squad without transfers.`,
        );
      }
      const isCaptain = pick.element === proposal.captainId;
      const isViceCaptain = pick.element === proposal.viceCaptainId;
      return {
        ...pick,
        position,
        multiplier: position > 11 ? 0 : isCaptain ? 2 : 1,
        is_captain: isCaptain,
        is_vice_captain: isViceCaptain,
      };
    });
  }
}
