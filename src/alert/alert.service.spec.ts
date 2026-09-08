import { Test, TestingModule } from '@nestjs/testing';
import { AlertService } from './alert.service';
import { TelegramAdapter } from './adapters/telegram.adapter';
import { Player, PlayerSnapshot, Proposal } from '../common/types/domain.types';
import { ProposalStatus } from '../common/enums/proposal-status.enum';
import { Position } from '../common/enums/position.enum';
import { FplChip } from '../common/enums/chip.enum';

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

  it('delegates sendMessage to the telegram adapter', async () => {
    await service.sendMessage('hello');

    expect(telegram.sendMessage).toHaveBeenCalledWith('hello');
  });

  describe('sendAppliedCheckIn', () => {
    it('summarizes a no-op proposal', async () => {
      await service.sendAppliedCheckIn(proposal);

      const [text, proposalId] = telegram.sendAppliedCheckIn.mock
        .calls[0] as [string, string];
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
      expect(text).toContain('The proposal was: 2 transfers + wildcard.');
    });
  });
});
