import type { ChatModel, FusedResult } from '../types.js';
import { contextualText } from '../ingest/chunker.js';
import { truncate } from '../util/text.js';
import type { Logger } from '../util/logger.js';
import { silentLogger } from '../util/logger.js';

export interface RerankOptions {
  chat: ChatModel;
  /** How many top candidates to rerank. Reranking all of them is rarely worth the latency. */
  topN?: number;
  /** Characters of each candidate shown to the reranker. */
  excerptChars?: number;
  logger?: Logger;
}

const SYSTEM_PROMPT = `You are a search relevance rater for a technical documentation search engine.
You will be given a user question and a numbered list of documentation passages.
Rate how well each passage answers the question, on an integer scale from 0 to 10:

  10 = directly and completely answers the question
   7 = contains most of the answer
   4 = related topic, partial or indirect information
   0 = unrelated

Respond with one line per passage in the exact form "<number>: <score>".
Output nothing else — no prose, no explanation, no markdown.`;

/**
 * LLM-as-reranker ("cross-encoder-style" rerank).
 *
 * A true cross-encoder scores (query, passage) jointly instead of comparing two
 * independently-computed embeddings, which is why it consistently beats
 * bi-encoder retrieval on precision@k. We get the same joint-scoring property by
 * putting the query and every candidate in one prompt and asking the model to
 * rate them — no extra model to host, at the cost of one LLM round-trip.
 *
 * It is strictly a *reordering* step: it can only reorder what retrieval already
 * found, never recover a chunk retrieval missed. That is why `topN` defaults
 * generously — reranking a wide candidate list is where the win is.
 *
 * Failure is non-fatal by design. If the model returns garbage, or times out,
 * the original fused ordering is returned unchanged; a flaky reranker must not
 * take down question answering.
 */
export async function rerank(
  question: string,
  candidates: FusedResult[],
  options: RerankOptions,
): Promise<{ results: FusedResult[]; promptTokens: number; completionTokens: number }> {
  const logger = options.logger ?? silentLogger;
  const topN = Math.min(options.topN ?? 20, candidates.length);
  const excerptChars = options.excerptChars ?? 700;

  if (topN < 2) return { results: candidates, promptTokens: 0, completionTokens: 0 };

  const head = candidates.slice(0, topN);
  const tail = candidates.slice(topN);

  const sources = head.map((candidate, index) => ({
    n: index + 1,
    file: candidate.chunk.documentPath,
    headingPath: [candidate.chunk.documentTitle, ...candidate.chunk.headingPath].join(' > '),
    content: truncate(contextualText(candidate.chunk), excerptChars),
  }));

  const userPrompt = [
    `Question: ${question}`,
    '',
    'Passages:',
    ...sources.map((s) => `[${s.n}] (${s.file} — ${s.headingPath})\n${s.content}`),
    '',
    `Rate all ${sources.length} passages.`,
  ].join('\n');

  let response;
  try {
    response = await options.chat.complete({
      task: 'rerank',
      temperature: 0,
      maxTokens: 16 * sources.length + 64,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      hints: { question, sources },
    });
  } catch (error) {
    logger.warn('rerank failed, keeping fused order', {
      error: error instanceof Error ? error.message : String(error),
    });
    return { results: candidates, promptTokens: 0, completionTokens: 0 };
  }

  const scores = parseRerankScores(response.text, sources.length);
  if (scores.size === 0) {
    logger.warn('rerank returned no parseable scores, keeping fused order', {
      sample: response.text.slice(0, 120),
    });
    return {
      results: candidates,
      promptTokens: response.promptTokens,
      completionTokens: response.completionTokens,
    };
  }

  const reranked = head
    .map((candidate, index) => ({
      ...candidate,
      rerankScore: scores.get(index + 1) ?? null,
    }))
    .sort((a, b) => {
      const sa = a.rerankScore ?? -1;
      const sb = b.rerankScore ?? -1;
      // Ties fall back to the fused score, so the reranker refines rather than
      // discards the retrieval signal.
      return sb - sa || b.score - a.score;
    });

  return {
    results: [...reranked, ...tail],
    promptTokens: response.promptTokens,
    completionTokens: response.completionTokens,
  };
}

/**
 * Parse `"<n>: <score>"` lines. Tolerant of markdown bullets, `[n]` brackets and
 * stray prose, because models add them; anything out of range is discarded.
 */
export function parseRerankScores(text: string, count: number): Map<number, number> {
  const out = new Map<number, number>();
  const pattern = /(?:^|\n)\s*(?:[-*]\s*)?\[?(\d{1,3})\]?\s*[:.)-]\s*(\d{1,2})(?:\s*\/\s*10)?\b/g;
  for (const match of text.matchAll(pattern)) {
    const n = Number(match[1]);
    const score = Number(match[2]);
    if (!Number.isFinite(n) || !Number.isFinite(score)) continue;
    if (n < 1 || n > count) continue;
    if (score < 0 || score > 10) continue;
    if (!out.has(n)) out.set(n, score);
  }
  return out;
}
