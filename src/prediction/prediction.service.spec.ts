import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { PredictionService } from './prediction.service';
import { HeuristicStrategy } from './strategies/heuristic.strategy';
import { IngestionService } from '../ingestion/ingestion.service';
import { ExecutionService } from '../execution/execution.service';
import {
  CurrentSquad,
  Fixture,
  Gameweek,
  Player,
  PlayerSnapshot,
  SquadRules,
} from '../common/types/domain.types';
import { Position } from '../common/enums/position.enum';
import { GameweekEntity } from '../persistence/entities/gameweek.entity';
import { PlayerSnapshotEntity } from '../persistence/entities/player-snapshot.entity';

describe('PredictionService', () => {
  let service: PredictionService;
  let ingestionService: {
    getBootstrapSnapshot: jest.Mock;
    getFixtures: jest.Mock;
  };
  let executionService: { getCurrentSquad: jest.Mock };
  let strategy: { predict: jest.Mock };
  let config: { get: jest.Mock };
  let gameweekRepository: { create: jest.Mock; save: jest.Mock };
  let playerSnapshotRepository: { create: jest.Mock; save: jest.Mock };

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
      season: '26_27',
    },
    {
      id: 4,
      deadlineAt: '2026-09-12T12:30:00Z',
      isCurrent: false,
      isNext: true,
      finished: false,
      season: '26_27',
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
    executionService = {
      getCurrentSquad: jest.fn(),
    };
    strategy = {
      predict: jest.fn().mockImplementation((s) => Promise.resolve(s)),
    };
    // No FPL_TEAM_ID configured by default — most tests don't care about
    // the current-squad path.
    config = { get: jest.fn().mockReturnValue(undefined) };
    gameweekRepository = {
      create: jest.fn((gw: Gameweek) => gw),
      save: jest.fn().mockResolvedValue(undefined),
    };
    playerSnapshotRepository = {
      create: jest.fn((snapshot: PlayerSnapshot) => snapshot),
      save: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PredictionService,
        { provide: HeuristicStrategy, useValue: strategy },
        { provide: IngestionService, useValue: ingestionService },
        { provide: ExecutionService, useValue: executionService },
        { provide: ConfigService, useValue: config },
        {
          provide: getRepositoryToken(GameweekEntity),
          useValue: gameweekRepository,
        },
        {
          provide: getRepositoryToken(PlayerSnapshotEntity),
          useValue: playerSnapshotRepository,
        },
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

  it('leaves currentSquad undefined when no FPL_TEAM_ID is configured', async () => {
    const result = await service.predictGameweek();

    expect(executionService.getCurrentSquad).not.toHaveBeenCalled();
    expect(result.currentSquad).toBeUndefined();
  });

  it('fetches the current squad (via the authenticated endpoint) when FPL_TEAM_ID is configured', async () => {
    config.get.mockReturnValue('42');
    const currentSquad: CurrentSquad = {
      teamId: 42,
      gameweekId: 4,
      playerIds: [1, 2, 3],
      bank: 0,
      teamValue: 100,
    };
    executionService.getCurrentSquad.mockResolvedValue(currentSquad);

    const result = await service.predictGameweek();

    // Called with the *target* (next) gameweek's id, 4 — not the current
    // gameweek, 3 — the whole point being tested here: the account's
    // public picks history for gameweek 3 might not exist at all, which
    // is exactly the 404 this authenticated path avoids.
    expect(executionService.getCurrentSquad).toHaveBeenCalledWith(42, 4);
    expect(result.currentSquad).toBe(currentSquad);
  });

  it('records gameweek/snapshot history for backtesting', async () => {
    const predicted = [{ ...snapshots[0], predictedPoints: 5 }];
    strategy.predict.mockResolvedValue(predicted);

    await service.predictGameweek();

    expect(gameweekRepository.save).toHaveBeenCalledWith(gameweeks[1]);
    expect(playerSnapshotRepository.save).toHaveBeenCalledWith(
      predicted.map((prediction) => ({
        ...prediction,
        gameweekId: 4, // overridden to the target gameweek, not the snapshot's own (current) gameweekId of 3
        season: '26_27',
      })),
    );
  });

  it('does not fail the proposal when recording history fails', async () => {
    gameweekRepository.save.mockRejectedValue(new Error('DB down'));

    await expect(service.predictGameweek()).resolves.toBeDefined();
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
