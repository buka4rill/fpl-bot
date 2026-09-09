import {
  computeProposalActualScore,
  detectDivergence,
} from './gameweek-scoring.util';
import {
  Player,
  PlayerGameweekStats,
  SquadRules,
} from '../common/types/domain.types';
import { Position } from '../common/enums/position.enum';
import { FplChip } from '../common/enums/chip.enum';

describe('computeProposalActualScore', () => {
  const player = (id: number, position: Position): Player => ({
    id,
    webName: `p${id}`,
    fullName: `player ${id}`,
    teamId: 1,
    position,
  });

  // 3-4-3: GK 1, DEF 2/3/4, MID 5/6/7/8, FWD 9/10/11. Bench: GK 12,
  // outfield 13 (DEF) / 14 (MID) / 15 (FWD), in that priority order.
  const players: Player[] = [
    player(1, Position.GKP),
    player(2, Position.DEF),
    player(3, Position.DEF),
    player(4, Position.DEF),
    player(5, Position.MID),
    player(6, Position.MID),
    player(7, Position.MID),
    player(8, Position.MID),
    player(9, Position.FWD),
    player(10, Position.FWD),
    player(11, Position.FWD),
    player(12, Position.GKP),
    player(13, Position.DEF),
    player(14, Position.MID),
    player(15, Position.FWD),
  ];

  const rules: SquadRules = {
    squadSize: 15,
    startingSize: 11,
    maxPerClub: 3,
    budget: 100,
    positions: [
      { position: Position.GKP, squadCount: 2, minStarting: 1, maxStarting: 1 },
      { position: Position.DEF, squadCount: 5, minStarting: 3, maxStarting: 5 },
      { position: Position.MID, squadCount: 5, minStarting: 2, maxStarting: 5 },
      { position: Position.FWD, squadCount: 3, minStarting: 1, maxStarting: 3 },
    ],
  };

  const proposal = {
    lineup: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    benchGoalkeeperId: 12,
    benchOutfieldIds: [13, 14, 15],
    captainId: 9,
    viceCaptainId: 5,
    chip: undefined as FplChip | undefined,
  };

  // All 15 played with 2 points each by default, overridden per test. Any
  // extra player id mentioned only in `overrides` (e.g. the 16/17 added for
  // the 5-def formation test below) also gets a default entry — a plain
  // 1-15 loop would silently leave them out of the map entirely, which
  // reads as "didn't play" (Map.get returns undefined) rather than the
  // intended "played, default 2 points."
  const statsFor = (
    overrides: Record<number, Partial<PlayerGameweekStats>> = {},
  ): Map<number, PlayerGameweekStats> => {
    const ids = new Set([
      ...Array.from({ length: 15 }, (_, i) => i + 1),
      ...Object.keys(overrides).map(Number),
    ]);
    const map = new Map<number, PlayerGameweekStats>();
    for (const id of ids) {
      map.set(id, {
        playerId: id,
        totalPoints: 2,
        minutes: 90,
        played: true,
        ...overrides[id],
      });
    }
    return map;
  };

  it('sums the starting XI plus captain bonus when everyone played', () => {
    const score = computeProposalActualScore(
      proposal,
      statsFor(),
      players,
      rules,
    );

    // 11 starters * 2pts = 22, captain (9) doubled -> +2 extra = 24
    expect(score).toBe(24);
  });

  it('subs in the bench goalkeeper when the starting keeper did not play', () => {
    const stats = statsFor({ 1: { played: false, totalPoints: 0 } });

    const score = computeProposalActualScore(proposal, stats, players, rules);

    // Same as baseline (24) since bench GK (12) also scores 2, same as
    // the starter would have — proves the swap happened, not that it
    // didn't matter: keeper 1 contributes 0 either way it's excluded.
    expect(score).toBe(24);
  });

  it('does not sub in the bench goalkeeper if they also did not play', () => {
    const stats = statsFor({
      1: { played: false, totalPoints: 0 },
      12: { played: false, totalPoints: 0 },
    });

    const score = computeProposalActualScore(proposal, stats, players, rules);

    // Keeper slot contributes 0 either way (unfilled): 22 - 2 (keeper 1's
    // points removed) + captain bonus 2 = 22
    expect(score).toBe(22);
  });

  it('subs in a bench outfield player for a non-playing starter', () => {
    // Bench priority matters — FPL doesn't restrict subs to the same
    // position, so 13 (DEF, higher priority) would otherwise validly fill
    // in ahead of 14 here too; both 13 and 15 are marked not-played to
    // isolate 14 specifically as the one doing the substituting.
    const stats = statsFor({
      5: { played: false, totalPoints: 0 }, // starting MID didn't play
      13: { played: false, totalPoints: 0 },
      14: { totalPoints: 5 }, // bench MID played well
      15: { played: false, totalPoints: 0 },
    });

    const score = computeProposalActualScore(proposal, stats, players, rules);

    // 22 (baseline XI sum) - 2 (player 5's points, now 0 and excluded) + 5
    // (player 14 subbed in) + captain bonus 2 = 27
    expect(score).toBe(27);
  });

  it('skips a bench player whose sub would break the formation, tries the next one', () => {
    // Use a 5-2-3 lineup (DEF already at its max of 5) so that a bench DEF
    // sub is genuinely blocked, forcing the algorithm to move on to the
    // next bench player instead.
    const fiveDefProposal = {
      lineup: [1, 2, 3, 4, 16, 5, 6, 9, 10, 11, 17],
      benchGoalkeeperId: 12,
      benchOutfieldIds: [13, 14, 15],
      captainId: 9,
      viceCaptainId: 5,
      chip: undefined as FplChip | undefined,
    };
    const fiveDefPlayers: Player[] = [
      ...players,
      player(16, Position.DEF),
      player(17, Position.DEF),
    ];
    // 5-2-3: GK 1, DEF 2/3/4/16/17, MID 5/6, FWD 9/10/11.
    const stats = statsFor({
      16: { totalPoints: 2 },
      17: { totalPoints: 2 },
      11: { played: false, totalPoints: 0 }, // FWD starter didn't play
      13: { totalPoints: 9 }, // bench DEF played — but DEF already at max 5
      14: { totalPoints: 7 }, // bench MID played — this one can validly sub in
      15: { totalPoints: 3 }, // bench FWD played — nothing left to replace
    });

    const score = computeProposalActualScore(
      fiveDefProposal,
      stats,
      fiveDefPlayers,
      rules,
    );

    // Baseline 10 starters excluding non-playing 11 (1,2,3,4,16,17,5,6,9,10
    // at 2pts each = 20). Bench DEF (13) is blocked (DEF would hit 6, over
    // max 5) so it's skipped, contributing nothing. Bench MID (14) validly
    // subs in for 11 (DEF stays 5, MID goes 2->3, FWD goes 3->2 — all
    // within range): +7. Bench FWD (15) has no non-playing starter left to
    // replace: unused. Captain (9) played: +2 bonus. Total: 20 + 7 + 2 = 29.
    expect(score).toBe(29);
  });

  it('transfers the captain bonus to the vice-captain when the captain did not play', () => {
    // Bench marked not-played throughout: the captain not playing is *also*
    // a non-playing FWD starter, which would otherwise trigger its own
    // legitimate autosub (a separate mechanism from the captaincy-bonus
    // transfer this test is isolating) — keeping the bench out of it here
    // keeps the two effects from being conflated in one test.
    const stats = statsFor({
      9: { played: false, totalPoints: 0 }, // captain didn't play
      5: { totalPoints: 6 }, // vice-captain did
      13: { played: false, totalPoints: 0 },
      14: { played: false, totalPoints: 0 },
      15: { played: false, totalPoints: 0 },
    });

    const score = computeProposalActualScore(proposal, stats, players, rules);

    // Starters excluding non-playing 9: 1,2,3,4,6,7,8,10,11 (2 each = 18)
    // + 5 (6, already the vice's own 1x) = 24, plus vice's bonus (+6) = 30.
    expect(score).toBe(30);
  });

  it('awards no captain bonus when neither captain nor vice played', () => {
    const stats = statsFor({
      9: { played: false, totalPoints: 0 },
      5: { played: false, totalPoints: 0 },
      13: { played: false, totalPoints: 0 },
      14: { played: false, totalPoints: 0 },
      15: { played: false, totalPoints: 0 },
    });

    const score = computeProposalActualScore(proposal, stats, players, rules);

    // 9 remaining starters * 2 = 18, no bonus.
    expect(score).toBe(18);
  });

  it('counts all 15 players under Bench Boost, no autosubs', () => {
    const stats = statsFor({
      13: { totalPoints: 4 },
      14: { totalPoints: 5 },
      15: { totalPoints: 6 },
    });

    const score = computeProposalActualScore(
      { ...proposal, chip: FplChip.BENCH_BOOST },
      stats,
      players,
      rules,
    );

    // 11 starters (2 each = 22) + bench (12:2, 13:4, 14:5, 15:6 = 17) +
    // captain bonus (+2) = 41
    expect(score).toBe(41);
  });

  it('triples the captain under Triple Captain when the captain played', () => {
    const score = computeProposalActualScore(
      { ...proposal, chip: FplChip.TRIPLE_CAPTAIN },
      statsFor(),
      players,
      rules,
    );

    // 22 baseline + 2 extra (2x) + 2 more extra (3x total) = 26
    expect(score).toBe(26);
  });

  it('does not carry the triple over to the vice-captain', () => {
    const stats = statsFor({
      9: { played: false, totalPoints: 0 },
      5: { totalPoints: 6 },
      13: { played: false, totalPoints: 0 },
      14: { played: false, totalPoints: 0 },
      15: { played: false, totalPoints: 0 },
    });

    const score = computeProposalActualScore(
      { ...proposal, chip: FplChip.TRIPLE_CAPTAIN },
      stats,
      players,
      rules,
    );

    // Same as the non-chip "vice takes over" case (30) — vice only ever
    // gets the normal 2x, never 3x.
    expect(score).toBe(30);
  });

  it('scores a transfer chip (wildcard/free hit) the same as no chip', () => {
    const score = computeProposalActualScore(
      { ...proposal, chip: FplChip.WILDCARD },
      statsFor(),
      players,
      rules,
    );

    expect(score).toBe(24);
  });
});

