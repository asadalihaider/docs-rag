import { setTimeout as sleep } from 'node:timers/promises';

export interface RetryOptions {
  attempts?: number;
  /** Base delay in ms for the exponential curve. */
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Return false to fail fast (e.g. 4xx that will never succeed). */
  isRetryable?: (error: unknown) => boolean;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  /** Injectable for deterministic tests. */
  random?: () => number;
}

/** Errors carrying an HTTP status, thrown by the HTTP-backed providers. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** Retry 429 and 5xx; treat everything else as terminal. */
export function defaultIsRetryable(error: unknown): boolean {
  if (error instanceof HttpError) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  // Network-level failures (ECONNRESET, socket hang up, fetch failed) are worth a retry.
  return error instanceof Error;
}

/**
 * Exponential backoff with full jitter (AWS "Exponential Backoff and Jitter").
 * Full jitter avoids the thundering herd you get with a fixed multiplier when a
 * whole embedding batch is rate-limited at once.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = options.attempts ?? 4;
  const baseDelayMs = options.baseDelayMs ?? 250;
  const maxDelayMs = options.maxDelayMs ?? 8_000;
  const isRetryable = options.isRetryable ?? defaultIsRetryable;
  const random = options.random ?? Math.random;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !isRetryable(error)) break;
      const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const delayMs = Math.round(random() * ceiling);
      options.onRetry?.(error, attempt, delayMs);
      await sleep(delayMs);
    }
  }
  throw lastError;
}
