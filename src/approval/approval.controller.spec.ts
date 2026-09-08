import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { of } from 'rxjs';
import { AxiosResponse } from 'axios';
import { ApprovalController } from './approval.controller';
import { ApprovalService } from './approval.service';
import { TelegramCommandsService } from '../telegram-commands/telegram-commands.service';
import { ProposalStatus } from '../common/enums/proposal-status.enum';

describe('ApprovalController', () => {
  let controller: ApprovalController;
  let approvalService: { decide: jest.Mock; recordAppliedManually: jest.Mock };
  let telegramCommandsService: { handleCommand: jest.Mock };
  let httpService: { post: jest.Mock };

  const CONFIGURED_CHAT_ID = '12345';
  const BOT_TOKEN = 'test-bot-token';

  beforeEach(async () => {
    approvalService = { decide: jest.fn(), recordAppliedManually: jest.fn() };
    telegramCommandsService = {
      handleCommand: jest.fn().mockResolvedValue(undefined),
    };
    httpService = {
      post: jest.fn().mockReturnValue(of({ data: {} } as AxiosResponse)),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ApprovalController],
      providers: [
        { provide: ApprovalService, useValue: approvalService },
        {
          provide: TelegramCommandsService,
          useValue: telegramCommandsService,
        },
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

  it('approves without the chip via the approvenochip:<id> callback', async () => {
    const result = await controller.handleTelegramCallback(
      update('approvenochip:prop-1'),
    );

    expect(approvalService.decide).toHaveBeenCalledWith(
      'prop-1',
      ProposalStatus.APPROVED,
      '999',
      { withoutChip: true },
    );
    expect(result).toEqual({ ok: true });
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

  it('records a "yes" applied-manually reply via the appliedyes:<id> callback', async () => {
    const result = await controller.handleTelegramCallback(
      update('appliedyes:prop-1'),
    );

    expect(approvalService.recordAppliedManually).toHaveBeenCalledWith(
      'prop-1',
      true,
    );
    expect(approvalService.decide).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true });
  });

  it('records a "no" applied-manually reply via the appliedno:<id> callback', async () => {
    await controller.handleTelegramCallback(update('appliedno:prop-1'));

    expect(approvalService.recordAppliedManually).toHaveBeenCalledWith(
      'prop-1',
      false,
    );
  });

  it('answers the callback query with a fixed toast for an applied-manually reply', async () => {
    await controller.handleTelegramCallback(
      update('appliedyes:prop-1', 12345, 'cbq-applied'),
    );

    expect(httpService.post).toHaveBeenCalledWith(
      `https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`,
      { callback_query_id: 'cbq-applied', text: 'Thanks — noted.' },
    );
  });

  it('ignores an applied-manually reply from an unrecognized chat', async () => {
    await controller.handleTelegramCallback(update('appliedyes:prop-1', 99999));

    expect(approvalService.recordAppliedManually).not.toHaveBeenCalled();
  });

  describe('slash commands', () => {
    const message = (text: string, chatId: number | undefined = 12345) => ({
      message: {
        text,
        chat: chatId === undefined ? undefined : { id: chatId },
      },
    });

    it('dispatches a /status command from the configured chat', async () => {
      const result = await controller.handleTelegramCallback(
        message('/status'),
      );

      expect(telegramCommandsService.handleCommand).toHaveBeenCalledWith(
        '/status',
      );
      expect(result).toEqual({ ok: true });
    });

    it('dispatches /propose and /login the same way', async () => {
      await controller.handleTelegramCallback(message('/propose'));
      await controller.handleTelegramCallback(message('/login'));

      expect(telegramCommandsService.handleCommand).toHaveBeenCalledWith(
        '/propose',
      );
      expect(telegramCommandsService.handleCommand).toHaveBeenCalledWith(
        '/login',
      );
    });

    it('ignores a command from an unrecognized chat', async () => {
      await controller.handleTelegramCallback(message('/status', 99999));

      expect(telegramCommandsService.handleCommand).not.toHaveBeenCalled();
    });

    it('ignores a plain-text message that is not a command', async () => {
      await controller.handleTelegramCallback(message('just chatting'));

      expect(telegramCommandsService.handleCommand).not.toHaveBeenCalled();
    });

    it('does not answer a callback query for a plain message', async () => {
      await controller.handleTelegramCallback(message('/status'));

      expect(httpService.post).not.toHaveBeenCalled();
    });

    it('still acknowledges the webhook when command handling throws', async () => {
      telegramCommandsService.handleCommand.mockRejectedValue(
        new Error('boom'),
      );

      const result = await controller.handleTelegramCallback(
        message('/status'),
      );

      expect(result).toEqual({ ok: true });
    });
  });
});
