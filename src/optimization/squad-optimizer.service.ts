import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import solver, { Model, SolveResult } from 'javascript-lp-solver';
import { PredictionService } from '../prediction/prediction.service';
import {
  CurrentSquad,
  Gameweek,
  Player,
  PlayerSnapshot,
  SquadRules,
  TransferPlan,
} from '../common/types/domain.types';
import { Position } from '../common/enums/position.enum';
import { FplChip } from '../common/enums/chip.enum';

export interface SquadOptimizationResult {
  targetGameweek: Gameweek;
  squad: number[]; // all 15 player IDs
  // Empty/0 when there's no current squad to compare against (from-scratch
  // recommendation) — see selectSquad's currentSquad handling.
  transfers: TransferPlan[];
  hitCost: number;
  startingXI: number[]; // 11 player IDs
  benchGoalkeeperId: number;
  benchOutfieldIds: number[]; // 3 ids, ordered by predicted points desc (auto-sub preference)
  captainId: number;
  viceCaptainId: number;
  totalPredictedPoints: number; // starting XI only, captain not yet doubled
}

// FPL's actual points cost per transfer beyond your free allowance. Unlike
// budget/squad-size/formation rules, this isn't exposed anywhere in
// bootstrap-static — it's a fixed game rule, not something that shifts like
// a deadline, so hardcoding it here doesn't violate the "never hardcode"
// principle that applies to deadlines and squad rules.
const POINTS_PER_TRANSFER_HIT = 4;

// javascript-lp-solver variable/constraint keys must be strings; player IDs
// are numeric.
const playerKey = (playerId: number): string => `p${playerId}`;
const positionKey = (position: Position): string => `pos_${position}`;
const clubKey = (teamId: number): string => `club_${teamId}`;
const EXCESS_TRANSFERS_KEY = 'excessTransfers';
const TRANSFER_HITS_CONSTRAINT = 'transferHits';
const MAX_HITS_CONSTRAINT = 'maxHits';

@Injectable()
export class SquadOptimizerService {
  constructor(
    private readonly predictionService: PredictionService,
    private readonly config: ConfigService,
  ) {}

  // `freeTransfers` can't be read from the public API (see CurrentSquad's
  // doc comment) — defaults to the standard weekly amount. Pass the real
  // number if you know it (e.g. from the FPL app) for an accurate hit cost.
  // `chip` only affects the hit-cost formula here: Wildcard/Free Hit make
  // transfers free that week regardless of count. It doesn't change the
  // budget/constraints (Wildcard doesn't grant extra budget — still bank +
  // squad value) or need any "reverts next week" handling for Free Hit,
  // since this app is stateless about squad and always reads live from FPL.
  async optimizeSquad(
    freeTransfers = 1,
    chip?: FplChip,
  ): Promise<SquadOptimizationResult> {
    const { players, rules, targetGameweek, currentSquad, predictions } =
      await this.predictionService.predictGameweek();

    const playerById = new Map(players.map((p) => [p.id, p]));
    const pointsByPlayerId = new Map(
      predictions.map((p) => [p.playerId, p.predictedPoints ?? 0]),
    );

    // Under Wildcard/Free Hit, transfers are free regardless of count — the
    // ILP itself must know this too, not just the reported hitCost below,
    // otherwise it still penalizes "excess" transfers internally and
    // shies away from the full rebuild these chips are for. squadSize is a
    // safe stand-in for "unlimited": you can't transfer more players than
    // you own.
    const chipCoversTransferCost =
      chip === FplChip.WILDCARD || chip === FplChip.FREE_HIT;
    const effectiveFreeTransfers = chipCoversTransferCost
      ? rules.squadSize
      : freeTransfers;

    // Both config-driven, not hardcoded like POINTS_PER_TRANSFER_HIT itself
    // — these encode the owner's own risk tolerance (a mini-league is
    // rank-relative, not raw-EV, so stacking several marginal, high-variance
    // hits in one week is a bad trade even when each is individually
    // "worth it" by a hair) rather than a fixed FPL game rule. Only steers
    // the solver's internal decision-making — hitCost below stays the real
    // 4-pt-per-hit rule regardless of these.
    const maxHitsPerWeek = Number(
      this.config.get<number>('optimizer.maxHitsPerWeek') ?? 1,
    );
    const hitRiskPremium = Number(
      this.config.get<number>('optimizer.hitRiskPremium') ?? 4,
    );

    const squad = this.selectSquad(
      players,
      predictions,
      rules,
      currentSquad,
      effectiveFreeTransfers,
      maxHitsPerWeek,
      hitRiskPremium,
    );
    const lineup = this.selectStartingLineup(
      squad,
      playerById,
      pointsByPlayerId,
      rules,
    );
    const transfers = this.deriveTransfers(currentSquad, squad);
    const hitCost = chipCoversTransferCost
      ? 0
      : Math.max(0, transfers.length - freeTransfers) * POINTS_PER_TRANSFER_HIT;

    return { targetGameweek, squad, transfers, hitCost, ...lineup };
  }

