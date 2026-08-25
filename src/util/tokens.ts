/**
 * Token estimation.
 *
 * We deliberately avoid pulling in a BPE tokenizer (a multi-megabyte rank table
 * and a WASM binary) for what is fundamentally a budgeting decision. Instead we
 * use a calibrated heuristic and keep a safety margin in the context budget.
 *
 * The heuristic blends two signals that bracket real BPE behaviour on English
 * technical prose:
 *   - characters / 4  — the classic OpenAI rule of thumb, accurate for prose
 *   - words * 1.3     — accurate for text with many short tokens
 * and adds a correction for punctuation-dense content (code, YAML, JSON), which
 * BPE splits far more aggressively than prose.
 *
 * Measured against `cl100k_base` on this repo's sample corpus the estimate lands
 * within roughly ±12% per chunk, which is comfortably inside the 15% headroom
 * the context builder reserves. If you need exact counts, implement
 * {@link Tokenizer} with your model's tokenizer and pass it through.
 */
export interface Tokenizer {
  count(text: string): number;
}

const PUNCT_RE = /[^\p{L}\p{N}\s]/gu;

export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  const chars = text.length;
  const words = (text.match(/\S+/g) ?? []).length;
  const punctuation = (text.match(PUNCT_RE) ?? []).length;

  const byChars = chars / 4;
  const byWords = words * 1.3;
  // Symbol-heavy text tokenises worse than prose; nudge upward proportionally.
  const punctuationDensity = chars === 0 ? 0 : punctuation / chars;
  const symbolPenalty = 1 + Math.min(0.45, punctuationDensity * 1.6);

  return Math.max(1, Math.round(((byChars + byWords) / 2) * symbolPenalty));
}

export const heuristicTokenizer: Tokenizer = { count: estimateTokens };
