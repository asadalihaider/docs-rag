import type { FusedResult } from '../types.js';
import { contextualText } from '../ingest/chunker.js';
import { estimateTokens } from '../util/tokens.js';

export interface ContextSource {
  n: number;
  file: string;
  headingPath: string;
  content: string;
  result: FusedResult;
  tokens: number;
}

export interface BuildContextOptions {
  /** Token budget for the *sources* section of the prompt. */
  tokenBudget?: number;
  /** Hard cap on sources regardless of budget. */
  maxSources?: number;
  /**
   * Reserved fraction of the budget, to absorb the difference between our token
   * estimate and the model's real tokenizer. See `src/util/tokens.ts`.
   */
  headroom?: number;
}

export interface BuiltContext {
  sources: ContextSource[];
  /** Results that did not fit and were dropped, lowest-ranked first. */
  dropped: FusedResult[];
  tokens: number;
}

/**
 * Assemble the prompt's evidence section under a token budget.
 *
 * Results arrive in final rank order, so dropping from the tail drops the
 * lowest-ranked evidence — the correct thing to sacrifice. A single oversized
 * chunk (a long code fence) is skipped rather than allowed to consume the whole
 * budget, and we keep scanning, so one huge chunk cannot starve the five good
 * ones behind it.
 */
export function buildContext(
  results: readonly FusedResult[],
  options: BuildContextOptions = {},
): BuiltContext {
  const budget = Math.floor((options.tokenBudget ?? 6000) * (1 - (options.headroom ?? 0.15)));
  const maxSources = options.maxSources ?? 8;

  const sources: ContextSource[] = [];
  const dropped: FusedResult[] = [];
  let used = 0;

  for (const result of results) {
    if (sources.length >= maxSources) {
      dropped.push(result);
      continue;
    }
    const content = contextualText(result.chunk);
    // + a few tokens for the `[n] path — heading` header line we add per source.
    const tokens = estimateTokens(content) + 24;
    if (used + tokens > budget) {
      dropped.push(result);
      continue;
    }
    sources.push({
      n: sources.length + 1,
      file: result.chunk.documentPath,
      headingPath: [result.chunk.documentTitle, ...result.chunk.headingPath].join(' > '),
      content,
      result,
      tokens,
    });
    used += tokens;
  }

  return { sources, dropped, tokens: used };
}
