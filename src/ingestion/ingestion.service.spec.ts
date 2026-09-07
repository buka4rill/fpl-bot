import { Test, TestingModule } from '@nestjs/testing';
import { IngestionService } from './ingestion.service';
import { FplPublicClient } from './clients/fpl-public.client';
import { StatsProviderClient } from './clients/stats-provider.client';
import {
  BootstrapStaticResponse,
  ElementSummaryResponse,
  RawFixture,
} from './clients/fpl-api.types';
import { Position } from '../common/enums/position.enum';

describe('IngestionService', () => {
  let service: IngestionService;
  let fplPublicClient: {
    bootstrapStatic: jest.Mock;
    fixtures: jest.Mock;
    elementSummary: jest.Mock;
  };

  const rawBootstrap: BootstrapStaticResponse = {
    events: [
      {
        id: 3,
        deadline_time: '2026-09-04T17:30:00Z',
        finished: false,
        is_current: true,
        is_next: false,
      },
      {
        id: 4,
        deadline_time: '2026-09-12T12:30:00Z',
        finished: false,
        is_current: false,
        is_next: true,
      },
    ],
    teams: [{ id: 1, name: 'Arsenal', short_name: 'ARS' }],
    element_types: [{ id: 1, singular_name_short: 'GKP' }],
    elements: [
      {
        id: 1,
        web_name: 'Raya',
        first_name: 'David',
        second_name: 'Raya Martín',
        team: 1,
        element_type: 1,
        now_cost: 60,
        selected_by_percent: '38.7',
        form: '5.0',
        expected_goals: '0.00',
        expected_assists: '0.01',
      },
    ],
  };

  beforeEach(async () => {
    fplPublicClient = {
      bootstrapStatic: jest.fn(),
      fixtures: jest.fn(),
      elementSummary: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IngestionService,
        { provide: FplPublicClient, useValue: fplPublicClient },
        { provide: StatsProviderClient, useValue: {} },
      ],
    }).compile();

    service = module.get<IngestionService>(IngestionService);
  });

  it('normalizes bootstrap-static into domain types', async () => {
    fplPublicClient.bootstrapStatic.mockResolvedValue(rawBootstrap);

    const snapshot = await service.getBootstrapSnapshot();

    expect(snapshot.gameweeks).toEqual([
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
    ]);

    expect(snapshot.teams).toEqual([
      { id: 1, name: 'Arsenal', shortName: 'ARS' },
    ]);

    expect(snapshot.players).toEqual([
      {
        id: 1,
        webName: 'Raya',
        fullName: 'David Raya Martín',
        teamId: 1,
        position: Position.GKP,
      },
    ]);

    expect(snapshot.snapshots).toEqual([
      {
        gameweekId: 3,
        playerId: 1,
        price: 6.0,
        ownershipPct: 38.7,
        form: 5.0,
        xg: 0,
        xa: 0.01,
      },
    ]);
  });

  it('falls back to gameweek 0 when no event is marked current', async () => {
    fplPublicClient.bootstrapStatic.mockResolvedValue({
      ...rawBootstrap,
      events: rawBootstrap.events.map((e) => ({ ...e, is_current: false })),
    });

    const snapshot = await service.getBootstrapSnapshot();

    expect(snapshot.snapshots[0].gameweekId).toBe(0);
  });

  it('normalizes fixtures into domain types', async () => {
    const rawFixtures: RawFixture[] = [
      {
        id: 21,
        event: 3,
        team_h: 12,
        team_a: 14,
        kickoff_time: '2026-09-04T19:00:00Z',
        finished: true,
        team_h_difficulty: 4,
        team_a_difficulty: 2,
      },
      {
        id: 36,
        event: null,
        team_h: 20,
        team_a: 1,
        kickoff_time: null,
        finished: false,
        team_h_difficulty: 3,
        team_a_difficulty: 3,
      },
    ];
    fplPublicClient.fixtures.mockResolvedValue(rawFixtures);

    const fixtures = await service.getFixtures(3);

    expect(fplPublicClient.fixtures).toHaveBeenCalledWith(3);
    expect(fixtures).toEqual([
      {
        id: 21,
        gameweekId: 3,
        homeTeamId: 12,
        awayTeamId: 14,
        kickoffAt: '2026-09-04T19:00:00Z',
        finished: true,
        homeDifficulty: 4,
        awayDifficulty: 2,
      },
      {
        id: 36,
        gameweekId: null,
        homeTeamId: 20,
        awayTeamId: 1,
        kickoffAt: null,
        finished: false,
        homeDifficulty: 3,
        awayDifficulty: 3,
      },
    ]);
  });

  it('passes element summary through unchanged', async () => {
    const raw: ElementSummaryResponse = {
      fixtures: [
        {
          id: 36,
          event: 4,
          is_home: false,
          difficulty: 3,
          kickoff_time: '2026-09-12T19:00:00Z',
        },
      ],
      history: [
        {
          element: 1,
          fixture: 1,
          opponent_team: 7,
          round: 1,
          was_home: true,
          kickoff_time: '2026-08-21T19:00:00Z',
          total_points: 6,
          minutes: 90,
        },
      ],
    };
    fplPublicClient.elementSummary.mockResolvedValue(raw);

    const result = await service.getElementSummary(1);

    expect(fplPublicClient.elementSummary).toHaveBeenCalledWith(1);
    expect(result).toBe(raw);
  });
});
