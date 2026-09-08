import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { of } from 'rxjs';
import { AxiosResponse } from 'axios';
import { ApprovalController } from './approval.controller';
import { ApprovalService } from './approval.service';
import { ProposalStatus } from '../common/enums/proposal-status.enum';

describe('ApprovalController', () => {
  let controller: ApprovalController;
  let approvalService: { decide: jest.Mock };
  let httpService: { post: jest.Mock };

  const CONFIGURED_CHAT_ID = '12345';
  const BOT_TOKEN = 'test-bot-token';

  beforeEach(async () => {
    approvalService = { decide: jest.fn() };
    httpService = {
      post: jest.fn().mockReturnValue(of({ data: {} } as AxiosResponse)),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ApprovalController],
      providers: [
        { provide: ApprovalService, useValue: approvalService },
        { provide: HttpService, useValue: httpService },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'telegram.chatId') return CONFIGURED_CHAT_ID;
              if (key === 'telegram.botToken') return BOT_TOKEN;
              return undefined;
            }),
          },
        },
      ],
    }).compile();

    controller = module.get<ApprovalController>(ApprovalController);
  });

  const update = (
    data: string,
    chatId: number | undefined = 12345,
    callbackQueryId = 'cbq-1',
  ) => ({
    callback_query: {
      id: callbackQueryId,
      data,
      from: { id: 999 },
      message: chatId === undefined ? undefined : { chat: { id: chatId } },
    },
  });

  it('approves via the approve:<id> callback from the configured chat', async () => {
    const result = await controller.handleTelegramCallback(
      update('approve:prop-1'),
    );

    expect(approvalService.decide).toHaveBeenCalledWith(
      'prop-1',
      ProposalStatus.APPROVED,
      '999',
    );
    expect(result).toEqual({ ok: true });
  });

  it('rejects via the reject:<id> callback', async () => {
    await controller.handleTelegramCallback(update('reject:prop-1'));

    expect(approvalService.decide).toHaveBeenCalledWith(
      'prop-1',
      ProposalStatus.REJECTED,
      '999',
    );
  });

  it('ignores a callback from an unrecognized chat', async () => {
    const result = await controller.handleTelegramCallback(
      update('approve:prop-1', 99999),
    );

    expect(approvalService.decide).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true });
  });

  it('ignores malformed callback data', async () => {
    await controller.handleTelegramCallback(update('not-a-valid-action'));

    expect(approvalService.decide).not.toHaveBeenCalled();
  });

  it('ignores an update with no callback_query', async () => {
    const result = await controller.handleTelegramCallback({});

    expect(approvalService.decide).not.toHaveBeenCalled();
    expect(httpService.post).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true });
  });

  it('still acknowledges when the approval service throws', async () => {
    approvalService.decide.mockImplementation(() => {
      throw new Error('No proposal found with id prop-1.');
    });

    const result = await controller.handleTelegramCallback(
      update('approve:prop-1'),
    );

    expect(result).toEqual({ ok: true });
  });

  it('answers the callback query to clear the button spinner on success', async () => {
    await controller.handleTelegramCallback(
      update('reject:prop-1', 12345, 'cbq-42'),
    );

    expect(httpService.post).toHaveBeenCalledWith(
      `https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`,
      { callback_query_id: 'cbq-42', text: 'Rejected.' },
    );
  });

  it('answers the callback query with a generic toast on failure', async () => {
    approvalService.decide.mockImplementation(() => {
      throw new Error(
        'Cannot transition a proposal from REJECTED to REJECTED.',
      );
    });

    await controller.handleTelegramCallback(
      update('reject:prop-1', 12345, 'cbq-dup'),
    );

    expect(httpService.post).toHaveBeenCalledWith(
      `https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`,
      {
        callback_query_id: 'cbq-dup',
        text: 'Already handled — no change made.',
      },
    );
  });

  it('does not fail the webhook response when answering the callback query errors', async () => {
    httpService.post.mockImplementation(() => {
      throw new Error('network blip');
    });

    const result = await controller.handleTelegramCallback(
      update('approve:prop-1'),
    );

    expect(result).toEqual({ ok: true });
  });

  it('ignores an update with no callback data at all', async () => {
    const result = await controller.handleTelegramCallback({
      callback_query: { id: 'cbq-empty' },
    });

    expect(approvalService.decide).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true });
  });
});
