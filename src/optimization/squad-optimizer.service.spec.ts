import { Test, TestingModule } from '@nestjs/testing';
import { SquadOptimizerService } from './squad-optimizer.service';
import { PredictionService } from '../prediction/prediction.service';
import {
  Gameweek,
  Player,
  PlayerSnapshot,
  SquadRules,
} from '../common/types/domain.types';
import { Position } from '../common/enums/position.enum';

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

  const setup = async (
    players: Player[],
    predictions: PlayerSnapshot[],
    rules: SquadRules,
  ) => {
    predictionService = {
      predictGameweek: jest
        .fn()
        .mockResolvedValue({ players, rules, targetGameweek, predictions }),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SquadOptimizerService,
        { provide: PredictionService, useValue: predictionService },
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
});
