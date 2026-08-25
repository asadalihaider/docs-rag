import type { EmbedResult, Embedder } from '../../types.js';
import { HttpError, withRetry } from '../../util/retry.js';
import { batch, mapWithConcurrency } from '../../util/pool.js';
import { l2Normalize } from './vector-math.js';
import type { Logger } from '../../util/logger.js';
import { silentLogger } from '../../util/logger.js';

export interface OpenAIEmbedderOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  /** Output dimensionality. text-embedding-3-* support Matryoshka truncation. */
  dimensions?: number;
  /** Inputs per HTTP request. OpenAI accepts up to 2048; 96 keeps payloads small. */
  batchSize?: number;
  /** Concurrent in-flight requests. */
  concurrency?: number;
  requestTimeoutMs?: number;
  logger?: Logger;
  fetchImpl?: typeof fetch;
}

interface OpenAIEmbeddingResponse {
  data: Array<{ index: number; embedding: number[] }>;
  usage?: { prompt_tokens?: number; total_tokens?: number };
}

const DEFAULT_DIMENSIONS: Record<string, number> = {
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  'text-embedding-ada-002': 1536,
};

/**
 * OpenAI embeddings, batched with bounded concurrency and jittered retry.
 *
 * `text-embedding-3-small` is the default: it is the best cost/quality point for
 * documentation retrieval and supports dimension truncation, which lets you trade
 * index size for a small recall loss without re-embedding with a different model.
 */
export class OpenAIEmbedder implements Embedder {
  readonly id: string;
  readonly dimensions: number;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly batchSize: number;
  private readonly concurrency: number;
  private readonly requestTimeoutMs: number;
  private readonly logger: Logger;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAIEmbedderOptions) {
    if (!options.apiKey) throw new Error('OpenAIEmbedder requires an API key');
    this.apiKey = options.apiKey;
    this.model = options.model ?? 'text-embedding-3-small';
    this.baseUrl = (options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    this.dimensions = options.dimensions ?? DEFAULT_DIMENSIONS[this.model] ?? 1536;
    this.batchSize = options.batchSize ?? 96;
    this.concurrency = options.concurrency ?? 4;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
    this.logger = options.logger ?? silentLogger;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.id = `openai:${this.model}:${this.dimensions}`;
  }

  async embed(texts: string[]): Promise<EmbedResult> {
    if (texts.length === 0) return { vectors: [], tokens: 0 };

    const batches = batch(texts, this.batchSize);
    const results = await mapWithConcurrency(batches, this.concurrency, (group, index) =>
      this.embedBatch(group, index),
    );

    return {
      vectors: results.flatMap((r) => r.vectors),
      tokens: results.reduce((sum, r) => sum + r.tokens, 0),
    };
  }

  private async embedBatch(texts: string[], batchIndex: number): Promise<EmbedResult> {
    return withRetry(
      async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
        try {
          const body: Record<string, unknown> = {
            model: this.model,
            input: texts,
            encoding_format: 'float',
          };
          // Only send `dimensions` when it differs from the model default —
          // ada-002 rejects the parameter entirely.
          if (this.dimensions !== DEFAULT_DIMENSIONS[this.model]) {
            body['dimensions'] = this.dimensions;
          }

          const response = await this.fetchImpl(`${this.baseUrl}/embeddings`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify(body),
            signal: controller.signal,
          });

          if (!response.ok) {
            const text = await response.text().catch(() => '');
            throw new HttpError(
              response.status,
              `OpenAI embeddings failed: ${response.status} ${response.statusText}`,
              text,
            );
          }

          const json = (await response.json()) as OpenAIEmbeddingResponse;
          // The API does not guarantee ordering; sort by the returned index.
          const ordered = [...json.data].sort((a, b) => a.index - b.index);
          if (ordered.length !== texts.length) {
            throw new Error(
              `OpenAI returned ${ordered.length} embeddings for ${texts.length} inputs`,
            );
          }
          const vectors = ordered.map((d) => l2Normalize([...d.embedding]));
          return { vectors, tokens: json.usage?.total_tokens ?? 0 };
        } finally {
          clearTimeout(timer);
        }
      },
      {
        onRetry: (error, attempt, delayMs) =>
          this.logger.warn('retrying embedding batch', {
            batchIndex,
            attempt,
            delayMs,
            error: error instanceof Error ? error.message : String(error),
          }),
      },
    );
  }
}
