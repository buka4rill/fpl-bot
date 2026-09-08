import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { DeadlineWatcherService } from './deadline-watcher.service';
import { IngestionService } from '../ingestion/ingestion.service';
import { ProposalService } from '../proposal/proposal.service';
import { AlertService } from '../alert/alert.service';
import { ApprovalService } from '../approval/approval.service';
import { TeamStateService } from '../team-state/team-state.service';
import {
  Gameweek,
  Player,
  PlayerSnapshot,
  Proposal,
} from '../common/types/domain.types';
import { ProposalStatus } from '../common/enums/proposal-status.enum';
import { Position } from '../common/enums/position.enum';

describe('DeadlineWatcherService', () => {
  let service: DeadlineWatcherService;
  let ingestionService: { getBootstrapSnapshot: jest.Mock };
  let proposalService: {
    generateProposal: jest.Mock;
    findByGameweekId: jest.Mock;
  };
  let alertService: { sendProposal: jest.Mock };
  let approvalService: { expireOverdue: jest.Mock };
  let teamStateService: {
    isFreshFor: jest.Mock;
    ensureWeeklyPromptStarted: jest.Mock;
    getFreeTransfers: jest.Mock;
  };
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

  const snapshots: PlayerSnapshot[] = [
    { gameweekId: 4, playerId: 1, price: 5.0, ownershipPct: 10 },
  ];

  const proposal: Proposal = {
    id: 'prop-1',
    gameweekId: 4,
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
  };

  const gameweekWithDeadline = (deadlineAt: string): Gameweek => ({
    id: 4,
    deadlineAt,
    isCurrent: false,
    isNext: true,
    finished: false,
  });

  const hoursFromNow = (hours: number): string =>
    new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();

  beforeEach(async () => {
    ingestionService = { getBootstrapSnapshot: jest.fn() };
    proposalService = {
      generateProposal: jest.fn().mockResolvedValue(proposal),
      findByGameweekId: jest.fn().mockResolvedValue(undefined),
    };
    alertService = { sendProposal: jest.fn() };
    approvalService = { expireOverdue: jest.fn() };
    // Fresh by default so every pre-existing test keeps exercising the same
    // straight-through flow as before this gate was added.
    teamStateService = {
      isFreshFor: jest.fn().mockResolvedValue(true),
      ensureWeeklyPromptStarted: jest.fn(),
      getFreeTransfers: jest.fn().mockResolvedValue(1),
    };
    config = { get: jest.fn().mockReturnValue(24) }; // deadlineLeadHours

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DeadlineWatcherService,
        { provide: IngestionService, useValue: ingestionService },
        { provide: ProposalService, useValue: proposalService },
        { provide: AlertService, useValue: alertService },
        { provide: ApprovalService, useValue: approvalService },
        { provide: TeamStateService, useValue: teamStateService },
        { provide: ConfigService, useValue: config },
      ],
    }).compile();

    service = module.get<DeadlineWatcherService>(DeadlineWatcherService);
  });

  it('always sweeps overdue proposals', async () => {
    ingestionService.getBootstrapSnapshot.mockResolvedValue({
      gameweeks: [],
      players,
      snapshots,
    });

    await service.checkDeadline();

    expect(approvalService.expireOverdue).toHaveBeenCalledTimes(1);
  });

  it('does nothing when there is no upcoming gameweek', async () => {
    ingestionService.getBootstrapSnapshot.mockResolvedValue({
      gameweeks: [],
      players,
      snapshots,
    });

    await service.checkDeadline();

    expect(proposalService.generateProposal).not.toHaveBeenCalled();
  });

  it('does nothing before the lead-time window opens', async () => {
    // deadline 48h out, lead time 24h -> trigger window opens in 24h
    ingestionService.getBootstrapSnapshot.mockResolvedValue({
      gameweeks: [gameweekWithDeadline(hoursFromNow(48))],
      players,
      snapshots,
    });

    await service.checkDeadline();

    expect(proposalService.generateProposal).not.toHaveBeenCalled();
  });

  it('does nothing once the deadline has already passed', async () => {
    ingestionService.getBootstrapSnapshot.mockResolvedValue({
      gameweeks: [gameweekWithDeadline(hoursFromNow(-1))],
      players,
      snapshots,
    });

    await service.checkDeadline();

    expect(proposalService.generateProposal).not.toHaveBeenCalled();
  });

  it('generates and sends a proposal within the lead-time window', async () => {
    // deadline 12h out, lead time 24h -> already inside the window
    ingestionService.getBootstrapSnapshot.mockResolvedValue({
      gameweeks: [gameweekWithDeadline(hoursFromNow(12))],
      players,
      snapshots,
    });

    await service.checkDeadline();

    expect(proposalService.generateProposal).toHaveBeenCalledTimes(1);
    expect(proposalService.generateProposal).toHaveBeenCalledWith(1);
    expect(alertService.sendProposal).toHaveBeenCalledWith(
      proposal,
      players,
      snapshots,
    );
  });

  it('blocks proposal generation until the weekly free-transfer/chip prompt is answered', async () => {
    teamStateService.isFreshFor.mockResolvedValue(false);
    ingestionService.getBootstrapSnapshot.mockResolvedValue({
      gameweeks: [gameweekWithDeadline(hoursFromNow(12))],
      players,
      snapshots,
    });

    await service.checkDeadline();

    expect(teamStateService.ensureWeeklyPromptStarted).toHaveBeenCalledWith(4);
    expect(proposalService.generateProposal).not.toHaveBeenCalled();
    expect(alertService.sendProposal).not.toHaveBeenCalled();
  });

  it('passes the confirmed free-transfer count into proposal generation once fresh', async () => {
    teamStateService.getFreeTransfers.mockResolvedValue(3);
    ingestionService.getBootstrapSnapshot.mockResolvedValue({
      gameweeks: [gameweekWithDeadline(hoursFromNow(12))],
      players,
      snapshots,
    });

    await service.checkDeadline();

    expect(proposalService.generateProposal).toHaveBeenCalledWith(3);
  });

  it('does not re-propose a gameweek already persisted before a restart', async () => {
    // Simulates restarting mid-window: no in-process claim, but the DB
    // already has a proposal for this gameweek from before the restart.
    proposalService.findByGameweekId.mockResolvedValue(proposal);
    ingestionService.getBootstrapSnapshot.mockResolvedValue({
      gameweeks: [gameweekWithDeadline(hoursFromNow(12))],
      players,
      snapshots,
    });

    await service.checkDeadline();

    expect(proposalService.generateProposal).not.toHaveBeenCalled();
  });

  it('does not re-propose for the same gameweek twice', async () => {
    ingestionService.getBootstrapSnapshot.mockResolvedValue({
      gameweeks: [gameweekWithDeadline(hoursFromNow(12))],
      players,
      snapshots,
    });

    await service.checkDeadline();
    await service.checkDeadline();

    expect(proposalService.generateProposal).toHaveBeenCalledTimes(1);
  });

  it('does not double-propose when two checks genuinely overlap', async () => {
    // Regression test: mockResolvedValue resolves near-instantly, which
    // hides a race where the guard is checked long before the async work
    // (a real network call) finishes and the claim is recorded. Holding
    // generateProposal open lets both checkDeadline() calls actually
    // interleave, the way they did live against the real API.
    let resolveGenerate!: (value: Proposal) => void;
    proposalService.generateProposal.mockReturnValue(
      new Promise<Proposal>((resolve) => {
        resolveGenerate = resolve;
      }),
    );
    ingestionService.getBootstrapSnapshot.mockResolvedValue({
      gameweeks: [gameweekWithDeadline(hoursFromNow(12))],
      players,
      snapshots,
    });

    const first = service.checkDeadline();
    const second = service.checkDeadline();
    resolveGenerate(proposal);
    await Promise.all([first, second]);

    expect(proposalService.generateProposal).toHaveBeenCalledTimes(1);
  });

  it('rolls back the claim on failure so the next check retries', async () => {
    ingestionService.getBootstrapSnapshot.mockResolvedValue({
      gameweeks: [gameweekWithDeadline(hoursFromNow(12))],
      players,
      snapshots,
    });
    proposalService.generateProposal.mockRejectedValueOnce(new Error('boom'));

    await expect(service.checkDeadline()).rejects.toThrow('boom');

    proposalService.generateProposal.mockResolvedValue(proposal);
    await service.checkDeadline();

    expect(proposalService.generateProposal).toHaveBeenCalledTimes(2);
  });

  it('respects a configured deadlineLeadHours', async () => {
    config.get.mockReturnValue(1); // only a 1h lead time
    // deadline 12h out, lead time 1h -> window hasn't opened yet
    ingestionService.getBootstrapSnapshot.mockResolvedValue({
      gameweeks: [gameweekWithDeadline(hoursFromNow(12))],
      players,
      snapshots,
    });

    await service.checkDeadline();

    expect(proposalService.generateProposal).not.toHaveBeenCalled();
  });

  describe('lifecycle', () => {
    beforeEach(() => {
      jest.useFakeTimers();
      ingestionService.getBootstrapSnapshot.mockResolvedValue({
        gameweeks: [],
        players,
        snapshots,
      });
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('checks immediately on init and again on each poll interval', async () => {
      service.onModuleInit();
      await Promise.resolve(); // let the immediate check's promise settle
      expect(ingestionService.getBootstrapSnapshot).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(60 * 60 * 1000);
      await Promise.resolve();
      expect(ingestionService.getBootstrapSnapshot).toHaveBeenCalledTimes(2);

      service.onModuleDestroy();
    });

    it('stops polling after destroy', async () => {
      service.onModuleInit();
      await Promise.resolve();
      service.onModuleDestroy();
      ingestionService.getBootstrapSnapshot.mockClear();

      jest.advanceTimersByTime(2 * 60 * 60 * 1000);
      await Promise.resolve();

      expect(ingestionService.getBootstrapSnapshot).not.toHaveBeenCalled();
    });
  });
});
