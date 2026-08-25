import type { ChatModel, ChatRequest, ChatResponse } from '../../types.js';
import { HttpError, withRetry } from '../../util/retry.js';
import { parseSse } from '../../util/sse.js';
import type { Logger } from '../../util/logger.js';
import { silentLogger } from '../../util/logger.js';

export interface OpenAIChatOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  maxTokens?: number;
  temperature?: number;
  requestTimeoutMs?: number;
  logger?: Logger;
  fetchImpl?: typeof fetch;
}

interface OpenAIChatResponse {
  choices: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * OpenAI Chat Completions provider.
 *
 * Also works against any OpenAI-compatible endpoint (Ollama, vLLM, LM Studio,
 * Together, Groq) by pointing `OPENAI_BASE_URL` elsewhere — which is the cheap
 * way to run this whole service against a local model.
 */
export class OpenAIChat implements ChatModel {
  readonly id: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly maxTokens: number;
  private readonly temperature: number;
  private readonly requestTimeoutMs: number;
  private readonly logger: Logger;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAIChatOptions) {
    if (!options.apiKey) throw new Error('OpenAIChat requires an API key');
    this.apiKey = options.apiKey;
    this.model = options.model ?? 'gpt-4o-mini';
    this.baseUrl = (options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    this.maxTokens = options.maxTokens ?? 1024;
    this.temperature = options.temperature ?? 0;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
    this.logger = options.logger ?? silentLogger;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.id = `openai:${this.model}`;
  }

  private buildBody(req: ChatRequest, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      max_tokens: req.maxTokens ?? this.maxTokens,
      temperature: req.temperature ?? this.temperature,
    };
    if (stream) {
      body['stream'] = true;
      body['stream_options'] = { include_usage: true };
    }
    return body;
  }

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      authorization: `Bearer ${this.apiKey}`,
    };
  }

  async complete(req: ChatRequest): Promise<ChatResponse> {
    return withRetry(
      async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
        try {
          const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: this.headers(),
            body: JSON.stringify(this.buildBody(req, false)),
            signal: controller.signal,
          });
          if (!response.ok) {
            const text = await response.text().catch(() => '');
            throw new HttpError(
              response.status,
              `OpenAI chat failed: ${response.status} ${response.statusText}`,
              text,
            );
          }
          const json = (await response.json()) as OpenAIChatResponse;
          return {
            text: json.choices[0]?.message?.content ?? '',
            promptTokens: json.usage?.prompt_tokens ?? 0,
            completionTokens: json.usage?.completion_tokens ?? 0,
          };
        } finally {
          clearTimeout(timer);
        }
      },
      {
        onRetry: (error, attempt, delayMs) =>
          this.logger.warn('retrying openai completion', {
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
      const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { ...this.headers(), accept: 'text/event-stream' },
        body: JSON.stringify(this.buildBody(req, true)),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        const text = await response.text().catch(() => '');
        throw new HttpError(
          response.status,
          `OpenAI stream failed: ${response.status} ${response.statusText}`,
          text,
        );
      }

      for await (const event of parseSse(response.body)) {
        if (event.data === '[DONE]') return;
        let payload: { choices?: Array<{ delta?: { content?: string } }> };
        try {
          payload = JSON.parse(event.data) as typeof payload;
        } catch {
          continue;
        }
        const delta = payload.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta.length > 0) yield delta;
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
