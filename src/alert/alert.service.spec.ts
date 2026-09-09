import { Test, TestingModule } from '@nestjs/testing';
import { AlertService } from './alert.service';
import { TelegramAdapter } from './adapters/telegram.adapter';
import { Player, PlayerSnapshot, Proposal } from '../common/types/domain.types';
import { ProposalStatus } from '../common/enums/proposal-status.enum';
import { Position } from '../common/enums/position.enum';
import { FplChip } from '../common/enums/chip.enum';
import { TriggerSource } from '../common/enums/trigger-source.enum';

describe('AlertService', () => {
  let service: AlertService;
  let telegram: {
    sendProposalAlert: jest.Mock;
    sendMessage: jest.Mock;
    sendAppliedCheckIn: jest.Mock;
  };

  const players: Player[] = [
    {
      id: 1,
      webName: 'Raya',
      fullName: 'David Raya',
      teamId: 1,
      position: Position.GKP,
    },
    {
      id: 2,
      webName: 'Saka',
      fullName: 'Bukayo Saka',
      teamId: 1,
      position: Position.MID,
    },
    {
      id: 3,
      webName: 'Isak',
      fullName: 'Alexander Isak',
      teamId: 2,
      position: Position.FWD,
    },
    {
      id: 4,
      webName: 'Haaland',
      fullName: 'Erling Haaland',
      teamId: 3,
      position: Position.FWD,
    },
    {
      id: 5,
      webName: 'Turner',
      fullName: 'Matt Turner',
      teamId: 4,
      position: Position.GKP,
    },
    {
      id: 6,
      webName: 'Bednarek',
      fullName: 'Jan Bednarek',
      teamId: 5,
      position: Position.DEF,
    },
  ];

  const snapshots: PlayerSnapshot[] = [
    { gameweekId: 4, playerId: 1, price: 5.0, ownershipPct: 10 },
    { gameweekId: 4, playerId: 2, price: 10.0, ownershipPct: 50 },
    { gameweekId: 4, playerId: 3, price: 8.5, ownershipPct: 20 },
    { gameweekId: 4, playerId: 4, price: 15.2, ownershipPct: 60 },
    { gameweekId: 4, playerId: 5, price: 4.0, ownershipPct: 1 },
  ];

  const proposal: Proposal = {
    id: 'prop-1',
    gameweekId: 4,
    season: '26_27',
    deadlineAt: '2026-09-12T12:30:00Z',
    transfers: [],
    lineup: [1, 2],
    benchGoalkeeperId: 5,
    benchOutfieldIds: [],
    captainId: 2,
    viceCaptainId: 1,
    expectedGain: 42.5,
    hitCost: 0,
    status: ProposalStatus.PENDING,
    createdAt: '2026-09-05T00:00:00Z',
    source: TriggerSource.AUTO,
  };

  beforeEach(async () => {
    telegram = {
      sendProposalAlert: jest.fn(),
      sendMessage: jest.fn(),
      sendAppliedCheckIn: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AlertService,
        { provide: TelegramAdapter, useValue: telegram },
      ],
    }).compile();

    service = module.get<AlertService>(AlertService);
  });

  it('renders player names and sends via the telegram adapter', async () => {
    await service.sendProposal(proposal, players, snapshots);

    expect(telegram.sendProposalAlert).toHaveBeenCalledTimes(1);
    const [text, proposalId] = telegram.sendProposalAlert.mock.calls[0] as [
      string,
      string,
    ];

    expect(proposalId).toBe('prop-1');
    expect(text).toContain('GW4 Proposal');
    expect(text).toContain('⚽ Starting XI: Raya (GKP), Saka (MID)');
    expect(text).toContain('👑 Captain: Saka (VC: Raya)');
    expect(text).toContain('🪑 Bench: Turner');
    expect(text).toContain('📊 Predicted Points: 42.5 xP');
    expect(text).toContain('✅ No transfers — squad unchanged');
    expect(text).not.toContain('💸 Hit');
  });

  it('tells the adapter there is no chip-free alternative by default', async () => {
    await service.sendProposal(proposal, players, snapshots);

    expect(telegram.sendProposalAlert).toHaveBeenCalledWith(
      expect.any(String),
      'prop-1',
      false,
    );
  });

  it('tells the adapter a chip-free alternative exists', async () => {
    await service.sendProposal(
      {
        ...proposal,
        chip: FplChip.WILDCARD,
        noChipAlternative: {
          transfers: [],
          lineup: [1, 2],
          benchGoalkeeperId: 5,
          benchOutfieldIds: [],
          captainId: 2,
          viceCaptainId: 1,
          expectedGain: 40,
          hitCost: 0,
        },
      },
      players,
      snapshots,
    );

    expect(telegram.sendProposalAlert).toHaveBeenCalledWith(
      expect.any(String),
      'prop-1',
      true,
    );
  });

  it('orders the Starting XI GKP -> DEF -> MID -> FWD regardless of input order', async () => {
    await service.sendProposal(
      // Deliberately scrambled: FWD, MID, GKP, DEF.
      { ...proposal, lineup: [4, 2, 1, 6] },
      players,
      snapshots,
    );

    const [text] = telegram.sendProposalAlert.mock.calls[0] as [string];
    expect(text).toContain(
      '⚽ Starting XI: Raya (GKP), Bednarek (DEF), Saka (MID), Haaland (FWD)',
    );
  });

  it('renders each transfer with player names and prices', async () => {
    await service.sendProposal(
      {
        ...proposal,
        transfers: [{ playerOutId: 3, playerInId: 4 }],
        hitCost: 4,
      },
      players,
      snapshots,
    );

    const [text] = telegram.sendProposalAlert.mock.calls[0] as [string];
    expect(text).toContain('🔄 Selling Isak (£8.5m) ➔ Buying Haaland (£15.2m)');
    expect(text).toContain('💸 Hit: -4 pts');
  });

  it('shows a zero-hit line for transfers made within the free allowance', async () => {
    await service.sendProposal(
      {
        ...proposal,
        transfers: [{ playerOutId: 3, playerInId: 4 }],
        hitCost: 0,
      },
      players,
      snapshots,
    );

    const [text] = telegram.sendProposalAlert.mock.calls[0] as [string];
    expect(text).toContain('✅ Hit: 0 pts (within free transfers)');
  });

  it('lists multiple bench players comma-separated', async () => {
    await service.sendProposal(
      { ...proposal, benchOutfieldIds: [3, 4] },
      players,
      snapshots,
    );

    const [text] = telegram.sendProposalAlert.mock.calls[0] as [string];
    expect(text).toContain('🪑 Bench: Turner, Isak, Haaland');
  });

  it('falls back to a player id when the player is not found', async () => {
    await service.sendProposal(
      { ...proposal, captainId: 999 },
      players,
      snapshots,
    );

    const [text] = telegram.sendProposalAlert.mock.calls[0] as [string];
    expect(text).toContain('#999');
  });

  it('falls back to just the name when no price snapshot is found', async () => {
    await service.sendProposal(proposal, players, []);

    const [text] = telegram.sendProposalAlert.mock.calls[0] as [string];
    expect(text).toContain('🪑 Bench: Turner');
    expect(text).not.toContain('£');
  });

  it('shows which chip is being played, up front', async () => {
    await service.sendProposal(
      { ...proposal, chip: FplChip.BENCH_BOOST },
      players,
      snapshots,
    );

    const [text] = telegram.sendProposalAlert.mock.calls[0] as [string];
    expect(text).toContain('🃏 Chip: Bench Boost');
    // Before the transfer/lineup section, not buried at the bottom —
    // regression test for the live incident where an owner approved a
    // Bench Boost proposal without the message ever mentioning it.
    expect(text.indexOf('🃏 Chip:')).toBeLessThan(text.indexOf('No transfers'));
  });

  it('says nothing about a chip when none is being played', async () => {
    await service.sendProposal(proposal, players, snapshots);

    const [text] = telegram.sendProposalAlert.mock.calls[0] as [string];
    expect(text).not.toContain('🃏');
  });

  it.each([
    [FplChip.WILDCARD, 'Wildcard'],
    [FplChip.FREE_HIT, 'Free Hit'],
    [FplChip.BENCH_BOOST, 'Bench Boost'],
    [FplChip.TRIPLE_CAPTAIN, 'Triple Captain'],
  ])('renders a human-readable label for %s', async (chip, label) => {
    await service.sendProposal({ ...proposal, chip }, players, snapshots);

    const [text] = telegram.sendProposalAlert.mock.calls[0] as [string];
    expect(text).toContain(`🃏 Chip: ${label}`);
  });

  it('shows what was considered when multiple candidates were compared', async () => {
    await service.sendProposal(
      { ...proposal, chip: FplChip.WILDCARD },
      players,
      snapshots,
      [
        { chip: undefined, optimization: {} as never, netExpectedPoints: 60 },
        {
          chip: FplChip.WILDCARD,
          optimization: {} as never,
          netExpectedPoints: 65.4,
        },
      ],
    );

    const [text] = telegram.sendProposalAlert.mock.calls[0] as [string];
    expect(text).toContain(
      '📊 Considered: No chip +60.0 · Wildcard +65.4 → picked Wildcard',
    );
  });

  it('says nothing about candidates when only one (or none) was given', async () => {
    await service.sendProposal(proposal, players, snapshots, [
      { chip: undefined, optimization: {} as never, netExpectedPoints: 60 },
    ]);

    const [text] = telegram.sendProposalAlert.mock.calls[0] as [string];
    expect(text).not.toContain('📊 Considered');
  });

  it('delegates sendMessage to the telegram adapter', async () => {
    await service.sendMessage('hello');

    expect(telegram.sendMessage).toHaveBeenCalledWith('hello');
  });

  describe('sendAppliedCheckIn', () => {
    it('summarizes a no-op proposal', async () => {
      await service.sendAppliedCheckIn(proposal);

      const [text, proposalId] = telegram.sendAppliedCheckIn.mock.calls[0] as [
        string,
        string,
      ];
      expect(proposalId).toBe('prop-1');
      expect(text).toContain('GW4');
      expect(text).toContain('The proposal was: no changes.');
    });

    it('summarizes transfers', async () => {
      await service.sendAppliedCheckIn({
        ...proposal,
        transfers: [{ playerOutId: 3, playerInId: 4 }],
      });

      const [text] = telegram.sendAppliedCheckIn.mock.calls[0] as [string];
      expect(text).toContain('The proposal was: 1 transfer.');
    });

    it('summarizes multiple transfers plus a chip', async () => {
      await service.sendAppliedCheckIn({
        ...proposal,
        transfers: [
          { playerOutId: 3, playerInId: 4 },
          { playerOutId: 5, playerInId: 6 },
        ],
        chip: FplChip.WILDCARD,
      });

      const [text] = telegram.sendAppliedCheckIn.mock.calls[0] as [string];
      expect(text).toContain('The proposal was: 2 transfers + Wildcard.');
    });
  });

  describe('sendExecutionResult', () => {
    it('describes what was actually applied for a transfer proposal', async () => {
      await service.sendExecutionResult(
        { ...proposal, transfers: [{ playerOutId: 3, playerInId: 4 }] },
        true,
      );

      expect(telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining('✅ *GW4 applied* — 1 transfer now live'),
      );
    });

    it('describes what was actually applied for a chip proposal', async () => {
      // Regression test for the live incident where a Bench Boost execution
      // reported "captain/lineup changes are live" — not what happened.
      await service.sendExecutionResult(
        { ...proposal, chip: FplChip.BENCH_BOOST },
        true,
      );

      expect(telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining('✅ *GW4 applied* — Bench Boost now live'),
      );
    });

    it('falls back to "lineup/captain changes" when there are no transfers or chip', async () => {
      // e.g. a captain-swap proposal — setLineup is still called, so this
      // fallback stays accurate even with nothing else to report.
      await service.sendExecutionResult(proposal, true);

      expect(telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining(
          '✅ *GW4 applied* — lineup/captain changes now live',
        ),
      );
    });

    it('reports failure loudly with the error detail', async () => {
      await service.sendExecutionResult(proposal, false, 'FPL API down');

      expect(telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining('🚨 *GW4 execution FAILED*'),
      );
      expect(telegram.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining('FPL API down'),
      );
    });
  });

  describe('sendResultReport', () => {
    it('reports the predicted and actual scores', async () => {
      await service.sendResultReport(proposal, 52, 48);

      const [text] = telegram.sendMessage.mock.calls[0] as [string];
      expect(text).toContain('📊 *GW4 Result*');
      expect(text).toContain('My suggestion: 52 pts');
      expect(text).toContain('Your actual score: 48 pts');
    });

    it('shows the delta when the actual score fell short', async () => {
      await service.sendResultReport(proposal, 52, 48);

      const [text] = telegram.sendMessage.mock.calls[0] as [string];
      expect(text).toContain('📉 My suggestion would have scored 4 pts more');
    });

    it('shows the delta when the actual score beat the suggestion', async () => {
      await service.sendResultReport(proposal, 48, 52);

      const [text] = telegram.sendMessage.mock.calls[0] as [string];
      expect(text).toContain('✅ You beat my suggestion by 4 pts');
    });

    it('shows a neutral line when the scores match exactly', async () => {
      await service.sendResultReport(proposal, 50, 50);

      const [text] = telegram.sendMessage.mock.calls[0] as [string];
      expect(text).toContain('➖ Same either way');
    });

    it('uses singular "pt" for a delta of exactly 1', async () => {
      await service.sendResultReport(proposal, 50, 51);

      const [text] = telegram.sendMessage.mock.calls[0] as [string];
      // Deliberately anchored to end-of-line: "51 pts" (the actual score,
      // rendered elsewhere in the same message) also contains "1 pts" as a
      // substring, so a bare .not.toContain('1 pts') would be a false
      // negative here.
      expect(text).toMatch(/beat my suggestion by 1 pt$/m);
    });

    it('adds no context line for an APPROVED proposal', async () => {
      await service.sendResultReport(
        { ...proposal, status: ProposalStatus.APPROVED },
        50,
        50,
      );

      const [text] = telegram.sendMessage.mock.calls[0] as [string];
      expect(text).not.toContain('(');
    });

    it('notes a REJECTED proposal', async () => {
      await service.sendResultReport(
        { ...proposal, status: ProposalStatus.REJECTED },
        50,
        50,
      );

      const [text] = telegram.sendMessage.mock.calls[0] as [string];
      expect(text).toContain('(You rejected this proposal.)');
    });

    it('notes an EXPIRED proposal with no applied-manually answer yet', async () => {
      await service.sendResultReport(
        { ...proposal, status: ProposalStatus.EXPIRED, appliedManually: null },
        50,
        50,
      );

      const [text] = telegram.sendMessage.mock.calls[0] as [string];
      expect(text).toContain('(The deadline passed without a reply.)');
    });

    it('notes an EXPIRED proposal the owner said they applied anyway', async () => {
      await service.sendResultReport(
        {
          ...proposal,
          status: ProposalStatus.EXPIRED,
          appliedManually: true,
        },
        50,
        50,
      );

      const [text] = telegram.sendMessage.mock.calls[0] as [string];
      expect(text).toContain('(You told me you applied it anyway.)');
    });

    it('notes an EXPIRED proposal the owner said they did not apply', async () => {
      await service.sendResultReport(
        {
          ...proposal,
          status: ProposalStatus.EXPIRED,
          appliedManually: false,
        },
        50,
        50,
      );

      const [text] = telegram.sendMessage.mock.calls[0] as [string];
      expect(text).toContain("(You told me you didn't apply it.)");
    });
  });
});
