import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ExecutionService } from './execution.service';
import { FplAuthClient } from './clients/fpl-auth.client';
import { FplPick } from './clients/fpl-auth.types';
import { ExecutionLog, Proposal } from '../common/types/domain.types';
import { ProposalStatus } from '../common/enums/proposal-status.enum';
import { FplChip } from '../common/enums/chip.enum';
import { ExecutionLogEntity } from '../persistence/entities/execution-log.entity';

describe('ExecutionService', () => {
  let service: ExecutionService;
  let fplAuthClient: { getMyTeam: jest.Mock; setLineup: jest.Mock };
  let executionLogRepository: { create: jest.Mock; save: jest.Mock };

  const pick = (
    element: number,
    overrides: Partial<FplPick> = {},
  ): FplPick => ({
    element,
    position: element,
    multiplier: element <= 11 ? 1 : 0,
    is_captain: false,
    is_vice_captain: false,
    element_type: 3,
    selling_price: 50,
    purchase_price: 50,
    ...overrides,
  });

  const currentPicks: FplPick[] = Array.from({ length: 15 }, (_, i) =>
    pick(i + 1),
  );

  const baseProposal = (overrides: Partial<Proposal> = {}): Proposal => ({
    id: 'p1',
    gameweekId: 4,
    deadlineAt: '2099-01-01T00:00:00Z', // far future — not overdue
    transfers: [],
    lineup: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    benchGoalkeeperId: 12,
    benchOutfieldIds: [13, 14, 15],
    captainId: 1,
    viceCaptainId: 2,
    expectedGain: 10,
    hitCost: 0,
    status: ProposalStatus.APPROVED,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  });

  beforeEach(async () => {
    fplAuthClient = {
      getMyTeam: jest.fn().mockResolvedValue({
        picks: currentPicks,
        picks_last_updated: '',
        chips: [],
        transfers: {},
      }),
      setLineup: jest.fn().mockResolvedValue({ picks: currentPicks }),
    };
    executionLogRepository = {
      create: jest.fn((log: ExecutionLog) => log),
      save: jest.fn().mockImplementation((log) => Promise.resolve(log)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExecutionService,
        { provide: FplAuthClient, useValue: fplAuthClient },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue('6909032') },
        },
        {
          provide: getRepositoryToken(ExecutionLogEntity),
          useValue: executionLogRepository,
        },
      ],
    }).compile();

    service = module.get<ExecutionService>(ExecutionService);
  });

  it('applies the proposal as position/multiplier/captaincy changes only', async () => {
    const log = await service.apply(baseProposal());

    expect(fplAuthClient.setLineup).toHaveBeenCalledWith(
      6909032,
      expect.arrayContaining([
        expect.objectContaining({
          element: 1,
          is_captain: true,
          multiplier: 2,
          position: 1,
        }),
        expect.objectContaining({
          element: 2,
          is_vice_captain: true,
          multiplier: 1,
          position: 2,
        }),
        expect.objectContaining({ element: 12, multiplier: 0, position: 12 }),
      ]),
    );
    expect(log.success).toBe(true);
    expect(log.proposalId).toBe('p1');
    expect(executionLogRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({ proposalId: 'p1', success: true }),
    );
  });

  it('refuses to execute once the deadline has passed', async () => {
    await expect(
      service.apply(baseProposal({ deadlineAt: '2000-01-01T00:00:00Z' })),
    ).rejects.toThrow('Deadline');
    expect(fplAuthClient.setLineup).not.toHaveBeenCalled();
  });

  it('refuses proposals that include transfers', async () => {
    await expect(
      service.apply(
        baseProposal({ transfers: [{ playerOutId: 1, playerInId: 99 }] }),
      ),
    ).rejects.toThrow('transfers');
    expect(fplAuthClient.setLineup).not.toHaveBeenCalled();
  });

  it('refuses proposals that play a chip', async () => {
    await expect(
      service.apply(baseProposal({ chip: FplChip.WILDCARD })),
    ).rejects.toThrow('chip');
    expect(fplAuthClient.setLineup).not.toHaveBeenCalled();
  });

  it('throws if the proposal does not account for every owned player', async () => {
    await expect(
      service.apply(baseProposal({ benchOutfieldIds: [13, 14] })), // drops element 15
    ).rejects.toThrow('15');
  });

  it('records a failed execution log instead of silently swallowing the error', async () => {
    fplAuthClient.setLineup.mockRejectedValue(new Error('FPL API 500'));

    await expect(service.apply(baseProposal())).rejects.toThrow(
      'Execution failed',
    );
  });
});
