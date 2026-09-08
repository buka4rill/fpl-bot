import { Test, TestingModule } from '@nestjs/testing';
import { TeamStateController } from './team-state.controller';
import { TeamStateService } from './team-state.service';
import { IngestionService } from '../ingestion/ingestion.service';
import { AuthService } from '../auth/auth.service';
import { Gameweek } from '../common/types/domain.types';

describe('TeamStateController', () => {
  let controller: TeamStateController;
  let teamStateService: { reportTeamState: jest.Mock };
  let ingestionService: { getBootstrapSnapshot: jest.Mock };
  let authService: { assertAuthenticated: jest.Mock };

  const gameweek = (id: number, isNext: boolean): Gameweek => ({
    id,
    deadlineAt: '2026-09-12T12:30:00Z',
    isCurrent: false,
    isNext,
    finished: false,
  });

  const state = {
    freeTransfers: 2,
    bank: 0.2,
    teamValue: 99.8,
    chips: [],
  };

  beforeEach(async () => {
    teamStateService = {
      reportTeamState: jest.fn().mockResolvedValue(state),
    };
    ingestionService = { getBootstrapSnapshot: jest.fn() };
    authService = {
      assertAuthenticated: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [TeamStateController],
      providers: [
        { provide: TeamStateService, useValue: teamStateService },
        { provide: IngestionService, useValue: ingestionService },
        { provide: AuthService, useValue: authService },
      ],
    }).compile();

    controller = module.get<TeamStateController>(TeamStateController);
  });

  it('reports team state for the upcoming gameweek', async () => {
    ingestionService.getBootstrapSnapshot.mockResolvedValue({
      gameweeks: [gameweek(3, false), gameweek(4, true)],
    });

    const result = await controller.triggerReport();

    expect(teamStateService.reportTeamState).toHaveBeenCalledWith(4);
    expect(result).toEqual({ gameweekId: 4, state });
  });

  it('throws when there is no upcoming gameweek', async () => {
    ingestionService.getBootstrapSnapshot.mockResolvedValue({
      gameweeks: [gameweek(3, false)],
    });

    await expect(controller.triggerReport()).rejects.toThrow(
      'No upcoming gameweek found',
    );
    expect(teamStateService.reportTeamState).not.toHaveBeenCalled();
  });

  it('checks authentication before doing anything else', async () => {
    authService.assertAuthenticated.mockRejectedValue(
      new Error('Not authenticated with FPL'),
    );

    await expect(controller.triggerReport()).rejects.toThrow(
      'Not authenticated with FPL',
    );
    expect(ingestionService.getBootstrapSnapshot).not.toHaveBeenCalled();
  });
});
