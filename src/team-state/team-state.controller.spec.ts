import { Test, TestingModule } from '@nestjs/testing';
import { TeamStateController } from './team-state.controller';
import { TeamStateService } from './team-state.service';
import { IngestionService } from '../ingestion/ingestion.service';
import { Gameweek } from '../common/types/domain.types';

describe('TeamStateController', () => {
  let controller: TeamStateController;
  let teamStateService: { ensureWeeklyPromptStarted: jest.Mock };
  let ingestionService: { getBootstrapSnapshot: jest.Mock };

  const gameweek = (id: number, isNext: boolean): Gameweek => ({
    id,
    deadlineAt: '2026-09-12T12:30:00Z',
    isCurrent: false,
    isNext,
    finished: false,
  });

  beforeEach(async () => {
    teamStateService = { ensureWeeklyPromptStarted: jest.fn() };
    ingestionService = { getBootstrapSnapshot: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [TeamStateController],
      providers: [
        { provide: TeamStateService, useValue: teamStateService },
        { provide: IngestionService, useValue: ingestionService },
      ],
    }).compile();

    controller = module.get<TeamStateController>(TeamStateController);
  });

  it('triggers the weekly prompt for the upcoming gameweek', async () => {
    ingestionService.getBootstrapSnapshot.mockResolvedValue({
      gameweeks: [gameweek(3, false), gameweek(4, true)],
    });

    const result = await controller.triggerWeeklyPrompt();

    expect(teamStateService.ensureWeeklyPromptStarted).toHaveBeenCalledWith(4);
    expect(result).toEqual({ gameweekId: 4 });
  });

  it('throws when there is no upcoming gameweek', async () => {
    ingestionService.getBootstrapSnapshot.mockResolvedValue({
      gameweeks: [gameweek(3, false)],
    });

    await expect(controller.triggerWeeklyPrompt()).rejects.toThrow(
      'No upcoming gameweek found',
    );
    expect(teamStateService.ensureWeeklyPromptStarted).not.toHaveBeenCalled();
  });
});