describe('detectDivergence', () => {
  const divergenceProposal = {
    chip: undefined as FplChip | undefined,
    captainId: 1,
    lineup: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  };

  const matchingActual = {
    actualPoints: 60,
    activeChip: undefined as FplChip | undefined,
    captainId: 1,
    startingXI: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  };

  it('reports no divergence when chip/captain/lineup all match', () => {
    const result = detectDivergence(divergenceProposal, matchingActual);

    expect(result).toEqual({ diverged: false, reasons: [] });
  });

  it('flags a chip that was applied but is not active at kickoff', () => {
    const result = detectDivergence(
      { ...divergenceProposal, chip: FplChip.BENCH_BOOST },
      matchingActual, // activeChip still undefined — owner cancelled it
    );

    expect(result.diverged).toBe(true);
    expect(result.reasons).toEqual([
      'chip: I applied bboost, but FPL shows no chip active at kickoff',
    ]);
  });

  it('flags a chip that was applied but a different chip is active at kickoff', () => {
    const result = detectDivergence(
      { ...divergenceProposal, chip: FplChip.BENCH_BOOST },
      { ...matchingActual, activeChip: FplChip.TRIPLE_CAPTAIN },
    );

    expect(result.diverged).toBe(true);
  });

  it('flags a captain that no longer matches at kickoff', () => {
    const result = detectDivergence(divergenceProposal, {
      ...matchingActual,
      captainId: 2,
    });

    expect(result.diverged).toBe(true);
    expect(result.reasons).toEqual([
      'captain: I set player 1 as captain, but FPL shows a different captain at kickoff',
    ]);
  });

  it('flags a starting XI that no longer matches at kickoff', () => {
    const result = detectDivergence(divergenceProposal, {
      ...matchingActual,
      startingXI: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 99], // 11 swapped for 99
    });

    expect(result.diverged).toBe(true);
    expect(result.reasons).toEqual([
      "lineup: the starting XI at kickoff doesn't match what I applied",
    ]);
  });

  it('does not flag lineup divergence when the same players are just listed in a different order', () => {
    const result = detectDivergence(divergenceProposal, {
      ...matchingActual,
      startingXI: [11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1],
    });

    expect(result.diverged).toBe(false);
  });

  it('reports every divergent field at once, not just the first', () => {
    const result = detectDivergence(
      { ...divergenceProposal, chip: FplChip.TRIPLE_CAPTAIN },
      { ...matchingActual, activeChip: undefined, captainId: 2 },
    );

    expect(result.diverged).toBe(true);
    expect(result.reasons).toHaveLength(2);
  });
});
