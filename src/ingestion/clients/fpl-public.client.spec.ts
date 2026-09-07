import { Test, TestingModule } from '@nestjs/testing';
import { HttpService } from '@nestjs/axios';
import { of } from 'rxjs';
import { AxiosResponse } from 'axios';
import { FplPublicClient } from './fpl-public.client';
import {
  BootstrapStaticResponse,
  ElementSummaryResponse,
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
});