  // Stage 1 — ILP over every player: pick the 15-man squad maximizing total
  // predicted points minus any transfer-hit cost, subject to
  // budget/position-quota/club-limit constraints. Doesn't yet know who
  // starts — that's a separate, much smaller problem once the squad is
  // fixed (see selectStartingLineup).
  //
  // When `currentSquad` is given, budget becomes bank + current squad value
  // (you can in principle sell everyone) rather than a fresh £100m, and an
  // `excessTransfers` variable is added: it's constrained to be at least
  // (transfers used - freeTransfers) and penalized in the objective at
  // (POINTS_PER_TRANSFER_HIT + hitRiskPremium) per unit — deliberately
  // higher than the real 4-pt cost, so the solver only recommends a hit
  // when the gain clearly clears breakeven, not just barely (see
  // optimizeSquad's comment on why this is config-driven risk tolerance,
  // not a hardcoded game rule). It's also capped at maxHitsPerWeek via
  // MAX_HITS_CONSTRAINT, so even a string of individually-profitable hits
  // can't stack past that in one week. Since the solver maximizes points,
  // it settles `excessTransfers` at exactly
  // min(maxHitsPerWeek, max(0, transfersUsed - freeTransfers)).
  private selectSquad(
    players: Player[],
    predictions: PlayerSnapshot[],
    rules: SquadRules,
    currentSquad: CurrentSquad | undefined,
    freeTransfers: number,
    maxHitsPerWeek: number,
    hitRiskPremium: number,
  ): number[] {
    const playerById = new Map(players.map((p) => [p.id, p]));
    const currentSquadIds = new Set(currentSquad?.playerIds ?? []);

    const variables: Model['variables'] = {};
    const binaries: Record<string, 1> = {};
    const constraints: Model['constraints'] = {
      budget: {
        max: currentSquad
          ? currentSquad.bank + currentSquad.teamValue
          : rules.budget,
      },
      count: { equal: rules.squadSize },
    };
    const model: Model = {
      optimize: 'points',
      opType: 'max',
      constraints,
      variables,
      binaries,
    };

    for (const position of rules.positions) {
      constraints[positionKey(position.position)] = {
        equal: position.squadCount,
      };
    }

    const clubIds = new Set(players.map((p) => p.teamId));
    for (const teamId of clubIds) {
      constraints[clubKey(teamId)] = { max: rules.maxPerClub };
    }

    if (currentSquad) {
      // excessTransfers >= (currentSquadSize - sum(squad_i for i in current)) - freeTransfers
      // rearranged to keep every term on the constraint's LHS:
      // excessTransfers + sum(squad_i for i in current) >= currentSquadSize - freeTransfers
      constraints[TRANSFER_HITS_CONSTRAINT] = {
        min: currentSquad.playerIds.length - freeTransfers,
      };
      // Inert under Wildcard/Free Hit: freeTransfers is already squadSize
      // in that branch (see optimizeSquad), so excessTransfers wants to be
      // 0 regardless of this cap — no need to special-case chips out of it.
      constraints[MAX_HITS_CONSTRAINT] = { max: maxHitsPerWeek };
      variables[EXCESS_TRANSFERS_KEY] = {
        points: -(POINTS_PER_TRANSFER_HIT + hitRiskPremium),
        [TRANSFER_HITS_CONSTRAINT]: 1,
        [MAX_HITS_CONSTRAINT]: 1,
      };
    }

    for (const snapshot of predictions) {
      const player = playerById.get(snapshot.playerId);
      if (!player) continue;

      const key = playerKey(player.id);
      variables[key] = {
        points: snapshot.predictedPoints ?? 0,
        budget: snapshot.price,
        count: 1,
        [positionKey(player.position)]: 1,
        [clubKey(player.teamId)]: 1,
        ...(currentSquadIds.has(player.id)
          ? { [TRANSFER_HITS_CONSTRAINT]: 1 }
          : {}),
      };
      binaries[key] = 1;
    }

    const result = solver.Solve(model) as SolveResult;
    if (!result.feasible) {
      throw new Error(
        'No feasible squad found under budget/position/club constraints.',
      );
    }

    return players
      .filter((player) => result[playerKey(player.id)] === 1)
      .map((player) => player.id);
  }

