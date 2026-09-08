import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { TeamStateService } from './team-state.service';
import { AlertService } from '../alert/alert.service';
import { ProposalService } from '../proposal/proposal.service';
import { IngestionService } from '../ingestion/ingestion.service';
import { TeamStateEntity } from '../persistence/entities/team-state.entity';
import { Proposal } from '../common/types/domain.types';
import { ProposalStatus } from '../common/enums/proposal-status.enum';

// Minimal in-memory stand-in for Repository<TeamStateEntity> — mirrors the
// real Postgres table's identity/upsert-by-teamId semantics without a live
// DB, same pattern as ProposalService's spec.
class FakeTeamStateRepository {
  private readonly rows = new Map<number, TeamStateEntity>();

  create(entity: TeamStateEntity): TeamStateEntity {
    return entity;
  }

  save(entity: TeamStateEntity): Promise<TeamStateEntity> {
    this.rows.set(entity.teamId, entity);
    return Promise.resolve(entity);
  }

  findOneBy(where: Partial<TeamStateEntity>): Promise<TeamStateEntity | null> {
    return Promise.resolve(this.rows.get(where.teamId as number) ?? null);
  }
}

describe('TeamStateService', () => {
  let service: TeamStateService;
  let alertService: {
    sendMessage: jest.Mock;
    sendYesNoPrompt: jest.Mock;
    sendProposal: jest.Mock;
  };
  let proposalService: {
    findByGameweekId: jest.Mock;
    generateProposal: jest.Mock;
  };
  let ingestionService: { getBootstrapSnapshot: jest.Mock };
  const TEAM_ID = 42;

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

  const setup = async (): Promise<void> => {
    alertService = {
      sendMessage: jest.fn(),
      sendYesNoPrompt: jest.fn(),
      sendProposal: jest.fn(),
    };
    proposalService = {
      findByGameweekId: jest.fn().mockResolvedValue(undefined),
      generateProposal: jest.fn().mockResolvedValue(proposal),
    };
    ingestionService = {
      getBootstrapSnapshot: jest
        .fn()
        .mockResolvedValue({ gameweeks: [], players: [], snapshots: [] }),
    };
    const config = {
      get: jest.fn((key: string) =>
        key === 'fpl.teamId' ? String(TEAM_ID) : undefined,
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TeamStateService,
        {
          provide: getRepositoryToken(TeamStateEntity),
          useClass: FakeTeamStateRepository,
        },
        { provide: AlertService, useValue: alertService },
        { provide: ProposalService, useValue: proposalService },
        { provide: IngestionService, useValue: ingestionService },
        { provide: ConfigService, useValue: config },
      ],
    }).compile();

    service = module.get<TeamStateService>(TeamStateService);
  };

  beforeEach(async () => {
    await setup();
  });

  // Walks a full gw4 sequence (all first-half chips answered "yes") to
  // completion — shared by tests that just need to get there.
  const completeGw4Sequence = async (freeTransfers = '2'): Promise<void> => {
    await service.ensureWeeklyPromptStarted(4);
    await service.handleTextReply(freeTransfers);
    await service.handleChipReply(4, 'wildcard1', 'yes');
    await service.handleChipReply(4, 'freeHit1', 'yes');
    await service.handleChipReply(4, 'benchBoost1', 'yes');
    await service.handleChipReply(4, 'tripleCaptain1', 'yes');
  };

  describe('isFreshFor', () => {
    it('is false when no row exists yet (lazily creates one)', async () => {
      expect(await service.isFreshFor(4)).toBe(false);
    });

    it('is false while a prompt is still pending even if the gameweek matches', async () => {
      await service.ensureWeeklyPromptStarted(4);
      await service.handleTextReply('1'); // advances past free_transfers

      expect(await service.isFreshFor(4)).toBe(false);
    });

    it('is true once every applicable step for that gameweek is answered', async () => {
      await service.ensureWeeklyPromptStarted(4); // gw4: only 4 first-half chip steps
      await service.handleTextReply('2');
      for (let i = 0; i < 4; i++) {
        // pull the pending step off the last sendYesNoPrompt call
        const [, callbackData] = alertService.sendYesNoPrompt.mock.calls[
          alertService.sendYesNoPrompt.mock.calls.length - 1
        ] as [string, string];
        const step = callbackData.split(':')[2];
        await service.handleChipReply(4, step, 'yes');
      }

      expect(await service.isFreshFor(4)).toBe(true);
    });
  });

  describe('ensureWeeklyPromptStarted', () => {
    it('sends the free-transfer question once, not again for a repeated call on the same gameweek', async () => {
      await service.ensureWeeklyPromptStarted(4);
      await service.ensureWeeklyPromptStarted(4);

      expect(alertService.sendMessage).toHaveBeenCalledTimes(1);
    });

    it('restarts the sequence when called for a different gameweek', async () => {
      await service.ensureWeeklyPromptStarted(4);
      await service.ensureWeeklyPromptStarted(5);

      expect(alertService.sendMessage).toHaveBeenCalledTimes(2);
    });
  });

  describe('handleTextReply', () => {
    it('is a no-op when no prompt is pending', async () => {
      await service.handleTextReply('2');

      expect(alertService.sendMessage).not.toHaveBeenCalled();
    });

    it('is a no-op (ignores stray text) when the pending step is a chip step, not free_transfers', async () => {
      await service.ensureWeeklyPromptStarted(4);
      await service.handleTextReply('2'); // advances to the first chip step
      alertService.sendYesNoPrompt.mockClear();
      alertService.sendMessage.mockClear();

      await service.handleTextReply('hello');

      expect(alertService.sendMessage).not.toHaveBeenCalled();
      expect(alertService.sendYesNoPrompt).not.toHaveBeenCalled();
    });

    it('re-prompts without advancing on non-numeric input', async () => {
      await service.ensureWeeklyPromptStarted(4);
      alertService.sendMessage.mockClear();

      await service.handleTextReply('not-a-number');

      expect(alertService.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining('0 to 5'),
      );
      expect(await service.isFreshFor(4)).toBe(false);
      expect(alertService.sendYesNoPrompt).not.toHaveBeenCalled();
    });

    it('re-prompts without advancing on out-of-range input', async () => {
      await service.ensureWeeklyPromptStarted(4);

      await service.handleTextReply('9');

      expect(alertService.sendYesNoPrompt).not.toHaveBeenCalled();
    });

    it('advances to the first-half chip steps for a gameweek at/before GW19', async () => {
      await service.ensureWeeklyPromptStarted(19);

      await service.handleTextReply('1');

      expect(alertService.sendYesNoPrompt).toHaveBeenCalledWith(
        expect.any(String),
        'chipavail:19:wildcard1',
      );
    });

    it('skips the first-half chip steps and jumps straight to wildcard2 at GW20', async () => {
      await service.ensureWeeklyPromptStarted(20);

      await service.handleTextReply('1');

      expect(alertService.sendYesNoPrompt).toHaveBeenCalledWith(
        expect.any(String),
        'chipavail:20:wildcard2',
      );
    });
  });

  describe('handleChipReply', () => {
    it('flips the chip flag to unavailable on "no" and advances to the next step', async () => {
      await service.ensureWeeklyPromptStarted(4);
      await service.handleTextReply('1'); // -> wildcard1

      await service.handleChipReply(4, 'wildcard1', 'no');

      expect(alertService.sendYesNoPrompt).toHaveBeenCalledWith(
        expect.any(String),
        'chipavail:4:freeHit1',
      );
    });

    it('skips a chip already marked unavailable in a later sequence', async () => {
      await service.ensureWeeklyPromptStarted(4);
      await service.handleTextReply('1'); // -> wildcard1
      await service.handleChipReply(4, 'wildcard1', 'no');
      await service.handleChipReply(4, 'freeHit1', 'yes');
      await service.handleChipReply(4, 'benchBoost1', 'yes');
      await service.handleChipReply(4, 'tripleCaptain1', 'yes'); // sequence complete for gw4

      // Next gameweek's sequence should skip wildcard1 (already unavailable).
      alertService.sendYesNoPrompt.mockClear();
      await service.ensureWeeklyPromptStarted(5);
      await service.handleTextReply('1');

      expect(alertService.sendYesNoPrompt).toHaveBeenCalledWith(
        expect.any(String),
        'chipavail:5:freeHit1',
      );
    });

    it('throws when the gameweek/step does not match what is currently pending', async () => {
      await service.ensureWeeklyPromptStarted(4);
      await service.handleTextReply('1'); // -> wildcard1

      await expect(
        service.handleChipReply(4, 'freeHit1', 'yes'),
      ).rejects.toThrow();
      await expect(
        service.handleChipReply(5, 'wildcard1', 'yes'),
      ).rejects.toThrow();
    });

    it('clears the pending step and sends a completion message once the sequence is done', async () => {
      await completeGw4Sequence();

      expect(alertService.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining('generating GW4'),
      );
      expect(await service.isFreshFor(4)).toBe(true);
    });

    it('generates and sends the proposal immediately once the sequence completes', async () => {
      await completeGw4Sequence('2');

      expect(proposalService.generateProposal).toHaveBeenCalledWith(2);
      expect(alertService.sendProposal).toHaveBeenCalledWith(proposal, [], []);
    });

    it('does not generate a proposal if one already exists for the gameweek', async () => {
      proposalService.findByGameweekId.mockResolvedValue(proposal);

      await completeGw4Sequence();

      expect(proposalService.generateProposal).not.toHaveBeenCalled();
      expect(alertService.sendProposal).not.toHaveBeenCalled();
    });

    it('logs rather than throws when generation fails after completion', async () => {
      proposalService.generateProposal.mockRejectedValue(new Error('boom'));

      await expect(completeGw4Sequence()).resolves.toBeUndefined();
      expect(alertService.sendProposal).not.toHaveBeenCalled();
    });
  });

  describe('getFreeTransfers', () => {
    it('throws when not fresh for the requested gameweek', async () => {
      await expect(service.getFreeTransfers(4)).rejects.toThrow();
    });

    it('returns the confirmed value once the full sequence is answered', async () => {
      await service.ensureWeeklyPromptStarted(4);
      await service.handleTextReply('3');
      await service.handleChipReply(4, 'wildcard1', 'yes');
      await service.handleChipReply(4, 'freeHit1', 'yes');
      await service.handleChipReply(4, 'benchBoost1', 'yes');
      await service.handleChipReply(4, 'tripleCaptain1', 'yes');

      expect(await service.getFreeTransfers(4)).toBe(3);
    });
  });
});
