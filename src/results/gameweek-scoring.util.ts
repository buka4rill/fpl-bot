import {
  Player,
  PlayerGameweekStats,
  Proposal,
  SquadRules,
} from '../common/types/domain.types';
import { Position } from '../common/enums/position.enum';
import { FplChip } from '../common/enums/chip.enum';

type ScoringProposal = Pick<
  Proposal,
  | 'lineup'
  | 'benchGoalkeeperId'
  | 'benchOutfieldIds'
  | 'captainId'
  | 'viceCaptainId'
  | 'chip'
>;

// Replicates FPL's own gameweek scoring closely enough to answer "how many
// points would this exact proposal have scored" after the fact — this is
// the only thing that makes the post-gameweek results report meaningful
// rather than a rough guess. Three real FPL rules are simulated:
//
// 1. Autosubs: a starter with 0 minutes is replaced by the highest-priority
//    bench player who did play, as long as the swap keeps every position
//    within its starting min/max (formation-aware, not just "swap them in").
// 2. Captaincy transfer: if the captain didn't play, the multiplier bonus
//    goes to the vice-captain instead (if they played).
// 3. Chip effects: Bench Boost counts all 15 players, no autosubs needed
//    (everyone already counts); Triple Captain only triples if the actual
//    captain themselves played — it does NOT carry over as a triple to the
//    vice-captain, per FPL's own rule.
//
// One known gap: if the vice-captain is a benched player who played but
// wasn't actually autosubbed in (formation already full elsewhere), FPL's
// precise behavior for the captaincy-transfer bonus in that specific
// double-edge-case isn't documented publicly — this treats "played" as
// sufficient on its own, which matches the overwhelmingly common case.
export function computeProposalActualScore(
  proposal: ScoringProposal,
  statsByPlayerId: Map<number, PlayerGameweekStats>,
  players: Player[],
  rules: SquadRules,
): number {
  const positionById = new Map(players.map((p) => [p.id, p.position]));
  const played = (id: number): boolean =>
    statsByPlayerId.get(id)?.played ?? false;
  const points = (id: number): number =>
    statsByPlayerId.get(id)?.totalPoints ?? 0;

  if (proposal.chip === FplChip.BENCH_BOOST) {
    const everyone = [
      ...proposal.lineup,
      proposal.benchGoalkeeperId,
      ...proposal.benchOutfieldIds,
    ];
    const base = everyone.reduce((sum, id) => sum + points(id), 0);
    return base + captainBonus(proposal, played, points, false);
  }

  const effectiveXI = applyAutosubs(proposal, played, positionById, rules);
  const base = effectiveXI.reduce((sum, id) => sum + points(id), 0);
  const tripled =
    proposal.chip === FplChip.TRIPLE_CAPTAIN && played(proposal.captainId);
  return base + captainBonus(proposal, played, points, tripled);
}

// Returns the *extra* points on top of the 1x already counted in the base
// sum — i.e. 1x extra for a normal captain (2x total), 2x extra when
// tripled (3x total), or 1x extra for the vice-captain taking over (2x
// total — vice-captaincy is never tripled).
function captainBonus(
  proposal: ScoringProposal,
  played: (id: number) => boolean,
  points: (id: number) => number,
  tripled: boolean,
): number {
  if (played(proposal.captainId)) {
    return points(proposal.captainId) * (tripled ? 2 : 1);
  }
  if (played(proposal.viceCaptainId)) {
    return points(proposal.viceCaptainId);
  }
  return 0;
}

function applyAutosubs(
  proposal: ScoringProposal,
  played: (id: number) => boolean,
  positionById: Map<number, Position>,
  rules: SquadRules,
): number[] {
  let xi = [...proposal.lineup];

  // Goalkeeper: a straight 1-for-1 swap never changes position counts, so
  // it's always formation-valid — no need to check.
  const startingGk = xi.find((id) => positionById.get(id) === Position.GKP);
  if (
    startingGk !== undefined &&
    !played(startingGk) &&
    played(proposal.benchGoalkeeperId)
  ) {
    xi = xi.map((id) => (id === startingGk ? proposal.benchGoalkeeperId : id));
  }

  // Outfield: bench players in priority order (1st, 2nd, 3rd) — each one
  // that played fills the first non-playing starter whose replacement keeps
  // the formation valid; if none exists, that bench player stays unused and
  // the next one is tried.
  for (const benchId of proposal.benchOutfieldIds) {
    if (!played(benchId)) continue;

    const nonPlayingStarters = xi.filter(
      (id) => positionById.get(id) !== Position.GKP && !played(id),
    );
    const candidate = nonPlayingStarters.find((outId) =>
      isValidFormation(xi, outId, benchId, positionById, rules),
    );
    if (candidate !== undefined) {
      xi = xi.map((id) => (id === candidate ? benchId : id));
    }
  }

  return xi;
}

function isValidFormation(
  xi: number[],
  outId: number,
  inId: number,
  positionById: Map<number, Position>,
  rules: SquadRules,
): boolean {
  const nextXI = xi.map((id) => (id === outId ? inId : id));
  const countByPosition = new Map<Position, number>();
  for (const id of nextXI) {
    const position = positionById.get(id);
    if (!position) continue;
    countByPosition.set(position, (countByPosition.get(position) ?? 0) + 1);
  }
  return rules.positions.every((rule) => {
    const count = countByPosition.get(rule.position) ?? 0;
    return count >= rule.minStarting && count <= rule.maxStarting;
  });
}
