import { Test, TestingModule } from '@nestjs/testing';
import { PredictionService } from './prediction.service';
import { HeuristicStrategy } from './strategies/heuristic.strategy';
import { IngestionService } from '../ingestion/ingestion.service';
import {
  Fixture,
  Gameweek,
  Player,
  PlayerSnapshot,
  SquadRules,
} from '../common/types/domain.types';
import { Position } from '../common/enums/position.enum';

describe('PredictionService', () => {
  let service: PredictionService;
  let ingestionService: {
    getBootstrapSnapshot: jest.Mock;
    getFixtures: jest.Mock;
  };
  let strategy: { predict: jest.Mock };

  const players: Player[] = [
    {
      id: 1,
      webName: 'Raya',
      fullName: 'David Raya',
      teamId: 1,
      position: Position.GKP,
    },
    {
      id: 2,
      webName: 'Saka',
      fullName: 'Bukayo Saka',
      teamId: 1,
      position: Position.MID,
    },
    {
      id: 3,
      webName: 'Salah',
      fullName: 'Mohamed Salah',
      teamId: 2,
      position: Position.MID,
    },
  ];

  const snapshots: PlayerSnapshot[] = [
    { gameweekId: 3, playerId: 1, price: 6.0, ownershipPct: 38.7 },
    { gameweekId: 3, playerId: 2, price: 10.0, ownershipPct: 50.0 },
    { gameweekId: 3, playerId: 3, price: 14.0, ownershipPct: 60.0 },
  ];

  const fixtures: Fixture[] = [
    // team 1's next unplayed fixture: home, difficulty 2
    {
      id: 1,
      gameweekId: 4,
      homeTeamId: 1,
      awayTeamId: 3,
      kickoffAt: null,
      finished: false,
      homeDifficulty: 2,
      awayDifficulty: 4,
    },
    // already finished — should be ignored when picking "next"
    {
      id: 2,
      gameweekId: 3,
      homeTeamId: 1,
      awayTeamId: 2,
      kickoffAt: '2026-09-04T19:00:00Z',
      finished: true,
      homeDifficulty: 1,
      awayDifficulty: 5,
    },
    // team 2 has no upcoming fixture (blank gameweek) — not included here
  ];

  const gameweeks: Gameweek[] = [
    {
      id: 3,
      deadlineAt: '2026-09-04T17:30:00Z',
      isCurrent: true,
      isNext: false,
      finished: false,
    },
    {
      id: 4,
      deadlineAt: '2026-09-12T12:30:00Z',
      isCurrent: false,
      isNext: true,
      finished: false,
    },
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

  beforeEach(async () => {
    ingestionService = {
      getBootstrapSnapshot: jest
        .fn()
        .mockResolvedValue({ players, snapshots, rules, gameweeks }),
      getFixtures: jest.fn().mockResolvedValue(fixtures),
    };
    strategy = {
      predict: jest.fn().mockImplementation((s) => Promise.resolve(s)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PredictionService,
        { provide: HeuristicStrategy, useValue: strategy },
        { provide: IngestionService, useValue: ingestionService },
      ],
    }).compile();

    service = module.get<PredictionService>(PredictionService);
  });

  it('enriches each snapshot with its team next fixture difficulty', async () => {
    await service.predictGameweek();

    expect(strategy.predict).toHaveBeenCalledWith([
      { ...snapshots[0], nextFixtureDifficulty: 2 }, // team 1, home
      { ...snapshots[1], nextFixtureDifficulty: 2 }, // team 1, home
      { ...snapshots[2], nextFixtureDifficulty: undefined }, // team 2, no upcoming fixture
    ]);
  });

  it('returns players, rules, the next gameweek, and whatever the strategy produces', async () => {
    const predicted = [{ ...snapshots[0], predictedPoints: 5 }];
    strategy.predict.mockResolvedValue(predicted);

    const result = await service.predictGameweek();

    expect(result.players).toBe(players);
    expect(result.rules).toBe(rules);
    expect(result.targetGameweek).toEqual(gameweeks[1]); // isNext
    expect(result.predictions).toBe(predicted);
  });

  it('throws when bootstrap-static has no upcoming gameweek', async () => {
    ingestionService.getBootstrapSnapshot.mockResolvedValue({
      players,
      snapshots,
      rules,
      gameweeks: gameweeks.map((g) => ({ ...g, isNext: false })),
    });

    await expect(service.predictGameweek()).rejects.toThrow(
      'No upcoming gameweek',
    );
  });
});
