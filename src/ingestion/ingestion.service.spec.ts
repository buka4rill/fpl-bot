import { Test, TestingModule } from '@nestjs/testing';
import { IngestionService } from './ingestion.service';
import { FplPublicClient } from './clients/fpl-public.client';
import { StatsProviderClient } from './clients/stats-provider.client';
import {
  BootstrapStaticResponse,
  ElementSummaryResponse,
  EntryPicksResponse,
  LiveGameweekResponse,
  RawEntry,
  RawFixture,
} from './clients/fpl-api.types';
import { Position } from '../common/enums/position.enum';
import { FplChip } from '../common/enums/chip.enum';

describe('IngestionService', () => {
  let service: IngestionService;
  let fplPublicClient: {
    bootstrapStatic: jest.Mock;
    fixtures: jest.Mock;
    elementSummary: jest.Mock;
    liveGameweek: jest.Mock;
    getEntry: jest.Mock;
    getEntryPicks: jest.Mock;
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
    element_types: [
      {
        id: 1,
        singular_name_short: 'GKP',
        squad_select: 2,
        squad_min_play: 1,
        squad_max_play: 1,
      },
    ],
    game_settings: {
      squad_squadsize: 15,
      squad_squadplay: 11,
      squad_team_limit: 3,
      squad_total_spend: 1000,
    },
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
        minutes: 270,
        status: 'a',
        chance_of_playing_next_round: null,
        defensive_contribution: 5,
      },
    ],
  };

  beforeEach(async () => {
    fplPublicClient = {
      bootstrapStatic: jest.fn(),
      fixtures: jest.fn(),
      elementSummary: jest.fn(),
      liveGameweek: jest.fn(),
      getEntry: jest.fn(),
      getEntryPicks: jest.fn(),
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
        minutesPlayed: 270,
        status: 'a',
        chanceOfPlayingNextRound: null,
        position: Position.GKP,
        defensiveContribution: 5,
      },
    ]);

    expect(snapshot.rules).toEqual({
      squadSize: 15,
      startingSize: 11,
      maxPerClub: 3,
      budget: 100,
      positions: [
        {
          position: Position.GKP,
          squadCount: 2,
          minStarting: 1,
          maxStarting: 1,
        },
      ],
    });
  });

  it("derives season from each gameweek's own deadline, not the request time", async () => {
    fplPublicClient.bootstrapStatic.mockResolvedValue({
      ...rawBootstrap,
      events: [
        {
          ...rawBootstrap.events[0],
          id: 20,
          deadline_time: '2027-01-15T17:30:00Z',
        },
      ],
    });

    const snapshot = await service.getBootstrapSnapshot();

    expect(snapshot.gameweeks[0].season).toBe('26_27');
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

  it('passes live gameweek stats through unchanged', async () => {
    const raw: LiveGameweekResponse = {
      elements: [
        {
          id: 1,
          stats: {
            minutes: 90,
            total_points: 3,
            bonus: 0,
            in_dreamteam: false,
            played: true,
          },
        },
      ],
    };
    fplPublicClient.liveGameweek.mockResolvedValue(raw);

    const result = await service.getLiveGameweek(3);

    expect(fplPublicClient.liveGameweek).toHaveBeenCalledWith(3);
    expect(result).toBe(raw);
  });

  it('normalizes the current squad from entry + picks', async () => {
    const rawEntry: RawEntry = {
      id: 42,
      current_event: 3,
      last_deadline_bank: 0,
      last_deadline_value: 1000,
    };
    const rawPicks: EntryPicksResponse = {
      active_chip: 'bboost',
      entry_history: { event: 3, points: 60, bank: 5, value: 1005 },
      picks: [
        { element: 1, element_type: 1 },
        { element: 2, element_type: 2 },
      ],
    };
    fplPublicClient.getEntry.mockResolvedValue(rawEntry);
    fplPublicClient.getEntryPicks.mockResolvedValue(rawPicks);

    const squad = await service.getCurrentSquad(42);

    expect(fplPublicClient.getEntry).toHaveBeenCalledWith(42);
    expect(fplPublicClient.getEntryPicks).toHaveBeenCalledWith(42, 3);
    expect(squad).toEqual({
      teamId: 42,
      gameweekId: 3,
      playerIds: [1, 2],
      bank: 0.5,
      teamValue: 100.5,
      activeChip: FplChip.BENCH_BOOST,
    });
  });

  it('leaves activeChip undefined when no chip is active', async () => {
    fplPublicClient.getEntry.mockResolvedValue({
      id: 42,
      current_event: 3,
      last_deadline_bank: 0,
      last_deadline_value: 1000,
    });
    fplPublicClient.getEntryPicks.mockResolvedValue({
      active_chip: null,
      entry_history: { event: 3, points: 55, bank: 0, value: 1000 },
      picks: [],
    });

    const squad = await service.getCurrentSquad(42);

    expect(squad.activeChip).toBeUndefined();
  });
});