  private deriveTransfers(
    currentSquad: CurrentSquad | undefined,
    newSquad: number[],
  ): TransferPlan[] {
    if (!currentSquad) return [];

    const newSquadIds = new Set(newSquad);
    const currentSquadIdSet = new Set(currentSquad.playerIds);
    const playersOut = currentSquad.playerIds.filter(
      (id) => !newSquadIds.has(id),
    );
    const playersIn = newSquad.filter((id) => !currentSquadIdSet.has(id));

    return playersOut.map((playerOutId, i) => ({
      playerOutId,
      playerInId: playersIn[i],
    }));
  }

  // Stage 2 — given the fixed 15-man squad, find the best valid starting XI.
  // Provably optimal without another ILP call: for a fixed formation (fixed
  // count per position), the best XI is just the top-N players by points per
  // position — no interaction across positions once the shape is fixed. So
  // this brute-forces the small set of valid formations and greedily fills
  // each one.
  private selectStartingLineup(
    squad: number[],
    playerById: Map<number, Player>,
    pointsByPlayerId: Map<number, number>,
    rules: SquadRules,
  ): Pick<
    SquadOptimizationResult,
    | 'startingXI'
    | 'benchGoalkeeperId'
    | 'benchOutfieldIds'
    | 'captainId'
    | 'viceCaptainId'
    | 'totalPredictedPoints'
  > {
    const byPosition = new Map<Position, number[]>();
    for (const playerId of squad) {
      const position = playerById.get(playerId)?.position;
      if (!position) continue;
      const ids = byPosition.get(position) ?? [];
      ids.push(playerId);
      byPosition.set(position, ids);
    }
    for (const ids of byPosition.values()) {
      ids.sort(
        (a, b) =>
          (pointsByPlayerId.get(b) ?? 0) - (pointsByPlayerId.get(a) ?? 0),
      );
    }

    const gkpIds = byPosition.get(Position.GKP) ?? [];
    const startingGoalkeeperId = gkpIds[0];
    const benchGoalkeeperId = gkpIds[1];

    const rulesByPosition = new Map(
      rules.positions.map((p) => [p.position, p]),
    );
    const outfieldTarget = rules.startingSize - 1;

    let best: { def: number; mid: number; fwd: number; points: number } | null =
      null;

    const defRule = rulesByPosition.get(Position.DEF)!;
    const midRule = rulesByPosition.get(Position.MID)!;
    const fwdRule = rulesByPosition.get(Position.FWD)!;
    const defIds = byPosition.get(Position.DEF) ?? [];
    const midIds = byPosition.get(Position.MID) ?? [];
    const fwdIds = byPosition.get(Position.FWD) ?? [];

    const sumTop = (ids: number[], n: number): number =>
      ids
        .slice(0, n)
        .reduce((sum, id) => sum + (pointsByPlayerId.get(id) ?? 0), 0);

    for (
      let def = defRule.minStarting;
      def <= Math.min(defRule.maxStarting, defIds.length);
      def++
    ) {
      for (
        let mid = midRule.minStarting;
        mid <= Math.min(midRule.maxStarting, midIds.length);
        mid++
      ) {
        const fwd = outfieldTarget - def - mid;
        if (fwd < fwdRule.minStarting || fwd > fwdRule.maxStarting) continue;
        if (fwd > fwdIds.length) continue;

        const points =
          sumTop(defIds, def) + sumTop(midIds, mid) + sumTop(fwdIds, fwd);
        if (!best || points > best.points) {
          best = { def, mid, fwd, points };
        }
      }
    }

    if (!best) {
      throw new Error(
        'No valid starting formation found for the selected squad.',
      );
    }

    const startingDefIds = defIds.slice(0, best.def);
    const startingMidIds = midIds.slice(0, best.mid);
    const startingFwdIds = fwdIds.slice(0, best.fwd);
    const startingXI = [
      startingGoalkeeperId,
      ...startingDefIds,
      ...startingMidIds,
      ...startingFwdIds,
    ];

    const benchOutfieldIds = [
      ...defIds.slice(best.def),
      ...midIds.slice(best.mid),
      ...fwdIds.slice(best.fwd),
    ].sort(
      (a, b) => (pointsByPlayerId.get(b) ?? 0) - (pointsByPlayerId.get(a) ?? 0),
    );

    const [captainId, viceCaptainId] = [...startingXI].sort(
      (a, b) => (pointsByPlayerId.get(b) ?? 0) - (pointsByPlayerId.get(a) ?? 0),
    );

    const totalPredictedPoints =
      (pointsByPlayerId.get(startingGoalkeeperId) ?? 0) + best.points;

    return {
      startingXI,
      benchGoalkeeperId,
      benchOutfieldIds,
      captainId,
      viceCaptainId,
      totalPredictedPoints,
    };
  }
}
