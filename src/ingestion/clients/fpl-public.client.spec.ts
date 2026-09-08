import { Test, TestingModule } from '@nestjs/testing';
import { HttpService } from '@nestjs/axios';
import { of } from 'rxjs';
import { AxiosResponse } from 'axios';
import { FplPublicClient } from './fpl-public.client';
import {
  BootstrapStaticResponse,
  ElementSummaryResponse,
  EntryPicksResponse,
  LiveGameweekResponse,
  RawEntry,
  RawFixture,
} from './fpl-api.types';

describe('FplPublicClient', () => {
  let client: FplPublicClient;
  let httpService: { get: jest.Mock };

  beforeEach(async () => {
    httpService = { get: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FplPublicClient,
        { provide: HttpService, useValue: httpService },
      ],
    }).compile();

    client = module.get<FplPublicClient>(FplPublicClient);
  });

  it('fetches bootstrap-static and returns the parsed body', async () => {
    const body: BootstrapStaticResponse = {
      events: [],
      teams: [],
      element_types: [],
      elements: [],
      game_settings: {
        squad_squadsize: 15,
        squad_squadplay: 11,
        squad_team_limit: 3,
        squad_total_spend: 1000,
      },
    };
    httpService.get.mockReturnValue(
      of({ data: body } as AxiosResponse<BootstrapStaticResponse>),
    );

    const result = await client.bootstrapStatic();

    expect(httpService.get).toHaveBeenCalledWith(
      'https://fantasy.premierleague.com/api/bootstrap-static/',
    );
    expect(result).toBe(body);
  });

  it('fetches fixtures for a given gameweek', async () => {
    const body: RawFixture[] = [];
    httpService.get.mockReturnValue(
      of({ data: body } as AxiosResponse<RawFixture[]>),
    );

    const result = await client.fixtures(3);

    expect(httpService.get).toHaveBeenCalledWith(
      'https://fantasy.premierleague.com/api/fixtures/',
      { params: { event: 3 } },
    );
    expect(result).toBe(body);
  });

  it('fetches all fixtures when no gameweek is given', async () => {
    httpService.get.mockReturnValue(
      of({ data: [] } as unknown as AxiosResponse<RawFixture[]>),
    );

    await client.fixtures();

    expect(httpService.get).toHaveBeenCalledWith(
      'https://fantasy.premierleague.com/api/fixtures/',
      { params: undefined },
    );
  });

  it('fetches a player element summary', async () => {
    const body: ElementSummaryResponse = { fixtures: [], history: [] };
    httpService.get.mockReturnValue(
      of({ data: body } as AxiosResponse<ElementSummaryResponse>),
    );

    const result = await client.elementSummary(1);

    expect(httpService.get).toHaveBeenCalledWith(
      'https://fantasy.premierleague.com/api/element-summary/1/',
    );
    expect(result).toBe(body);
  });

  it('fetches live gameweek stats', async () => {
    const body: LiveGameweekResponse = { elements: [] };
    httpService.get.mockReturnValue(
      of({ data: body } as AxiosResponse<LiveGameweekResponse>),
    );

    const result = await client.liveGameweek(3);

    expect(httpService.get).toHaveBeenCalledWith(
      'https://fantasy.premierleague.com/api/event/3/live/',
    );
    expect(result).toBe(body);
  });

  it('fetches an entry', async () => {
    const body: RawEntry = {
      id: 1,
      current_event: 3,
      last_deadline_bank: 0,
      last_deadline_value: 1000,
    };
    httpService.get.mockReturnValue(
      of({ data: body } as AxiosResponse<RawEntry>),
    );

    const result = await client.getEntry(1);

    expect(httpService.get).toHaveBeenCalledWith(
      'https://fantasy.premierleague.com/api/entry/1/',
    );
    expect(result).toBe(body);
  });

  it('fetches entry picks for a gameweek', async () => {
    const body: EntryPicksResponse = {
      active_chip: null,
      entry_history: { event: 3, points: 55, bank: 0, value: 1000 },
      picks: [],
    };
    httpService.get.mockReturnValue(
      of({ data: body } as AxiosResponse<EntryPicksResponse>),
    );

    const result = await client.getEntryPicks(1, 3);

    expect(httpService.get).toHaveBeenCalledWith(
      'https://fantasy.premierleague.com/api/entry/1/event/3/picks/',
    );
    expect(result).toBe(body);
  });
});
