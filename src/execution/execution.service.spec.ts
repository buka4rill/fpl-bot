import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ExecutionService } from './execution.service';
import { FplAuthClient } from '../auth/clients/fpl-auth.client';
import { FplPick } from '../auth/clients/fpl-auth.types';
import { ExecutionLog, Proposal } from '../common/types/domain.types';
import { ProposalStatus } from '../common/enums/proposal-status.enum';
import { FplChip } from '../common/enums/chip.enum';
import { TriggerSource } from '../common/enums/trigger-source.enum';
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
  let configService: { get: jest.Mock };

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
    season: '26_27',
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
    source: TriggerSource.AUTO,
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
      setLineup: jest
        .fn()
        .mockResolvedValue({ picks: currentPicks, chips: [] }),
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
          useValue: (configService = {
            // Retry count/delay pinned to the pre-2026-09-09 defaults here so
            // the retry-specific tests below keep their exact call-count
            // assertions regardless of whatever the real production default
            // (config/configuration.ts) is tuned to. Overridden per-test
            // below where a different retry budget matters.
            get: jest.fn((key: string) => {
              if (key === 'fpl.teamId') return '6909032';
              if (key === 'execution.chipConfirmationRetries') return 3;
              if (key === 'execution.chipConfirmationRetryDelayMs') return 1;
              return undefined;
            }),
          }),
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
    fplAuthClient.setLineup.mockResolvedValue({
      picks: currentPicks,
      chips: [
        {
          name: 'bboost',
          status_for_entry: 'active',
          played_by_entry: [4],
        },
      ],
    });

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
    fplAuthClient.setLineup.mockResolvedValue({
      picks: currentPicks,
      chips: [
        {
          name: 'wildcard',
          status_for_entry: 'active',
          played_by_entry: [4],
        },
      ],
    });

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

  it('reports failure when a declared chip is still not confirmed after retrying (regression — 2026-09-08 Free Hit false positive)', async () => {
    // Mirrors what was actually observed live: submitTransfers/setLineup
    // both return cleanly (no thrown error), but the resulting my-team
    // state still shows the chip unavailable and never played — FPL
    // silently ignored the chip flag rather than rejecting the request.
    // getMyTeam keeps returning unconfirmed too, through every retry.
    jest.useFakeTimers();
    fplAuthClient.setLineup.mockResolvedValue({
      picks: currentPicks,
      chips: [
        {
          name: 'freehit',
          status_for_entry: 'unavailable',
          played_by_entry: [],
        },
      ],
    });

    const applyPromise = service.apply(
      baseProposal({ chip: FplChip.FREE_HIT }),
    );
    const assertion = expect(applyPromise).rejects.toThrow(
      'still hasn\'t confirmed the "freehit" chip as played',
    );
    await jest.runAllTimersAsync();
    await assertion;

    expect(executionLogRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({ success: false }),
    );
    // submitTransfers' own getMyTeam (Free Hit rides the transfer
    // endpoint) + apply()'s own (building picks) + one per retry.
    expect(fplAuthClient.getMyTeam).toHaveBeenCalledTimes(5);

    jest.useRealTimers();
  });

  it("retries and confirms success when a chip that lagged setLineup's own response shows up played on a later check (regression — 2026-09-08 Bench Boost false negative)", async () => {
    // Mirrors what was actually observed live: setLineup's own response
    // still showed the chip unplayed, but FPL's backend had genuinely
    // already applied it — a fresh getMyTeam call moments later correctly
    // showed it active. The retry must catch this rather than reporting a
    // false "execution FAILED" for something that actually succeeded.
    jest.useFakeTimers();
    fplAuthClient.setLineup.mockResolvedValue({
      picks: currentPicks,
      chips: [
        {
          name: 'bboost',
          status_for_entry: 'unavailable',
          played_by_entry: [],
        },
      ],
    });
    fplAuthClient.getMyTeam
      .mockResolvedValueOnce({
        picks: currentPicks,
        picks_last_updated: '',
        chips: [],
        transfers: {},
      }) // initial call in apply(), building picks — irrelevant here
      .mockResolvedValueOnce({
        picks: currentPicks,
        picks_last_updated: '',
        chips: [
          {
            name: 'bboost',
            status_for_entry: 'active',
            played_by_entry: [4],
          },
        ],
        transfers: {},
      }); // first retry — confirms it actually landed

    const applyPromise = service.apply(
      baseProposal({ chip: FplChip.BENCH_BOOST }),
    );
    await jest.runAllTimersAsync();
    const log = await applyPromise;

    expect(log.success).toBe(true);
    // Initial getMyTeam + exactly one retry, not all three.
    expect(fplAuthClient.getMyTeam).toHaveBeenCalledTimes(2);

    jest.useRealTimers();
  });

  it('confirms success on a retry beyond the old 3-retry budget (regression — 2026-09-09, two real Bench Boost plays this happened to live)', async () => {
    // The 2026-09-08 fix above only budgeted 3 retries (~6s) — confirmed
    // live twice on 2026-09-09 that FPL's propagation lag can genuinely
    // exceed that, producing a false "execution FAILED" for a chip that had
    // actually landed (the owner independently confirmed via /status and
    // the FPL app both times). Widening the retry budget only helps if the
    // code actually keeps retrying past what the old default allowed —
    // this proves that with a wider budget (6, standing in for the new
    // default of 8), a chip that only confirms on the 5th check (1 initial
    // + 4 retries — beyond the old budget's 1 + 3) still reports success.
    configService.get.mockImplementation((key: string) => {
      if (key === 'fpl.teamId') return '6909032';
      if (key === 'execution.chipConfirmationRetries') return 6;
      if (key === 'execution.chipConfirmationRetryDelayMs') return 1;
      return undefined;
    });
    jest.useFakeTimers();
    fplAuthClient.setLineup.mockResolvedValue({
      picks: currentPicks,
      chips: [
        {
          name: 'bboost',
          status_for_entry: 'unavailable',
          played_by_entry: [],
        },
      ],
    });
    const unconfirmed = {
      picks: currentPicks,
      picks_last_updated: '',
      chips: [
        {
          name: 'bboost',
          status_for_entry: 'unavailable',
          played_by_entry: [],
        },
      ],
      transfers: {},
    };
    const confirmed = {
      picks: currentPicks,
      picks_last_updated: '',
      chips: [
        {
          name: 'bboost',
          status_for_entry: 'active',
          played_by_entry: [4],
        },
      ],
      transfers: {},
    };
    fplAuthClient.getMyTeam
      .mockResolvedValueOnce(unconfirmed) // initial call in apply(), building picks
      .mockResolvedValueOnce(unconfirmed) // retry 1 — still not confirmed (old budget would have stopped after 3 of these)
      .mockResolvedValueOnce(unconfirmed) // retry 2
      .mockResolvedValueOnce(unconfirmed) // retry 3 — this is where the old 3-retry budget gave up
      .mockResolvedValueOnce(confirmed); // retry 4 — genuinely lands, beyond the old budget

    const applyPromise = service.apply(
      baseProposal({ chip: FplChip.BENCH_BOOST }),
    );
    await jest.runAllTimersAsync();
    const log = await applyPromise;

    expect(log.success).toBe(true);
    expect(fplAuthClient.getMyTeam).toHaveBeenCalledTimes(5);

    jest.useRealTimers();
  });

  it('confirms a chip via played_by_entry even if status_for_entry is not literally "active"', async () => {
    // The confirmed string values for team-type chips ('active') and
    // transfer-type chips (unobserved so far — see fpl-auth.types.ts) may
    // differ; played_by_entry including the target gameweek is the one
    // signal already confirmed live for a real chip activation, so that's
    // what's checked, not a specific status string.
    fplAuthClient.setLineup.mockResolvedValue({
      picks: currentPicks,
      chips: [
        {
          name: 'freehit',
          status_for_entry: 'played',
          played_by_entry: [4],
        },
      ],
    });

    const log = await service.apply(baseProposal({ chip: FplChip.FREE_HIT }));

    expect(log.success).toBe(true);
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
          chipConfirmationAttempts: [], // never reached — setLineup itself failed
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

  describe('getCurrentSquad', () => {
    it('derives playerIds, bank, and teamValue from the authenticated my-team response', async () => {
      fplAuthClient.getMyTeam.mockResolvedValue({
        picks: currentPicks,
        chips: [],
        transfers: { bank: 3, value: 997 },
      });

      const squad = await service.getCurrentSquad(6909032, 4);

      expect(squad).toEqual({
        teamId: 6909032,
        gameweekId: 4,
        playerIds: currentPicks.map((p) => p.element),
        bank: 0.3,
        teamValue: 99.7,
        activeChip: undefined,
      });
    });

    it('passes through the caller-supplied gameweekId, not one derived from the response', async () => {
      fplAuthClient.getMyTeam.mockResolvedValue({
        picks: currentPicks,
        chips: [],
        transfers: { bank: 0, value: 1000 },
      });

      const squad = await service.getCurrentSquad(6909032, 12);

      expect(squad.gameweekId).toBe(12);
    });

    it('derives activeChip from the chip whose status_for_entry is "active"', async () => {
      fplAuthClient.getMyTeam.mockResolvedValue({
        picks: currentPicks,
        chips: [
          { name: 'bboost', status_for_entry: 'unavailable' },
          { name: '3xc', status_for_entry: 'active' },
        ],
        transfers: { bank: 0, value: 1000 },
      });

      const squad = await service.getCurrentSquad(6909032, 4);

      expect(squad.activeChip).toBe(FplChip.TRIPLE_CAPTAIN);
    });

    it('leaves activeChip undefined when no chip is active', async () => {
      fplAuthClient.getMyTeam.mockResolvedValue({
        picks: currentPicks,
        chips: [
          { name: 'bboost', status_for_entry: 'available' },
          { name: '3xc', status_for_entry: 'unavailable' },
        ],
        transfers: { bank: 0, value: 1000 },
      });

      const squad = await service.getCurrentSquad(6909032, 4);

      expect(squad.activeChip).toBeUndefined();
    });
  });
});
