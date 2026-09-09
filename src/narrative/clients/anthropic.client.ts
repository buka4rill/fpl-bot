import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';

// Thin wrapper around the Anthropic SDK — isolated in its own client (same
// pattern as FplPublicClient/StatsProviderClient) so NarrativeService's own
// logic stays mockable and provider-agnostic. Returns `undefined` rather
// than throwing when no API key is configured — an unset ANTHROPIC_API_KEY
// means "the narrative feature is off," not "the app is misconfigured."
@Injectable()
export class AnthropicClient {
  private readonly logger = new Logger(AnthropicClient.name);
  private client: Anthropic | undefined;

  constructor(private readonly config: ConfigService) {}

  private getClient(): Anthropic | undefined {
    if (this.client) return this.client;
    const apiKey = this.config.get<string>('narrative.anthropicApiKey');
    if (!apiKey) return undefined;
    this.client = new Anthropic({ apiKey });
    return this.client;
  }

  async generateText(
    system: string,
    prompt: string,
  ): Promise<string | undefined> {
    const client = this.getClient();
    if (!client) return undefined;

    const model =
      this.config.get<string>('narrative.model') ?? 'claude-haiku-4-5';

    const response = await client.messages.create({
      model,
      max_tokens: 300,
      system,
      messages: [{ role: 'user', content: prompt }],
    });

    const textBlock = response.content.find((block) => block.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      this.logger.warn('Anthropic response had no text content block');
      return undefined;
    }
    return textBlock.text.trim();
  }
}
