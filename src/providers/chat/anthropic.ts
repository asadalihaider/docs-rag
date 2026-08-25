import type { ChatModel, ChatRequest, ChatResponse } from '../../types.js';
import { HttpError, withRetry } from '../../util/retry.js';
import { parseSse } from '../../util/sse.js';
import type { Logger } from '../../util/logger.js';
import { silentLogger } from '../../util/logger.js';

export interface AnthropicChatOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  maxTokens?: number;
  temperature?: number;
  apiVersion?: string;
  requestTimeoutMs?: number;
  logger?: Logger;
  fetchImpl?: typeof fetch;
}

interface AnthropicMessageResponse {
  content: Array<{ type: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/**
 * Anthropic Messages API provider.
 *
 * The system prompt is passed via the top-level `system` field rather than as a
 * message, which is what the Messages API expects; message roles are limited to
 * user/assistant.
 */
export class AnthropicChat implements ChatModel {
  readonly id: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly maxTokens: number;
  private readonly temperature: number;
  private readonly apiVersion: string;
  private readonly requestTimeoutMs: number;
  private readonly logger: Logger;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AnthropicChatOptions) {
    if (!options.apiKey) throw new Error('AnthropicChat requires an API key');
    this.apiKey = options.apiKey;
    this.model = options.model ?? 'claude-sonnet-4-5';
    this.baseUrl = (options.baseUrl ?? 'https://api.anthropic.com/v1').replace(/\/$/, '');
    this.maxTokens = options.maxTokens ?? 1024;
    this.temperature = options.temperature ?? 0;
    this.apiVersion = options.apiVersion ?? '2023-06-01';
    this.requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
    this.logger = options.logger ?? silentLogger;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.id = `anthropic:${this.model}`;
  }

  private buildBody(req: ChatRequest, stream: boolean): Record<string, unknown> {
    const system = req.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const messages = req.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content }));

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: req.maxTokens ?? this.maxTokens,
      temperature: req.temperature ?? this.temperature,
      messages,
    };
    if (system) body['system'] = system;
    if (stream) body['stream'] = true;
    return body;
  }

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': this.apiVersion,
    };
  }

  async complete(req: ChatRequest): Promise<ChatResponse> {
    return withRetry(
      async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
        try {
          const response = await this.fetchImpl(`${this.baseUrl}/messages`, {
            method: 'POST',
            headers: this.headers(),
            body: JSON.stringify(this.buildBody(req, false)),
            signal: controller.signal,
          });
          if (!response.ok) {
            const text = await response.text().catch(() => '');
            throw new HttpError(
              response.status,
              `Anthropic messages failed: ${response.status} ${response.statusText}`,
              text,
            );
          }
          const json = (await response.json()) as AnthropicMessageResponse;
          const text = json.content
            .filter((block) => block.type === 'text')
            .map((block) => block.text ?? '')
            .join('');
          return {
            text,
            promptTokens: json.usage?.input_tokens ?? 0,
            completionTokens: json.usage?.output_tokens ?? 0,
          };
        } finally {
          clearTimeout(timer);
        }
      },
      {
        onRetry: (error, attempt, delayMs) =>
          this.logger.warn('retrying anthropic completion', {
            attempt,
            delayMs,
            error: error instanceof Error ? error.message : String(error),
          }),
      },
    );
  }

  async *stream(req: ChatRequest): AsyncIterable<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/messages`, {
        method: 'POST',
        headers: { ...this.headers(), accept: 'text/event-stream' },
        body: JSON.stringify(this.buildBody(req, true)),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        const text = await response.text().catch(() => '');
        throw new HttpError(
          response.status,
          `Anthropic stream failed: ${response.status} ${response.statusText}`,
          text,
        );
      }

      for await (const event of parseSse(response.body)) {
        if (event.event === 'content_block_delta') {
          const payload = safeParse(event.data);
          const delta = payload?.['delta'] as { type?: string; text?: string } | undefined;
          if (delta?.type === 'text_delta' && typeof delta.text === 'string') yield delta.text;
        } else if (event.event === 'error') {
          throw new Error(`Anthropic stream error: ${event.data}`);
        }
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

function safeParse(data: string): Record<string, unknown> | null {
  try {
    return JSON.parse(data) as Record<string, unknown>;
  } catch {
    return null;
  }
}
