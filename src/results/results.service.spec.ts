import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ResultsService } from './results.service';
import { IngestionService } from '../ingestion/ingestion.service';
import { ProposalService } from '../proposal/proposal.service';
import { AlertService } from '../alert/alert.service';
import { Gameweek, Player, Proposal } from '../common/types/domain.types';
import { ProposalStatus } from '../common/enums/proposal-status.enum';
import { Position } from '../common/enums/position.enum';

describe('ResultsService', () => {
  let service: ResultsService;
  let ingestionService: {
    getBootstrapSnapshot: jest.Mock;
    getGameweekPlayerStats: jest.Mock;
    getGameweekResult: jest.Mock;
  };
  let proposalService: {
    findUnreportedTerminal: jest.Mock;
    markResultReported: jest.Mock;
  };
  let alertService: { sendResultReport: jest.Mock };
  let config: { get: jest.Mock };

  const players: Player[] = [
    {
      id: 1,
      webName: 'Raya',
      fullName: 'David Raya',
      teamId: 1,
      position: Position.GKP,
    },
  ];

  const finishedGameweek: Gameweek = {
    id: 4,
    deadlineAt: '2026-09-12T12:30:00Z',
    isCurrent: false,
    isNext: false,
    finished: true,
    season: '26_27',
  };

  const unfinishedGameweek: Gameweek = {
    id: 5,
    deadlineAt: '2026-09-19T12:30:00Z',
    isCurrent: true,
    isNext: false,
    finished: false,
    season: '26_27',
  };

  const baseProposal = (overrides: Partial<Proposal> = {}): Proposal => ({
    id: 'prop-1',
    gameweekId: 4,
    season: '26_27',
    deadlineAt: '2026-09-12T12:30:00Z',
    transfers: [],
    lineup: [],
    benchGoalkeeperId: 12,
    benchOutfieldIds: [13, 14, 15],
    captainId: 1,
    viceCaptainId: 2,
    expectedGain: 10,
    hitCost: 0,
    status: ProposalStatus.APPROVED,
    createdAt: '2026-09-05T00:00:00Z',
    ...overrides,
  });

  beforeEach(async () => {
    ingestionService = {
      getBootstrapSnapshot: jest.fn().mockResolvedValue({
        gameweeks: [finishedGameweek, unfinishedGameweek],
        players,
        rules: {
          squadSize: 15,
          startingSize: 11,
          maxPerClub: 3,
          budget: 100,
          positions: [],
        },
      }),
      getGameweekPlayerStats: jest.fn().mockResolvedValue(new Map()),
      getGameweekResult: jest.fn().mockResolvedValue({ actualPoints: 50 }),
    };
    proposalService = {
      findUnreportedTerminal: jest.fn().mockResolvedValue([]),
      markResultReported: jest.fn().mockResolvedValue(undefined),
    };
    alertService = { sendResultReport: jest.fn().mockResolvedValue(undefined) };
    config = { get: jest.fn().mockReturnValue('10594985') };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ResultsService,
        { provide: IngestionService, useValue: ingestionService },
        { provide: ProposalService, useValue: proposalService },
        { provide: AlertService, useValue: alertService },
        { provide: ConfigService, useValue: config },
      ],
    }).compile();

    service = module.get<ResultsService>(ResultsService);
  });

  it('reports a proposal whose gameweek has finished', async () => {
    proposalService.findUnreportedTerminal.mockResolvedValue([
      baseProposal({ gameweekId: 4, season: '26_27' }),
    ]);

    await service.checkFinishedGameweeks();

    expect(alertService.sendResultReport).toHaveBeenCalledTimes(1);
    expect(proposalService.markResultReported).toHaveBeenCalledWith('prop-1');
  });

  it('skips a proposal whose gameweek has not finished yet', async () => {
    proposalService.findUnreportedTerminal.mockResolvedValue([
      baseProposal({ gameweekId: 5, season: '26_27' }),
    ]);

    await service.checkFinishedGameweeks();

    expect(alertService.sendResultReport).not.toHaveBeenCalled();
    expect(proposalService.markResultReported).not.toHaveBeenCalled();
  });

  it('does not match a finished gameweek from a different season with the same id', async () => {
    // Regression test: FPL resets gameweek ids every season — a proposal
    // for a different season's GW4 must not be treated as reportable just
    // because this season's GW4 happens to be finished.
    proposalService.findUnreportedTerminal.mockResolvedValue([
      baseProposal({ gameweekId: 4, season: '25_26' }),
    ]);

    await service.checkFinishedGameweeks();

    expect(alertService.sendResultReport).not.toHaveBeenCalled();
  });

  it('fetches player stats and the real actual score for the right gameweek/team', async () => {
    proposalService.findUnreportedTerminal.mockResolvedValue([
      baseProposal({ gameweekId: 4, season: '26_27' }),
    ]);

    await service.checkFinishedGameweeks();

    expect(ingestionService.getGameweekPlayerStats).toHaveBeenCalledWith(4);
    expect(ingestionService.getGameweekResult).toHaveBeenCalledWith(
      10594985,
      4,
    );
  });

  it('passes the computed predicted score and real actual score to the alert', async () => {
    ingestionService.getGameweekResult.mockResolvedValue({ actualPoints: 63 });
    proposalService.findUnreportedTerminal.mockResolvedValue([
      baseProposal({
        gameweekId: 4,
        season: '26_27',
        lineup: [],
        benchGoalkeeperId: 1,
        benchOutfieldIds: [],
        captainId: 1,
        viceCaptainId: 1,
      }),
    ]);

    await service.checkFinishedGameweeks();

    expect(alertService.sendResultReport).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'prop-1' }),
      0, // no players in the stats map -> nothing scores
      63,
    );
  });

  it('processes multiple unreported proposals independently', async () => {
    proposalService.findUnreportedTerminal.mockResolvedValue([
      baseProposal({ id: 'prop-1', gameweekId: 4, season: '26_27' }),
      baseProposal({ id: 'prop-2', gameweekId: 4, season: '26_27' }),
    ]);

    await service.checkFinishedGameweeks();

    expect(alertService.sendResultReport).toHaveBeenCalledTimes(2);
    expect(proposalService.markResultReported).toHaveBeenCalledWith('prop-1');
    expect(proposalService.markResultReported).toHaveBeenCalledWith('prop-2');
  });

  it('does not mark as reported, and does not throw, when sending the report fails', async () => {
    alertService.sendResultReport.mockRejectedValue(new Error('telegram down'));
    proposalService.findUnreportedTerminal.mockResolvedValue([
      baseProposal({ gameweekId: 4, season: '26_27' }),
    ]);

    await expect(service.checkFinishedGameweeks()).resolves.not.toThrow();

    expect(proposalService.markResultReported).not.toHaveBeenCalled();
  });

  it('continues to the next proposal after one fails', async () => {
    alertService.sendResultReport
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined);
    proposalService.findUnreportedTerminal.mockResolvedValue([
      baseProposal({ id: 'prop-1', gameweekId: 4, season: '26_27' }),
      baseProposal({ id: 'prop-2', gameweekId: 4, season: '26_27' }),
    ]);

    await service.checkFinishedGameweeks();

    expect(proposalService.markResultReported).toHaveBeenCalledTimes(1);
    expect(proposalService.markResultReported).toHaveBeenCalledWith('prop-2');
  });
});
