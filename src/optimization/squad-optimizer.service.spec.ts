import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { SquadOptimizerService } from './squad-optimizer.service';
import { PredictionService } from '../prediction/prediction.service';
import {
  CurrentSquad,
  Gameweek,
  Player,
  PlayerSnapshot,
  SquadRules,
} from '../common/types/domain.types';
import { Position } from '../common/enums/position.enum';
import { FplChip } from '../common/enums/chip.enum';

describe('SquadOptimizerService', () => {
  let service: SquadOptimizerService;
  let predictionService: { predictGameweek: jest.Mock };

  const player = (id: number, position: Position, teamId: number): Player => ({
    id,
    webName: `player${id}`,
    fullName: `player ${id}`,
    teamId,
    position,
  });

  const snapshot = (
    playerId: number,
    price: number,
    predictedPoints: number,
  ): PlayerSnapshot => ({
    gameweekId: 3,
    playerId,
    price,
    ownershipPct: 0,
    predictedPoints,
  });

  const targetGameweek: Gameweek = {
    id: 4,
    deadlineAt: '2026-09-12T12:30:00Z',
    isCurrent: false,
    isNext: true,
    finished: false,
  };

  // Defaults match configuration.ts's own defaults (maxHitsPerWeek=1,
  // hitRiskPremium=4, i.e. an effective 8-pt threshold), so most tests read
  // as "under the real deployed defaults" without passing overrides.
  const buildConfig = (
    overrides: Partial<{ maxHitsPerWeek: number; hitRiskPremium: number }> = {},
  ): { get: jest.Mock } => ({
    get: jest.fn((key: string) => {
      if (key === 'optimizer.maxHitsPerWeek')
        return overrides.maxHitsPerWeek ?? 1;
      if (key === 'optimizer.hitRiskPremium')
        return overrides.hitRiskPremium ?? 4;
      return undefined;
    }),
  });

  const setup = async (
    players: Player[],
    predictions: PlayerSnapshot[],
    rules: SquadRules,
    currentSquad?: CurrentSquad,
    configOverrides?: Partial<{
      maxHitsPerWeek: number;
      hitRiskPremium: number;
    }>,
  ) => {
    predictionService = {
      predictGameweek: jest.fn().mockResolvedValue({
        players,
        rules,
        targetGameweek,
        currentSquad,
        predictions,
      }),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SquadOptimizerService,
        { provide: PredictionService, useValue: predictionService },
        { provide: ConfigService, useValue: buildConfig(configOverrides) },
      ],
    }).compile();
    service = module.get<SquadOptimizerService>(SquadOptimizerService);
  };

  // Toy rules — same shape as real FPL (GKP/DEF/MID/FWD, budget, club limit)
  // but scaled down (8-man squad, 6 starters) so the optimal answer can be
  // hand-verified rather than trusting a 654-player fixture.
  const toyRules: SquadRules = {
    squadSize: 8,
    startingSize: 6,
    maxPerClub: 2,
    budget: 40,
    positions: [
      { position: Position.GKP, squadCount: 2, minStarting: 1, maxStarting: 1 },
      { position: Position.DEF, squadCount: 3, minStarting: 1, maxStarting: 2 },
      { position: Position.MID, squadCount: 2, minStarting: 1, maxStarting: 2 },
      { position: Position.FWD, squadCount: 1, minStarting: 1, maxStarting: 1 },
    ],
  };

  it('selects the best squad, formation, captain, vice, and bench under budget', async () => {
    // Best-by-points selection happens to cost exactly the 40 budget, so this
    // also confirms the budget constraint isn't accidentally excluding it.
    const players = [
      player(1, Position.GKP, 101),
      player(2, Position.GKP, 102),
      player(3, Position.GKP, 103), // worse than 1 & 2 — excluded
      player(4, Position.DEF, 104),
      player(5, Position.DEF, 105),
      player(6, Position.DEF, 106),
      player(7, Position.DEF, 107), // worst of 4 DEF candidates — excluded
      player(8, Position.MID, 108),
      player(9, Position.MID, 109),
      player(10, Position.MID, 110), // worse than 8 & 9 — excluded
      player(11, Position.FWD, 111),
      player(12, Position.FWD, 112), // worse than 11 — excluded
    ];
    const predictions = [
      snapshot(1, 5, 6),
      snapshot(2, 4, 5),
      snapshot(3, 3, 3),
      snapshot(4, 5, 6),
      snapshot(5, 5, 5),
      snapshot(6, 4, 4),
      snapshot(7, 3, 2),
      snapshot(8, 6, 7),
      snapshot(9, 5, 6),
      snapshot(10, 4, 3),
      snapshot(11, 6, 8),
      snapshot(12, 5, 5),
    ];
    await setup(players, predictions, toyRules);

    const result = await service.optimizeSquad();

    expect(result.targetGameweek).toBe(targetGameweek);
    expect(new Set(result.squad)).toEqual(new Set([1, 2, 4, 5, 6, 8, 9, 11]));
    // Only valid formation given maxStarting caps is 2 DEF + 2 MID + 1 FWD.
    expect(result.startingXI).toEqual([1, 4, 5, 8, 9, 11]);
    expect(result.benchGoalkeeperId).toBe(2);
    expect(result.benchOutfieldIds).toEqual([6]);
    expect(result.captainId).toBe(11); // highest predicted points (8)
    expect(result.viceCaptainId).toBe(8); // second highest (7)
    expect(result.totalPredictedPoints).toBe(38);
    expect(result.transfers).toEqual([]);
    expect(result.hitCost).toBe(0);
  });

  it('excludes an otherwise-better player when it would breach the club limit', async () => {
    const clubLimitRules: SquadRules = {
      squadSize: 3,
      startingSize: 3,
      maxPerClub: 1,
      budget: 100,
      positions: [
        {
          position: Position.GKP,
          squadCount: 1,
          minStarting: 1,
          maxStarting: 1,
        },
        {
          position: Position.DEF,
          squadCount: 1,
          minStarting: 1,
          maxStarting: 1,
        },
        {
          position: Position.MID,
          squadCount: 0,
          minStarting: 0,
          maxStarting: 0,
        },
        {
          position: Position.FWD,
          squadCount: 1,
          minStarting: 1,
          maxStarting: 1,
        },
      ],
    };

    const players = [
      player(101, Position.GKP, 1), // only GKP candidate — forced in
      player(102, Position.DEF, 1), // best DEF, but shares team 1 with 101
      player(103, Position.DEF, 2), // worse DEF, different team
      player(104, Position.FWD, 3),
    ];
    const predictions = [
      snapshot(101, 5, 10),
      snapshot(102, 5, 10),
      snapshot(103, 4, 7),
      snapshot(104, 5, 9),
    ];
    await setup(players, predictions, clubLimitRules);

    const result = await service.optimizeSquad();

    expect(new Set(result.squad)).toEqual(new Set([101, 103, 104]));
    expect(result.squad).not.toContain(102);
  });

  it('throws when no squad is feasible under the constraints', async () => {
    const impossibleRules: SquadRules = {
      squadSize: 1,
      startingSize: 1,
      maxPerClub: 1,
      budget: 1, // cheapest candidate costs more than this
      positions: [
        {
          position: Position.GKP,
          squadCount: 1,
          minStarting: 1,
          maxStarting: 1,
        },
        {
          position: Position.DEF,
          squadCount: 0,
          minStarting: 0,
          maxStarting: 0,
        },
        {
          position: Position.MID,
          squadCount: 0,
          minStarting: 0,
          maxStarting: 0,
        },
        {
          position: Position.FWD,
          squadCount: 0,
          minStarting: 0,
          maxStarting: 0,
        },
      ],
    };
    await setup(
      [player(1, Position.GKP, 1)],
      [snapshot(1, 5, 10)],
      impossibleRules,
    );

    await expect(service.optimizeSquad()).rejects.toThrow(
      'No feasible squad found',
    );
  });

  describe('with a current squad', () => {
    // Same 8-slot shape as toyRules: 2 GKP, 3 DEF, 2 MID, 1 FWD. Prices sum
    // to exactly 40 (5+4+5+5+4+6+5+6), matching ownedSquad's teamValue below.
    const players = [
      player(1, Position.GKP, 101),
      player(2, Position.GKP, 102),
      player(4, Position.DEF, 104),
      player(5, Position.DEF, 105),
      player(6, Position.DEF, 106), // currently owned, weakest DEF at 4 pts
      player(8, Position.MID, 108),
      player(9, Position.MID, 109),
      player(11, Position.FWD, 111),
    ];
    const predictions = [
      snapshot(1, 5, 6),
      snapshot(2, 4, 5),
      snapshot(4, 5, 6),
      snapshot(5, 5, 5),
      snapshot(6, 4, 4),
      snapshot(8, 6, 7),
      snapshot(9, 5, 6),
      snapshot(11, 6, 8),
    ];
    const ownedSquad: CurrentSquad = {
      teamId: 1,
      gameweekId: 3,
      playerIds: [1, 2, 4, 5, 6, 8, 9, 11],
      bank: 0,
      teamValue: 40,
    };

    it('uses bank + team value as the budget, not rules.budget', async () => {
      // rules.budget alone (1) would make even the current squad infeasible.
      const tightRules = { ...toyRules, budget: 1 };
      await setup(players, predictions, tightRules, ownedSquad);

      const result = await service.optimizeSquad(0);

      expect(new Set(result.squad)).toEqual(new Set(ownedSquad.playerIds));
    });

    it('keeps the current player when the upgrade is not worth the transfer hit', async () => {
      const candidates = [...players, player(13, Position.DEF, 113)];
      const candidatePredictions = [
        ...predictions,
        snapshot(13, 4, 4.5), // only +0.5 over player 6's 4 pts, same price
      ];
      await setup(candidates, candidatePredictions, toyRules, ownedSquad);

      const result = await service.optimizeSquad(0); // no free transfers

      expect(result.squad).toContain(6);
      expect(result.squad).not.toContain(13);
      expect(result.transfers).toEqual([]);
      expect(result.hitCost).toBe(0);
    });

    it('takes the hit when the upgrade clears the risk-adjusted threshold', async () => {
      const candidates = [...players, player(14, Position.DEF, 114)];
      const candidatePredictions = [
        ...predictions,
        // +10 over player 6's 4 pts — clearly above the default
        // risk-adjusted threshold (POINTS_PER_TRANSFER_HIT + hitRiskPremium
        // = 4 + 4 = 8), same price.
        snapshot(14, 4, 14),
      ];
      await setup(candidates, candidatePredictions, toyRules, ownedSquad);

      const result = await service.optimizeSquad(0); // no free transfers

      expect(result.squad).toContain(14);
      expect(result.squad).not.toContain(6);
      expect(result.transfers).toEqual([{ playerOutId: 6, playerInId: 14 }]);
      // The *reported*/deducted hit cost stays the real FPL rule (4/hit) —
      // only the solver's internal willingness to recommend one is stricter.
      expect(result.hitCost).toBe(4);
    });

    it('does NOT take a hit when the gain clears the bare 4-pt breakeven but not the risk-adjusted threshold', async () => {
      // This is the regression case for the reported bug: a +6 gain used to
      // trigger a hit under the old bare-breakeven (>4) rule, even though a
      // single-point-of-failure swap for a marginal edge is a bad trade in
      // a rank-relative mini-league. Under the default risk premium (+4,
      // effective threshold 8), it should no longer be recommended.
      const candidates = [...players, player(14, Position.DEF, 114)];
      const candidatePredictions = [
        ...predictions,
        snapshot(14, 4, 10), // +6 over player 6's 4 pts, same price
      ];
      await setup(candidates, candidatePredictions, toyRules, ownedSquad);

      const result = await service.optimizeSquad(0); // no free transfers

      expect(result.squad).toContain(6);
      expect(result.squad).not.toContain(14);
      expect(result.transfers).toEqual([]);
      expect(result.hitCost).toBe(0);
    });

    it('caps how many hits get stacked in one week, even when each is individually worth it', async () => {
      // Two independently-profitable swaps (both clearing the 8-pt
      // threshold on their own), but with different margins.
      const candidates = [
        ...players,
        player(14, Position.DEF, 114),
        player(15, Position.MID, 115),
      ];
      const candidatePredictions = [
        ...predictions,
        snapshot(14, 4, 16), // +12 over player 6's 4 pts, same price
        snapshot(15, 5, 15), // +9 over player 9's 6 pts, same price
      ];
      await setup(candidates, candidatePredictions, toyRules, ownedSquad); // default maxHitsPerWeek=1

      const result = await service.optimizeSquad(0); // no free transfers

      // Only the higher-margin swap is taken — the cap makes the second
      // one structurally impossible this week, not just less attractive.
      expect(result.transfers).toEqual([{ playerOutId: 6, playerInId: 14 }]);
      expect(result.hitCost).toBe(4);
    });

    it('allows more hits when maxHitsPerWeek is configured higher', async () => {
      const candidates = [
        ...players,
        player(14, Position.DEF, 114),
        player(15, Position.MID, 115),
      ];
      const candidatePredictions = [
        ...predictions,
        snapshot(14, 4, 16), // +12 over player 6's 4 pts, same price
        snapshot(15, 5, 15), // +9 over player 9's 6 pts, same price
      ];
      await setup(candidates, candidatePredictions, toyRules, ownedSquad, {
        maxHitsPerWeek: 2,
      });

      const result = await service.optimizeSquad(0); // no free transfers

      expect(result.transfers).toEqual(
        expect.arrayContaining([
          { playerOutId: 6, playerInId: 14 },
          { playerOutId: 9, playerInId: 15 },
        ]),
      );
      expect(result.transfers).toHaveLength(2);
      expect(result.hitCost).toBe(8);
    });

    it('takes multiple transfers at zero cost under Wildcard, even ones not individually worth a hit', async () => {
      // Two small upgrades (+1 pt each) — not worth a -4 hit each on their
      // own (net -6 combined vs. staying put), but free under Wildcard.
      const candidates = [
        ...players,
        player(14, Position.DEF, 114),
        player(15, Position.MID, 115),
      ];
      const candidatePredictions = [
        ...predictions,
        snapshot(14, 4, 5), // +1 over player 6's 4 pts, same price
        snapshot(15, 5, 7), // +1 over player 9's 6 pts, same price
      ];
      await setup(candidates, candidatePredictions, toyRules, ownedSquad);

      const result = await service.optimizeSquad(0, FplChip.WILDCARD);

      expect(result.squad).toEqual(expect.arrayContaining([14, 15]));
      expect(result.squad).not.toContain(6);
      expect(result.squad).not.toContain(9);
      expect(result.hitCost).toBe(0);
    });

    it('does not charge a hit for a transfer within the free allowance', async () => {
      const candidates = [...players, player(13, Position.DEF, 113)];
      const candidatePredictions = [
        ...predictions,
        snapshot(13, 4, 4.5), // any positive gain is worth a FREE transfer
      ];
      await setup(candidates, candidatePredictions, toyRules, ownedSquad);

      const result = await service.optimizeSquad(1); // 1 free transfer

      expect(result.squad).toContain(13);
      expect(result.squad).not.toContain(6);
      expect(result.transfers).toEqual([{ playerOutId: 6, playerInId: 13 }]);
      expect(result.hitCost).toBe(0);
    });
  });
});
