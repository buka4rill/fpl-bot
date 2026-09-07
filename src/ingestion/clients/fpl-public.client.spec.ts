import { Test, TestingModule } from '@nestjs/testing';
import { HttpService } from '@nestjs/axios';
import { of } from 'rxjs';
import { AxiosResponse } from 'axios';
import { FplPublicClient } from './fpl-public.client';
import { BootstrapStaticResponse } from './fpl-api.types';

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
});
