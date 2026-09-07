import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ApprovalController } from './approval.controller';
import { ApprovalService } from './approval.service';
import { ProposalStatus } from '../common/enums/proposal-status.enum';

describe('ApprovalController', () => {
  let controller: ApprovalController;
  let approvalService: { decide: jest.Mock };

  const CONFIGURED_CHAT_ID = '12345';

  beforeEach(async () => {
    approvalService = { decide: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ApprovalController],
      providers: [
        { provide: ApprovalService, useValue: approvalService },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue(CONFIGURED_CHAT_ID) },
        },
      ],
    }).compile();

    controller = module.get<ApprovalController>(ApprovalController);
  });

  const update = (data: string, chatId: number | undefined = 12345) => ({
    callback_query: {
      data,
      from: { id: 999 },
      message: chatId === undefined ? undefined : { chat: { id: chatId } },
    },
  });

  it('approves via the approve:<id> callback from the configured chat', () => {
    const result = controller.handleTelegramCallback(update('approve:prop-1'));

    expect(approvalService.decide).toHaveBeenCalledWith(
      'prop-1',
      ProposalStatus.APPROVED,
      '999',
    );
    expect(result).toEqual({ ok: true });
  });

  it('rejects via the reject:<id> callback', () => {
    controller.handleTelegramCallback(update('reject:prop-1'));

    expect(approvalService.decide).toHaveBeenCalledWith(
      'prop-1',
      ProposalStatus.REJECTED,
      '999',
    );
  });

  it('ignores a callback from an unrecognized chat', () => {
    const result = controller.handleTelegramCallback(
      update('approve:prop-1', 99999),
    );

    expect(approvalService.decide).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true });
  });

  it('ignores malformed callback data', () => {
    controller.handleTelegramCallback(update('not-a-valid-action'));

    expect(approvalService.decide).not.toHaveBeenCalled();
  });

  it('ignores an update with no callback_query', () => {
    const result = controller.handleTelegramCallback({});

    expect(approvalService.decide).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true });
  });

  it('still acknowledges when the approval service throws', () => {
    approvalService.decide.mockImplementation(() => {
      throw new Error('No proposal found with id prop-1.');
    });

    const result = controller.handleTelegramCallback(update('approve:prop-1'));

    expect(result).toEqual({ ok: true });
  });
});
