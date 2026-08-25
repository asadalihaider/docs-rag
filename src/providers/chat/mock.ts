import type { ChatModel, ChatRequest, ChatResponse } from '../../types.js';
import { analyzeUnique } from '../../retrieval/analyzer.js';
import { splitSentences, squish, truncate } from '../../util/text.js';
import { estimateTokens } from '../../util/tokens.js';

export interface MockChatOptions {
  /** Maximum number of sources quoted in a composed answer. */
  maxSources?: number;
  /** Characters of delay-free "streaming" chunk size. */
  streamChunkChars?: number;
}

/**
 * A deterministic, offline `ChatModel`.
 *
 * This is not a language model and does not pretend to generate prose. It is an
 * **extractive** answerer: it selects the sentences from the retrieved chunks
 * that best cover the question's terms and stitches them together with correct
 * `[^n]` citation markers. That makes the zero-setup demo genuinely useful —
 * the output shows the real retrieved evidence and the real citation plumbing,
 * end to end, without an API key — while being completely honest that no
 * generation happened.
 *
 * It also implements the reranker task, scoring each candidate by question-term
 * coverage, so the rerank code path is exercised offline and in tests.
 */
export class MockChat implements ChatModel {
  readonly id = 'mock';
  private readonly maxSources: number;
  private readonly streamChunkChars: number;

  constructor(options: MockChatOptions = {}) {
    this.maxSources = options.maxSources ?? 3;
    this.streamChunkChars = options.streamChunkChars ?? 24;
  }

  async complete(req: ChatRequest): Promise<ChatResponse> {
    const text = req.task === 'rerank' ? this.rerank(req) : this.answer(req);
    const promptTokens = req.messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
    return { text, promptTokens, completionTokens: estimateTokens(text) };
  }

  async *stream(req: ChatRequest): AsyncIterable<string> {
    const { text } = await this.complete(req);
    for (let i = 0; i < text.length; i += this.streamChunkChars) {
      yield text.slice(i, i + this.streamChunkChars);
    }
  }

  /* ---------------------------------------------------------------- */

  private answer(req: ChatRequest): string {
    const hints = req.hints;
    if (!hints || hints.sources.length === 0) {
      return 'I do not have any retrieved documentation to answer from.';
    }

    const queryTerms = new Set(analyzeUnique(hints.question));
    const picked: Array<{ n: number; sentence: string; score: number }> = [];

    for (const source of hints.sources) {
      const best = this.bestSentence(source.content, source.headingPath, queryTerms);
      if (best) picked.push({ n: source.n, sentence: best.sentence, score: best.score });
    }

    // Keep source order (retrieval rank) but only quote the strongest few.
    const strongest = new Set(
      [...picked]
        .sort((a, b) => b.score - a.score)
        .slice(0, this.maxSources)
        .map((p) => p.n),
    );
    const quoted = picked.filter((p) => strongest.has(p.n) && p.score > 0);

    if (quoted.length === 0) {
      // Nothing lexically overlapped; still cite the top source rather than
      // inventing anything.
      const top = hints.sources[0];
      if (!top) return 'I do not have any retrieved documentation to answer from.';
      const fallback = truncate(squish(stripHeadingPrefix(top.content)), 320);
      return `The closest passage in the documentation is from **${top.headingPath}**: ${fallback} [^${top.n}]`;
    }

    const lines = quoted.map((p) => `- ${p.sentence} [^${p.n}]`);
    return [
      `Here is what the documentation says about "${hints.question.trim()}":`,
      '',
      ...lines,
    ].join('\n');
  }

  private bestSentence(
    content: string,
    headingPath: string,
    queryTerms: ReadonlySet<string>,
  ): { sentence: string; score: number } | null {
    const headingTerms = new Set(analyzeUnique(headingPath));
    let headingBonus = 0;
    for (const term of headingTerms) if (queryTerms.has(term)) headingBonus += 0.5;

    let best: { sentence: string; score: number } | null = null;
    for (const sentence of splitSentences(stripHeadingPrefix(content))) {
      const clean = squish(sentence);
      if (clean.length < 20) continue;
      const terms = new Set(analyzeUnique(clean));
      let overlap = 0;
      for (const term of terms) if (queryTerms.has(term)) overlap += 1;
      if (overlap === 0) continue;
      // Normalise by length so a long paragraph does not win on volume alone.
      const score = overlap + headingBonus - Math.min(1, clean.length / 900);
      if (!best || score > best.score) best = { sentence: truncate(clean, 300), score };
    }
    return best;
  }

  /**
   * Rerank protocol: emit `index: score` lines, which is exactly what the real
   * providers are prompted to produce, so the parser is shared.
   */
  private rerank(req: ChatRequest): string {
    const hints = req.hints;
    if (!hints) return '';
    const queryTerms = new Set(analyzeUnique(hints.question));
    return hints.sources
      .map((source) => {
        const terms = analyzeUnique(`${source.headingPath} ${source.content}`);
        let overlap = 0;
        for (const term of terms) if (queryTerms.has(term)) overlap += 1;
        const coverage = queryTerms.size === 0 ? 0 : overlap / queryTerms.size;
        const score = Math.round(Math.min(10, coverage * 12));
        return `${source.n}: ${score}`;
      })
      .join('\n');
  }
}

/** Chunks carry a `Source: a > b` prefix line; drop it before quoting. */
function stripHeadingPrefix(content: string): string {
  return content.replace(/^Source:.*\n(?:Section:.*\n)?/, '');
}
