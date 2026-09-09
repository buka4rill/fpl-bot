import { Test, TestingModule } from '@nestjs/testing';
import { NarrativeService } from './narrative.service';
import { IngestionService } from '../ingestion/ingestion.service';
import { AnthropicClient } from './clients/anthropic.client';
import { Player, PlayerSnapshot, Proposal } from '../common/types/domain.types';
import { Position } from '../common/enums/position.enum';
import { ProposalStatus } from '../common/enums/proposal-status.enum';
import { TriggerSource } from '../common/enums/trigger-source.enum';
import { FplChip } from '../common/enums/chip.enum';

// Mirrors the shape NarrativeService serializes into the LLM prompt —
// typed here purely so these tests can assert on it without unsafe `any`
// access, not exported from the service itself.
interface PlayerFacts {
  name: string;
  fixtureDifficulty: number | null;
  recentForm: {
    xgPer90: number;
    xaPer90: number;
    defensiveContributionPer90: number;
  } | null;
}

interface FactsPayload {
  gameweekId: number;
  chip: string | null;
  transfers: {
    out: PlayerFacts | null;
    in: PlayerFacts | null;
  }[];
  captain: PlayerFacts | null;
}

describe('NarrativeService', () => {
  let service: NarrativeService;
  let ingestionService: { getRecentForm: jest.Mock };
  let anthropicClient: { generateText: jest.Mock };

  const players: Player[] = [
    {
      id: 2,
      webName: 'Saka',
      fullName: 'Bukayo Saka',
      teamId: 1,
      position: Position.MID,
    },
    {
      id: 7,
      webName: 'Palmer',
      fullName: 'Cole Palmer',
      teamId: 6,
      position: Position.MID,
    },
    {
      id: 4,
      webName: 'Haaland',
      fullName: 'Erling Haaland',
      teamId: 3,
      position: Position.FWD,
    },
  ];

  const snapshots: PlayerSnapshot[] = [
    {
      gameweekId: 4,
      playerId: 2,
      price: 10.1,
      ownershipPct: 40,
      nextFixtureDifficulty: 5,
    },
    {
      gameweekId: 4,
      playerId: 7,
      price: 10.8,
      ownershipPct: 30,
      nextFixtureDifficulty: 2,
    },
    {
      gameweekId: 4,
      playerId: 4,
      price: 15.2,
      ownershipPct: 60,
      nextFixtureDifficulty: 3,
    },
  ];

  const proposal: Proposal = {
    id: 'prop-1',
    gameweekId: 4,
    season: '26_27',
    deadlineAt: '2026-09-12T12:30:00Z',
    transfers: [{ playerOutId: 2, playerInId: 7 }],
    lineup: [7, 4],
    benchGoalkeeperId: 1,
    benchOutfieldIds: [],
    captainId: 4,
    viceCaptainId: 7,
    expectedGain: 55.4,
    hitCost: 0,
    status: ProposalStatus.PENDING,
    createdAt: '2026-09-05T00:00:00Z',
    source: TriggerSource.AUTO,
  };

  const recentForm = (
    playerId: number,
    xgPer90: number,
    xaPer90: number,
    defensiveContributionPer90 = 0,
  ) => ({
    playerId,
    matchesConsidered: 4,
    minutesConsidered: 360,
    xgPer90,
    xaPer90,
    defensiveContributionPer90,
  });

  beforeEach(async () => {
    ingestionService = { getRecentForm: jest.fn() };
    anthropicClient = { generateText: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NarrativeService,
        { provide: IngestionService, useValue: ingestionService },
        { provide: AnthropicClient, useValue: anthropicClient },
      ],
    }).compile();

    service = module.get<NarrativeService>(NarrativeService);
  });

  it('fetches recent form for every transfer + captain player and returns the LLM text', async () => {
    ingestionService.getRecentForm.mockImplementation((id: number) => {
      if (id === 2) return Promise.resolve(recentForm(2, 0.52, 0.1));
      if (id === 7) return Promise.resolve(recentForm(7, 0.7, 0.18));
      if (id === 4) return Promise.resolve(recentForm(4, 0.9, 0.05));
      throw new Error(`unexpected id ${id}`);
    });
    anthropicClient.generateText.mockResolvedValue(
      'Palmer beats Saka on form.',
    );

    const result = await service.buildRationale(proposal, players, snapshots);

    expect(result).toBe('Palmer beats Saka on form.');
    expect(ingestionService.getRecentForm).toHaveBeenCalledTimes(3);
    expect(ingestionService.getRecentForm).toHaveBeenCalledWith(2);
    expect(ingestionService.getRecentForm).toHaveBeenCalledWith(7);
    expect(ingestionService.getRecentForm).toHaveBeenCalledWith(4);
  });

  it('sends the facts payload as grounded JSON, not free text', async () => {
    ingestionService.getRecentForm.mockImplementation((id: number) =>
      Promise.resolve(recentForm(id, 0.5, 0.1, 6)),
    );
    anthropicClient.generateText.mockResolvedValue('some rationale');

    await service.buildRationale(proposal, players, snapshots);

    const [, userPrompt] = anthropicClient.generateText.mock.calls[0] as [
      string,
      string,
    ];
    const facts = JSON.parse(userPrompt) as FactsPayload;

    expect(facts.gameweekId).toBe(4);
    expect(facts.transfers[0].out?.name).toBe('Saka');
    expect(facts.transfers[0].out?.fixtureDifficulty).toBe(5);
    expect(facts.transfers[0].in?.name).toBe('Palmer');
    expect(facts.transfers[0].in?.fixtureDifficulty).toBe(2);
    expect(facts.transfers[0].in?.recentForm?.defensiveContributionPer90).toBe(
      6,
    );
    expect(facts.captain?.name).toBe('Haaland');
  });

  it('still fetches the captain and calls the LLM when a proposal has no transfers', async () => {
    ingestionService.getRecentForm.mockImplementation((id: number) =>
      Promise.resolve(recentForm(id, 0.9, 0.05)),
    );
    anthropicClient.generateText.mockResolvedValue('Haaland stays captain.');

    const result = await service.buildRationale(
      { ...proposal, transfers: [] },
      players,
      snapshots,
    );

    expect(result).toBe('Haaland stays captain.');
    expect(ingestionService.getRecentForm).toHaveBeenCalledTimes(1);
    expect(ingestionService.getRecentForm).toHaveBeenCalledWith(4);
  });

  it('still calls the LLM with null recentForm for every player when IngestionService fails entirely', async () => {
    // Fixture difficulty/ownership/chip are still real, useful facts even
    // with no recent-form data at all — dropping the whole rationale here
    // would throw away information that's still worth narrating.
    ingestionService.getRecentForm.mockRejectedValue(new Error('FPL API down'));
    anthropicClient.generateText.mockResolvedValue(
      'rationale without form data',
    );

    const result = await service.buildRationale(proposal, players, snapshots);

    expect(result).toBe('rationale without form data');
    const [, userPrompt] = anthropicClient.generateText.mock.calls[0] as [
      string,
      string,
    ];
    const facts = JSON.parse(userPrompt) as FactsPayload;
    expect(facts.captain?.recentForm).toBeNull();
    expect(facts.captain?.fixtureDifficulty).toBe(3);
  });

  it("keeps other players correctly populated when only one player's recentForm fetch fails", async () => {
    ingestionService.getRecentForm.mockImplementation((id: number) => {
      if (id === 7) return Promise.reject(new Error('one bad player'));
      return Promise.resolve(recentForm(id, 0.5, 0.1, 3));
    });
    anthropicClient.generateText.mockResolvedValue('rationale');

    await service.buildRationale(proposal, players, snapshots);

    const [, userPrompt] = anthropicClient.generateText.mock.calls[0] as [
      string,
      string,
    ];
    const facts = JSON.parse(userPrompt) as FactsPayload;
    // Palmer (id 7) failed — null, but Saka/Haaland are unaffected.
    expect(facts.transfers[0].in?.name).toBe('Palmer');
    expect(facts.transfers[0].in?.recentForm).toBeNull();
    expect(facts.transfers[0].out?.name).toBe('Saka');
    expect(facts.transfers[0].out?.recentForm?.xgPer90).toBeCloseTo(0.5, 5);
    expect(facts.captain?.name).toBe('Haaland');
    expect(facts.captain?.recentForm?.xgPer90).toBeCloseTo(0.5, 5);
  });

  it('returns undefined and never throws when the LLM call fails', async () => {
    ingestionService.getRecentForm.mockImplementation((id: number) =>
      Promise.resolve(recentForm(id, 0.5, 0.1)),
    );
    anthropicClient.generateText.mockRejectedValue(new Error('anthropic down'));

    const result = await service.buildRationale(proposal, players, snapshots);

    expect(result).toBeUndefined();
  });

  it('includes the chip in the facts payload when the proposal declares one', async () => {
    ingestionService.getRecentForm.mockImplementation((id: number) =>
      Promise.resolve(recentForm(id, 0.5, 0.1)),
    );
    anthropicClient.generateText.mockResolvedValue('rationale');

    await service.buildRationale(
      { ...proposal, chip: FplChip.BENCH_BOOST },
      players,
      snapshots,
    );

    const [, userPrompt] = anthropicClient.generateText.mock.calls[0] as [
      string,
      string,
    ];
    expect((JSON.parse(userPrompt) as FactsPayload).chip).toBe(
      FplChip.BENCH_BOOST,
    );
  });
});
