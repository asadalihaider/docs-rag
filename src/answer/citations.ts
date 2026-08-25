import type { Citation } from '../types.js';
import type { ContextSource } from './context.js';
import { squish, truncate } from '../util/text.js';
import type { Logger } from '../util/logger.js';
import { silentLogger } from '../util/logger.js';

/** `[^12]`. Built fresh per use so a shared `lastIndex` can never leak between calls. */
const MARKER_SOURCE = String.raw`\[\^(\d+)\]`;
const marker = (): RegExp => new RegExp(MARKER_SOURCE, 'g');

/** A footnote *definition* line, e.g. `[^2]: guides/installation.md`. */
const definitionLine = (): RegExp => /^[ \t]*\[\^\d+\]:.*$/gm;

/**
 * Sentinel used while renumbering. U+0000 cannot appear in model output and is
 * stripped from the final text, so a bare number in the prose can never be
 * mistaken for a citation marker during the second pass.
 */
const SENTINEL = '\u0000';

export interface VerifyOptions {
  /** Renumber surviving citations to 1..m in order of first appearance. */
  renumber?: boolean;
  excerptChars?: number;
  logger?: Logger;
}

export interface VerifiedAnswer {
  text: string;
  citations: Citation[];
  /** Citation numbers the model emitted that matched no retrieved passage. */
  dropped: number[];
}

/** All `[^n]` markers in the order they appear. */
export function extractCitationMarkers(text: string): number[] {
  return [...text.matchAll(marker())].map((m) => Number(m[1]));
}

/**
 * Verify and normalise the citations in a generated answer.
 *
 * Grounding a model in retrieved passages reduces hallucination but does not
 * eliminate it, and citation markers are one of the places it shows up most
 * often and most convincingly: a model shown five passages will cheerfully emit
 * `[^7]`. A dangling marker is worse than no marker, because it *looks*
 * verified.
 *
 * What this does, mechanically:
 *   1. Delete any marker whose number is not in the retrieved source set, and
 *      record it so the caller can log and alert on the rate.
 *   2. Strip footnote definition blocks the model added despite instructions —
 *      the caller renders the source list from verified data, not model output.
 *   3. Renumber the survivors to a dense 1..m in order of first appearance, so
 *      a reader never sees "[^1] then [^5]" with nothing in between.
 *   4. Emit a `Citation` per surviving marker carrying the real file, heading
 *      path, retrieval score and excerpt — every field comes from the retrieval
 *      record, so nothing in the citation list originates from the model.
 *
 * What it does **not** do: check that the cited passage actually supports the
 * sentence. That needs an entailment check — see "what I'd do next".
 */
export function verifyCitations(
  rawText: string,
  sources: readonly ContextSource[],
  options: VerifyOptions = {},
): VerifiedAnswer {
  const logger = options.logger ?? silentLogger;
  const renumber = options.renumber ?? true;
  const excerptChars = options.excerptChars ?? 240;

  const byNumber = new Map(sources.map((s) => [s.n, s]));
  const dropped: number[] = [];
  const orderOfFirstUse: number[] = [];

  let text = rawText
    .replaceAll(SENTINEL, '')
    .replace(definitionLine(), '')
    .replace(/\n{3,}/g, '\n\n');

  text = text.replace(marker(), (match, digits: string) => {
    const n = Number(digits);
    if (!byNumber.has(n)) {
      dropped.push(n);
      return '';
    }
    if (!orderOfFirstUse.includes(n)) orderOfFirstUse.push(n);
    return match;
  });

  if (dropped.length > 0) {
    logger.warn('stripped unverifiable citation markers', {
      dropped: [...new Set(dropped)],
      validRange: sources.length === 0 ? 'none' : `1-${sources.length}`,
    });
  }

  const finalNumbers = new Map<number, number>();
  orderOfFirstUse.forEach((original, index) => {
    finalNumbers.set(original, renumber ? index + 1 : original);
  });

  if (renumber) {
    text = text
      .replace(
        marker(),
        (_m, digits: string) => `${SENTINEL}${finalNumbers.get(Number(digits))}${SENTINEL}`,
      )
      .replace(new RegExp(`${SENTINEL}(\\d+)${SENTINEL}`, 'g'), '[^$1]');
  }

  const citations: Citation[] = orderOfFirstUse.map((original) => {
    const source = byNumber.get(original) as ContextSource;
    return {
      n: finalNumbers.get(original) as number,
      file: source.file,
      headingPath: source.result.chunk.headingPath.join(' > '),
      score: source.result.score,
      excerpt: truncate(squish(source.result.chunk.content), excerptChars),
      chunkId: source.result.chunk.id,
    };
  });

  // Tidy whitespace left behind by a removed marker (" ." / double spaces).
  text = text
    .replace(/[ \t]+([.,;:!?])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

  return { text, citations, dropped };
}
