import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { Markup } from 'telegraf';
import { TelegramAdapter } from './telegram.adapter';

const sendMessageMock = jest.fn();
const setMyCommandsMock = jest.fn().mockResolvedValue(undefined);

jest.mock('telegraf', () => ({
  Telegraf: jest.fn().mockImplementation(() => ({
    telegram: {
      sendMessage: sendMessageMock,
      setMyCommands: setMyCommandsMock,
    },
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
    setMyCommandsMock.mockClear();
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

  it('renders a three-button keyboard when a chip-free alternative exists', async () => {
    const adapter = await buildAdapter('test-token');
    const buttonCallbackMock = Markup.button.callback as jest.Mock;
    buttonCallbackMock.mockClear();

    await adapter.sendProposalAlert('hello', 'prop-1', true);

    expect(buttonCallbackMock).toHaveBeenCalledWith(
      '✅ Approve (with chip)',
      'approve:prop-1',
    );
    expect(buttonCallbackMock).toHaveBeenCalledWith(
      'Approve (without chip)',
      'approvenochip:prop-1',
    );
    expect(buttonCallbackMock).toHaveBeenCalledWith(
      '❌ Reject',
      'reject:prop-1',
    );
    expect(buttonCallbackMock).toHaveBeenCalledTimes(3);
  });

  it('renders the plain two-button keyboard when there is no chip-free alternative', async () => {
    const adapter = await buildAdapter('test-token');
    const buttonCallbackMock = Markup.button.callback as jest.Mock;
    buttonCallbackMock.mockClear();

    await adapter.sendProposalAlert('hello', 'prop-1');

    expect(buttonCallbackMock).toHaveBeenCalledWith(
      'Approve',
      'approve:prop-1',
    );
    expect(buttonCallbackMock).toHaveBeenCalledWith('Reject', 'reject:prop-1');
    expect(buttonCallbackMock).toHaveBeenCalledTimes(2);
  });

  it('sends a message with a yes/no inline keyboard for the applied-manually check-in', async () => {
    const adapter = await buildAdapter('test-token');

    await adapter.sendAppliedCheckIn('did you apply it?', 'prop-1');

    expect(sendMessageMock).toHaveBeenCalledWith(
      '12345',
      'did you apply it?',
      expect.objectContaining({ parse_mode: 'Markdown' }),
    );
    const [, , extra] = sendMessageMock.mock.calls[0] as [
      string,
      string,
      { reply_markup?: unknown },
    ];
    expect(extra.reply_markup).toBeDefined();
  });

  it('does nothing for the applied-manually check-in when no bot token is configured', async () => {
    const adapter = await buildAdapter('');

    await expect(
      adapter.sendAppliedCheckIn('did you apply it?', 'prop-1'),
    ).resolves.toBeUndefined();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  describe('onModuleInit', () => {
    it('registers the bot command menu', async () => {
      const adapter = await buildAdapter('test-token');

      await adapter.onModuleInit();

      expect(setMyCommandsMock).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ command: 'status' }),
          expect.objectContaining({ command: 'propose' }),
          expect.objectContaining({ command: 'chip' }),
          expect.objectContaining({ command: 'results' }),
          expect.objectContaining({ command: 'login' }),
          expect.objectContaining({ command: 'help' }),
        ]),
      );
    });

    it('does nothing when no bot token is configured', async () => {
      const adapter = await buildAdapter('');

      await expect(adapter.onModuleInit()).resolves.toBeUndefined();
      expect(setMyCommandsMock).not.toHaveBeenCalled();
    });

    it('does not throw when registering the command menu fails', async () => {
      const adapter = await buildAdapter('test-token');
      setMyCommandsMock.mockRejectedValueOnce(new Error('rate limited'));

      await expect(adapter.onModuleInit()).resolves.toBeUndefined();
    });
  });
});
