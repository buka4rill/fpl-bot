import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ExecutionService } from './execution.service';
import { FplAuthClient } from '../auth/clients/fpl-auth.client';
import { FplPick } from '../auth/clients/fpl-auth.types';
import { ExecutionLog, Proposal } from '../common/types/domain.types';
import { ProposalStatus } from '../common/enums/proposal-status.enum';
import { FplChip } from '../common/enums/chip.enum';
import { ExecutionLogEntity } from '../persistence/entities/execution-log.entity';
import { IngestionService } from '../ingestion/ingestion.service';

describe('ExecutionService', () => {
  let service: ExecutionService;
  let fplAuthClient: {
    getMyTeam: jest.Mock;
    setLineup: jest.Mock;
    submitTransfers: jest.Mock;
  };
  let ingestionService: { getBootstrapSnapshot: jest.Mock };
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
      submitTransfers: jest.fn().mockResolvedValue({}),
    };
    ingestionService = {
      getBootstrapSnapshot: jest.fn().mockResolvedValue({
        snapshots: [{ gameweekId: 4, playerId: 99, price: 7.5 }],
      }),
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
        { provide: IngestionService, useValue: ingestionService },
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
      null,
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

  it('submits transfers via /api/transfers/, then sets the resulting lineup', async () => {
    // Post-transfer squad: player 15 sold, player 99 bought.
    const postTransferPicks = currentPicks.map((p) =>
      p.element === 15 ? pick(99) : p,
    );
    fplAuthClient.getMyTeam
      .mockResolvedValueOnce({ picks: currentPicks }) // pre-transfer (selling price lookup)
      .mockResolvedValueOnce({ picks: postTransferPicks }); // post-transfer (lineup build)

    const proposal = baseProposal({
      transfers: [{ playerOutId: 15, playerInId: 99 }],
      benchOutfieldIds: [13, 14, 99],
    });
    const log = await service.apply(proposal);

    expect(fplAuthClient.submitTransfers).toHaveBeenCalledWith(
      6909032,
      4,
      [
        {
          element_out: 15,
          element_in: 99,
          selling_price: 50,
          purchase_price: 75,
        },
      ],
      { wildcard: false, freehit: false },
    );
    expect(fplAuthClient.setLineup).toHaveBeenCalledWith(
      6909032,
      expect.arrayContaining([expect.objectContaining({ element: 99 })]),
      null,
    );
    expect(log.success).toBe(true);
  });

  it('activates Bench Boost via the my-team chip field, no transfers call', async () => {
    const log = await service.apply(
      baseProposal({ chip: FplChip.BENCH_BOOST }),
    );

    expect(fplAuthClient.submitTransfers).not.toHaveBeenCalled();
    expect(fplAuthClient.setLineup).toHaveBeenCalledWith(
      6909032,
      expect.any(Array),
      FplChip.BENCH_BOOST,
    );
    expect(log.success).toBe(true);
  });

  it('activates Wildcard via /api/transfers/, even with no actual transfers', async () => {
    await service.apply(baseProposal({ chip: FplChip.WILDCARD }));

    expect(fplAuthClient.submitTransfers).toHaveBeenCalledWith(6909032, 4, [], {
      wildcard: true,
      freehit: false,
    });
    // Wildcard rides the transfers endpoint, not the my-team chip field.
    expect(fplAuthClient.setLineup).toHaveBeenCalledWith(
      6909032,
      expect.any(Array),
      null,
    );
  });

  it('aborts before touching lineup when transfer validation fails', async () => {
    fplAuthClient.submitTransfers.mockRejectedValue(
      new Error('Transfer validation failed: budget exceeded'),
    );

    await expect(
      service.apply(
        baseProposal({ transfers: [{ playerOutId: 15, playerInId: 99 }] }),
      ),
    ).rejects.toThrow('Transfer submission failed');
    expect(fplAuthClient.setLineup).not.toHaveBeenCalled();
  });

  it('reports a partial failure plainly when transfers apply but the lineup call fails', async () => {
    fplAuthClient.setLineup.mockRejectedValue(new Error('FPL API 500'));

    await expect(
      service.apply(
        baseProposal({ transfers: [{ playerOutId: 15, playerInId: 99 }] }),
      ),
    ).rejects.toThrow('Transfers were applied');
    expect(executionLogRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        responsePayload: {
          transfersResult: {},
          lineupResult: { error: 'Error: FPL API 500' },
        },
      }),
    );
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
