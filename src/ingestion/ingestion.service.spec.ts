import { Test, TestingModule } from '@nestjs/testing';
import { IngestionService } from './ingestion.service';
import { FplPublicClient } from './clients/fpl-public.client';
import { StatsProviderClient } from './clients/stats-provider.client';
import { BootstrapStaticResponse } from './clients/fpl-api.types';
import { Position } from '../common/enums/position.enum';

describe('IngestionService', () => {
  let service: IngestionService;
  let fplPublicClient: { bootstrapStatic: jest.Mock };

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
    fplPublicClient = { bootstrapStatic: jest.fn() };

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
});
