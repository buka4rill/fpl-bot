import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AnthropicClient } from './anthropic.client';

const messagesCreateMock = jest.fn();

jest.mock('@anthropic-ai/sdk', () => {
  return jest.fn().mockImplementation(() => ({
    messages: { create: messagesCreateMock },
  }));
});

const mockedAnthropicSdk = (): jest.Mock =>
  jest.requireMock('@anthropic-ai/sdk');

describe('AnthropicClient', () => {
  let client: AnthropicClient;
  let config: { get: jest.Mock };

  beforeEach(async () => {
    messagesCreateMock.mockReset();
    mockedAnthropicSdk().mockClear();
    config = { get: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnthropicClient,
        { provide: ConfigService, useValue: config },
      ],
    }).compile();

    client = module.get<AnthropicClient>(AnthropicClient);
  });

  it('returns undefined without calling the SDK when no API key is configured', async () => {
    config.get.mockReturnValue(undefined);

    const result = await client.generateText('system', 'prompt');

    expect(result).toBeUndefined();
    expect(messagesCreateMock).not.toHaveBeenCalled();
  });

  it('returns the trimmed text block when an API key is configured', async () => {
    config.get.mockImplementation((key: string) => {
      if (key === 'narrative.anthropicApiKey') return 'sk-test-key';
      if (key === 'narrative.model') return 'claude-haiku-4-5';
      return undefined;
    });
    messagesCreateMock.mockResolvedValue({
      content: [{ type: 'text', text: '  a rationale  ' }],
    });

    const result = await client.generateText('system prompt', 'user prompt');

    expect(result).toBe('a rationale');
    expect(messagesCreateMock).toHaveBeenCalledWith({
      model: 'claude-haiku-4-5',
      max_tokens: 300,
      system: 'system prompt',
      messages: [{ role: 'user', content: 'user prompt' }],
    });
  });

  it('falls back to the default model when narrative.model is unset', async () => {
    config.get.mockImplementation((key: string) =>
      key === 'narrative.anthropicApiKey' ? 'sk-test-key' : undefined,
    );
    messagesCreateMock.mockResolvedValue({
      content: [{ type: 'text', text: 'rationale' }],
    });

    await client.generateText('system', 'prompt');

    expect(messagesCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-haiku-4-5' }),
    );
  });

  it('returns undefined when the response has no text content block', async () => {
    config.get.mockImplementation((key: string) =>
      key === 'narrative.anthropicApiKey' ? 'sk-test-key' : undefined,
    );
    messagesCreateMock.mockResolvedValue({ content: [] });

    const result = await client.generateText('system', 'prompt');

    expect(result).toBeUndefined();
  });

  it('only constructs the SDK client once across multiple calls', async () => {
    const AnthropicSdk = mockedAnthropicSdk();
    config.get.mockImplementation((key: string) =>
      key === 'narrative.anthropicApiKey' ? 'sk-test-key' : undefined,
    );
    messagesCreateMock.mockResolvedValue({
      content: [{ type: 'text', text: 'rationale' }],
    });

    await client.generateText('system', 'prompt 1');
    await client.generateText('system', 'prompt 2');

    expect(AnthropicSdk).toHaveBeenCalledTimes(1);
  });
});
