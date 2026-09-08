import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { TelegramAdapter } from './telegram.adapter';

const sendMessageMock = jest.fn();

jest.mock('telegraf', () => ({
  Telegraf: jest.fn().mockImplementation(() => ({
    telegram: { sendMessage: sendMessageMock },
  })),
  Markup: {
    inlineKeyboard: jest.fn((buttons: unknown) => ({
      reply_markup: { inline_keyboard: [buttons] },
    })),
    button: {
      callback: jest.fn((text: string, data: string) => ({
        text,
        callback_data: data,
      })),
    },
  },
}));

describe('TelegramAdapter', () => {
  const buildAdapter = async (botToken: string): Promise<TelegramAdapter> => {
    const config = {
      get: jest.fn((key: string) => {
        if (key === 'telegram.botToken') return botToken;
        if (key === 'telegram.chatId') return '12345';
        return undefined;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TelegramAdapter,
        { provide: ConfigService, useValue: config },
      ],
    }).compile();

    return module.get<TelegramAdapter>(TelegramAdapter);
  };

  beforeEach(() => {
    sendMessageMock.mockClear();
  });

  it('sends a message with an approve/reject inline keyboard to the configured chat', async () => {
    const adapter = await buildAdapter('test-token');

    await adapter.sendProposalAlert('hello', 'prop-1');

    expect(sendMessageMock).toHaveBeenCalledWith(
      '12345',
      'hello',
      expect.objectContaining({ parse_mode: 'Markdown' }),
    );
    const [, , extra] = sendMessageMock.mock.calls[0] as [
      string,
      string,
      { reply_markup?: unknown },
    ];
    expect(extra.reply_markup).toBeDefined();
  });

  it('does nothing when no bot token is configured', async () => {
    const adapter = await buildAdapter('');

    await expect(
      adapter.sendProposalAlert('hello', 'prop-1'),
    ).resolves.toBeUndefined();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });
});
