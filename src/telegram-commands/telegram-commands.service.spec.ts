import { Test, TestingModule } from '@nestjs/testing';
import { TelegramCommandsService } from './telegram-commands.service';
import { IngestionService } from '../ingestion/ingestion.service';
import { ProposalService } from '../proposal/proposal.service';
import { TeamStateService } from '../team-state/team-state.service';
import { AuthService } from '../auth/auth.service';
import { AlertService } from '../alert/alert.service';
import { ResultsService } from '../results/results.service';
import { FplChip } from '../common/enums/chip.enum';
import {
  Gameweek,
  Player,
  PlayerSnapshot,
  Proposal,
} from '../common/types/domain.types';
import { ProposalStatus } from '../common/enums/proposal-status.enum';
import { Position } from '../common/enums/position.enum';
import { TriggerSource } from '../common/enums/trigger-source.enum';

describe('TelegramCommandsService', () => {
  let service: TelegramCommandsService;
  let ingestionService: { getBootstrapSnapshot: jest.Mock };
  let proposalService: {
    generateProposal: jest.Mock;
    generateBestProposal: jest.Mock;
  };
  let teamStateService: { reportTeamState: jest.Mock };
  let authService: {
    assertAuthenticated: jest.Mock;
    isAuthenticated: jest.Mock;
  };
  let alertService: { sendMessage: jest.Mock; sendProposal: jest.Mock };
  let resultsService: { checkFinishedGameweeks: jest.Mock };

  const players: Player[] = [
    {
      id: 1,
      webName: 'Raya',
      fullName: 'David Raya',
      teamId: 1,
      position: Position.GKP,
    },
  ];
  const snapshots: PlayerSnapshot[] = [
    { gameweekId: 4, playerId: 1, price: 5.0, ownershipPct: 10 },
  ];
  const nextGameweek: Gameweek = {
    id: 4,
    deadlineAt: '2026-09-12T12:30:00Z',
    isCurrent: false,
    isNext: true,
    finished: false,
    season: '26_27',
  };
  const proposal: Proposal = {
    id: 'prop-1',
    gameweekId: 4,
    season: '26_27',
    deadlineAt: '2026-09-12T12:30:00Z',
    transfers: [],
    lineup: [],
    benchGoalkeeperId: 1,
    benchOutfieldIds: [],
    captainId: 1,
    viceCaptainId: 1,
    expectedGain: 10,
    hitCost: 0,
    status: ProposalStatus.PENDING,
    createdAt: '2026-09-05T00:00:00Z',
    source: TriggerSource.MANUAL,
  };

  beforeEach(async () => {
    ingestionService = {
      getBootstrapSnapshot: jest.fn().mockResolvedValue({
        gameweeks: [nextGameweek],
        players,
        snapshots,
      }),
    };
    proposalService = {
      generateProposal: jest.fn().mockResolvedValue(proposal),
      generateBestProposal: jest
        .fn()
        .mockResolvedValue({ proposal, candidates: [] }),
    };
    teamStateService = {
      reportTeamState: jest.fn().mockResolvedValue({
        freeTransfers: 2,
        bank: 0.2,
        teamValue: 99.8,
        chips: [],
      }),
    };
    authService = {
      assertAuthenticated: jest.fn().mockResolvedValue(undefined),
      isAuthenticated: jest.fn().mockResolvedValue(true),
    };
    alertService = {
      sendMessage: jest.fn().mockResolvedValue(undefined),
      sendProposal: jest.fn().mockResolvedValue(undefined),
    };
    resultsService = {
      checkFinishedGameweeks: jest.fn().mockResolvedValue(0),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TelegramCommandsService,
        { provide: IngestionService, useValue: ingestionService },
        { provide: ProposalService, useValue: proposalService },
        { provide: TeamStateService, useValue: teamStateService },
        { provide: AuthService, useValue: authService },
        { provide: AlertService, useValue: alertService },
        { provide: ResultsService, useValue: resultsService },
      ],
    }).compile();

    service = module.get<TelegramCommandsService>(TelegramCommandsService);
  });

  describe('/status', () => {
    it('reports team state for the upcoming gameweek', async () => {
      await service.handleCommand('/status');

      expect(teamStateService.reportTeamState).toHaveBeenCalledWith(4);
    });

    it('reports when there is no upcoming gameweek', async () => {
      ingestionService.getBootstrapSnapshot.mockResolvedValue({
        gameweeks: [],
        players,
        snapshots,
      });

      await service.handleCommand('/status');

      expect(alertService.sendMessage).toHaveBeenCalledWith(
        'No upcoming gameweek found.',
      );
      expect(teamStateService.reportTeamState).not.toHaveBeenCalled();
    });
  });

  describe('/propose', () => {
    it('checks auth, then generates and sends a proposal', async () => {
      await service.handleCommand('/propose');

      expect(authService.assertAuthenticated).toHaveBeenCalled();
      expect(teamStateService.reportTeamState).toHaveBeenCalledWith(4);
      expect(proposalService.generateBestProposal).toHaveBeenCalledWith(
        2,
        [],
        TriggerSource.MANUAL,
      );
      expect(alertService.sendProposal).toHaveBeenCalledWith(
        proposal,
        players,
        snapshots,
        [],
      );
    });

    it('reports the auth error instead of generating a proposal when not authenticated', async () => {
      authService.assertAuthenticated.mockRejectedValue(
        new Error('Not authenticated with FPL — run `pnpm run auth:login`.'),
      );

      await service.handleCommand('/propose');

      expect(proposalService.generateBestProposal).not.toHaveBeenCalled();
      expect(alertService.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining('Not authenticated with FPL'),
      );
    });

    it('reports when there is no upcoming gameweek to propose for', async () => {
      ingestionService.getBootstrapSnapshot.mockResolvedValue({
        gameweeks: [],
        players,
        snapshots,
      });

      await service.handleCommand('/propose');

      expect(alertService.sendMessage).toHaveBeenCalledWith(
        'No upcoming gameweek found to propose for.',
      );
      expect(proposalService.generateBestProposal).not.toHaveBeenCalled();
    });
  });

  describe('/chip', () => {
    it('checks auth, then generates and sends a proposal with the declared chip', async () => {
      await service.handleCommand('/chip bboost');

      expect(authService.assertAuthenticated).toHaveBeenCalled();
      expect(proposalService.generateProposal).toHaveBeenCalledWith(
        undefined,
        FplChip.BENCH_BOOST,
        TriggerSource.MANUAL,
      );
      expect(alertService.sendProposal).toHaveBeenCalledWith(
        proposal,
        players,
        snapshots,
      );
    });

    it('is case-insensitive on the chip name', async () => {
      await service.handleCommand('/chip 3XC');

      expect(proposalService.generateProposal).toHaveBeenCalledWith(
        undefined,
        FplChip.TRIPLE_CAPTAIN,
        TriggerSource.MANUAL,
      );
    });

    it('reports usage when no chip name is given', async () => {
      await service.handleCommand('/chip');

      expect(alertService.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining('Usage: /chip'),
      );
      expect(proposalService.generateProposal).not.toHaveBeenCalled();
      expect(authService.assertAuthenticated).not.toHaveBeenCalled();
    });

    it('reports usage when given an unrecognized chip name', async () => {
      await service.handleCommand('/chip freehitzzz');

      expect(alertService.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining('Usage: /chip'),
      );
      expect(proposalService.generateProposal).not.toHaveBeenCalled();
    });

    it('reports the auth error instead of generating a proposal when not authenticated', async () => {
      authService.assertAuthenticated.mockRejectedValue(
        new Error('Not authenticated with FPL — run `pnpm run auth:login`.'),
      );

      await service.handleCommand('/chip wildcard');

      expect(proposalService.generateProposal).not.toHaveBeenCalled();
      expect(alertService.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining('Not authenticated with FPL'),
      );
    });
  });

  describe('/results', () => {
    it('runs the finished-gameweek check', async () => {
      resultsService.checkFinishedGameweeks.mockResolvedValue(2);

      await service.handleCommand('/results');

      expect(resultsService.checkFinishedGameweeks).toHaveBeenCalled();
    });

    it('reports explicitly when nothing new was found, rather than staying silent', async () => {
      resultsService.checkFinishedGameweeks.mockResolvedValue(0);

      await service.handleCommand('/results');

      expect(alertService.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining('No new finished-gameweek results'),
      );
    });

    it('sends nothing extra when results were actually reported', async () => {
      resultsService.checkFinishedGameweeks.mockResolvedValue(1);

      await service.handleCommand('/results');

      expect(alertService.sendMessage).not.toHaveBeenCalled();
    });
  });

  describe('/login', () => {
    it('reports authenticated when logged in', async () => {
      authService.isAuthenticated.mockResolvedValue(true);

      await service.handleCommand('/login');

      expect(alertService.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining('✅ Logged in'),
      );
    });

    it('reports not authenticated, with a reminder to run auth:login locally', async () => {
      authService.isAuthenticated.mockResolvedValue(false);

      await service.handleCommand('/login');

      const [text] = alertService.sendMessage.mock.calls[0] as [string];
      expect(text).toContain('Not logged in');
      expect(text).toContain('pnpm run auth:login');
    });

    it('never attempts to actually log in', async () => {
      await service.handleCommand('/login');

      expect(authService.assertAuthenticated).not.toHaveBeenCalled();
    });
  });

  describe('/help and /start', () => {
    it('lists the available commands', async () => {
      await service.handleCommand('/help');

      const [text] = alertService.sendMessage.mock.calls[0] as [string];
      expect(text).toContain('/status');
      expect(text).toContain('/propose');
      expect(text).toContain('/chip');
      expect(text).toContain('/results');
      expect(text).toContain('/login');
    });

    it('treats /start the same as /help', async () => {
      await service.handleCommand('/start');

      expect(alertService.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining('Available commands'),
      );
    });
  });

  describe('unknown commands', () => {
    it('reports an unknown command along with the help text', async () => {
      await service.handleCommand('/nonsense');

      const [text] = alertService.sendMessage.mock.calls[0] as [string];
      expect(text).toContain('Unknown command: /nonsense');
      expect(text).toContain('/status');
    });
  });

  describe('command parsing', () => {
    it('is case-insensitive', async () => {
      await service.handleCommand('/STATUS');

      expect(teamStateService.reportTeamState).toHaveBeenCalled();
    });

    it('strips a group-chat @BotName suffix', async () => {
      await service.handleCommand('/status@FplProdBot');

      expect(teamStateService.reportTeamState).toHaveBeenCalled();
    });

    it('ignores arguments after the command', async () => {
      await service.handleCommand('/login now please');

      expect(authService.isAuthenticated).toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('reports a failure over Telegram rather than throwing', async () => {
      teamStateService.reportTeamState.mockRejectedValue(
        new Error('FPL API down'),
      );

      await expect(service.handleCommand('/status')).resolves.not.toThrow();

      expect(alertService.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining('FPL API down'),
      );
    });
  });
});
