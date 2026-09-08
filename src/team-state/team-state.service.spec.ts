import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { TeamStateService } from './team-state.service';
import { AlertService } from '../alert/alert.service';
import {
  ExecutionService,
  TeamStateShape,
} from '../execution/execution.service';

describe('TeamStateService', () => {
  let service: TeamStateService;
  let alertService: { sendMessage: jest.Mock };
  let executionService: { getTeamState: jest.Mock };
  const TEAM_ID = 42;

  const teamState = (
    overrides: Partial<TeamStateShape> = {},
  ): TeamStateShape => ({
    chips: [
      {
        id: 4,
        status_for_entry: 'available',
        played_by_entry: [],
        name: 'bboost',
        number: 1,
        start_event: 1,
        stop_event: 19,
        chip_type: 'team',
        is_pending: false,
      },
      {
        id: 1,
        status_for_entry: 'unavailable',
        played_by_entry: [],
        name: 'wildcard',
        number: 1,
        start_event: 2,
        stop_event: 19,
        chip_type: 'transfer',
        is_pending: false,
      },
    ],
    transfers: {
      cost: 4,
      status: 'limited',
      limit: 3,
      made: 0,
      bank: 2,
      value: 998,
    },
    ...overrides,
  });

  beforeEach(async () => {
    alertService = { sendMessage: jest.fn() };
    executionService = {
      getTeamState: jest.fn().mockResolvedValue(teamState()),
    };
    const config = {
      get: jest.fn((key: string) =>
        key === 'fpl.teamId' ? String(TEAM_ID) : undefined,
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TeamStateService,
        { provide: AlertService, useValue: alertService },
        { provide: ExecutionService, useValue: executionService },
        { provide: ConfigService, useValue: config },
      ],
    }).compile();

    service = module.get<TeamStateService>(TeamStateService);
  });

  describe('getTeamState', () => {
    it('reads free transfers, bank, and value straight from ExecutionService', async () => {
      const state = await service.getTeamState();

      expect(executionService.getTeamState).toHaveBeenCalledWith(TEAM_ID);
      expect(state.freeTransfers).toBe(3);
      expect(state.bank).toBeCloseTo(0.2);
      expect(state.teamValue).toBeCloseTo(99.8);
      expect(state.chips).toHaveLength(2);
    });

    it('treats an unlimited transfers status the same as a Wildcard/Free Hit week (no hit cost)', async () => {
      executionService.getTeamState.mockResolvedValue(
        teamState({
          transfers: {
            cost: 4,
            status: 'unlimited',
            limit: null,
            made: 0,
            bank: 2,
            value: 998,
          },
        }),
      );

      const state = await service.getTeamState();

      expect(state.freeTransfers).toBe(15);
    });

    it('throws on an unrecognized transfers shape rather than guessing a number', async () => {
      executionService.getTeamState.mockResolvedValue(
        teamState({
          transfers: {
            cost: 4,
            status: 'something-new',
            limit: null,
            made: 0,
            bank: 2,
            value: 998,
          },
        }),
      );

      await expect(service.getTeamState()).rejects.toThrow(
        'Unrecognized transfers shape',
      );
    });
  });

  describe('reportTeamState', () => {
    it('sends a formatted report and returns the underlying state', async () => {
      const state = await service.reportTeamState(4);

      expect(alertService.sendMessage).toHaveBeenCalledTimes(1);
      const [message] = alertService.sendMessage.mock.calls[0] as [string];
      expect(message).toContain('GW4');
      expect(message).toContain('Free Transfers: 3');
      expect(message).toContain('Bench Boost 1');
      expect(message).toContain('Wildcard 1');
      expect(state.freeTransfers).toBe(3);
    });
  });
});
