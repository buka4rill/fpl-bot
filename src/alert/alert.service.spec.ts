import { Test, TestingModule } from '@nestjs/testing';
import { AlertService } from './alert.service';
import { TelegramAdapter } from './adapters/telegram.adapter';
import { Player, Proposal } from '../common/types/domain.types';
import { ProposalStatus } from '../common/enums/proposal-status.enum';
import { Position } from '../common/enums/position.enum';

describe('AlertService', () => {
  let service: AlertService;
  let telegram: { sendProposalAlert: jest.Mock };

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
  ];

  const proposal: Proposal = {
    id: 'prop-1',
    gameweekId: 4,
    deadlineAt: '2026-09-12T12:30:00Z',
    transfers: [],
    lineup: [1, 2],
    captainId: 2,
    viceCaptainId: 1,
    expectedGain: 42.5,
    hitCost: 0,
    status: ProposalStatus.PENDING,
    createdAt: '2026-09-05T00:00:00Z',
  };

  beforeEach(async () => {
    telegram = { sendProposalAlert: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AlertService,
        { provide: TelegramAdapter, useValue: telegram },
      ],
    }).compile();

    service = module.get<AlertService>(AlertService);
  });

  it('renders player names and sends via the telegram adapter', async () => {
    await service.sendProposal(proposal, players);

    expect(telegram.sendProposalAlert).toHaveBeenCalledTimes(1);
    const [text, proposalId] = telegram.sendProposalAlert.mock.calls[0] as [
      string,
      string,
    ];

    expect(proposalId).toBe('prop-1');
    expect(text).toContain('Gameweek 4');
    expect(text).toContain('Raya');
    expect(text).toContain('Saka');
    expect(text).toContain('Captain: Saka');
    expect(text).toContain('Vice: Raya');
    expect(text).toContain('42.5');
    expect(text).not.toContain('Hit cost');
  });

  it('includes hit cost when nonzero', async () => {
    await service.sendProposal({ ...proposal, hitCost: 4 }, players);

    const [text] = telegram.sendProposalAlert.mock.calls[0] as [string];
    expect(text).toContain('Hit cost: -4');
  });

  it('falls back to a player id when the player is not found', async () => {
    await service.sendProposal({ ...proposal, captainId: 999 }, players);

    const [text] = telegram.sendProposalAlert.mock.calls[0] as [string];
    expect(text).toContain('#999');
  });
});
