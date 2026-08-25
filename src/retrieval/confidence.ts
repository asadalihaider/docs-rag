export interface ConfidenceOptions {
  /** Weight given to the dense margin inside the evidence-strength term. */
  denseWeight?: number;
  /**
   * BM25 score at which the sparse magnitude term reaches 0.5. Damps the case
   * where one rare word matches one short chunk and produces a large *relative*
   * margin off a tiny absolute score.
   */
  bm25Saturation?: number;
  /** Fraction of the candidate list, taken from the tail, used as the baseline. */
  baselineFraction?: number;
}

export interface ConfidenceInput {
  /** Cosine similarities of the dense candidates, descending. */
  dense: readonly number[];
  /** BM25 scores of the sparse candidates, descending. */
  sparse: readonly number[];
  /**
   * Fraction of the question's content terms that the best-matching passage
   * actually contains, in [0, 1]. See `queryCoverage`.
   */
  coverage: number;
}

/**
 * How confident retrieval is that the corpus contains the answer, in [0, 1].
 * Below `RAG_MIN_CONFIDENCE` the service abstains instead of generating.
 *
 * ## Why not the obvious things
 *
 * **Thresholding the top cosine similarity.** Every embedding model has its own
 * baseline: two unrelated English sentences sit near 0.75 cosine with OpenAI's
 * models and near 0.40 with the hashed-n-gram embedder here, so an absolute
 * threshold must be re-tuned per model *and* per corpus. Measured on this
 * repo's sample corpus it also simply does not work — on-topic questions scored
 * 0.43–0.67 and off-topic ones 0.36–0.45, ranges that overlap so heavily no
 * threshold separates them.
 *
 * **Thresholding the RRF score.** It is a function of rank alone. The top result
 * of a query with no relevant document scores identically to the top result of a
 * perfect match, so it carries no abstention signal whatsoever.
 *
 * ## What this measures: evidence strength × query coverage
 *
 * **Evidence strength** — for each retriever, compare the top candidate against
 * the mean of the *tail* of that retriever's own candidate list. The tail is a
 * per-query, per-model estimate of "what a mediocre match looks like right now",
 * which cancels out the model's baseline similarity and the corpus vocabulary:
 *
 *     margin = (top − baseline) / top
 *
 * When the corpus genuinely answers a question one chunk stands well above its
 * neighbours; when it does not, every candidate is equally mediocre and the
 * margin collapses. The sparse side additionally multiplies by
 * `top / (top + saturation)` so a single weak lexical hit cannot look decisive.
 *
 * **Query coverage** — the fraction of the question's content words that the
 * best-matching passage actually contains. This is the term that catches the
 * failure margin alone cannot: an off-topic question sharing one rare word with
 * one chunk ("best hiking **boots**") produces a perfect margin off a single
 * candidate, but covers a fifth of the question. A real answer covers most of it.
 *
 * The two are combined as a geometric mean, so both must hold up — strong
 * evidence for a fragment of the question is not enough, and neither is broad
 * but uniformly weak matching.
 */
export function computeConfidence(input: ConfidenceInput, options: ConfidenceOptions = {}): number {
  const denseWeight = options.denseWeight ?? 0.5;
  const saturation = options.bm25Saturation ?? 6;
  const baselineFraction = options.baselineFraction ?? 0.5;

  const dense = denseStrength(input.dense, baselineFraction);
  const sparse = sparseStrength(input.sparse, baselineFraction, saturation);

  let strength: number;
  if (dense === null && sparse === null) return 0;
  else if (dense === null) strength = sparse as number;
  else if (sparse === null) strength = dense;
  else strength = denseWeight * dense + (1 - denseWeight) * sparse;

  const coverage = clamp01(input.coverage);
  return Math.sqrt(clamp01(strength) * coverage);
}

/**
 * Fraction of the question's content terms present in the best-matching passage.
 *
 * Computed over the top few candidates rather than only rank 1, because the
 * chunk that covers the most of the question is not always the one that scored
 * highest — and for abstention we want to know whether *anything* retrieved
 * accounts for the question.
 */
export function queryCoverage(
  queryTerms: readonly string[],
  candidateTermSets: ReadonlyArray<ReadonlySet<string>>,
): number {
  const unique = new Set(queryTerms);
  if (unique.size === 0) return 0;
  if (candidateTermSets.length === 0) return 0;

  let best = 0;
  for (const terms of candidateTermSets) {
    let hits = 0;
    for (const term of unique) if (terms.has(term)) hits += 1;
    const coverage = hits / unique.size;
    if (coverage > best) best = coverage;
  }
  return best;
}

/** Mean of the lowest-scoring `fraction` of the candidate list. */
function tailMean(scores: readonly number[], fraction: number): number | null {
  if (scores.length < 4) return null;
  const start = Math.max(1, Math.floor(scores.length * (1 - fraction)));
  const tail = scores.slice(start);
  if (tail.length === 0) return null;
  return tail.reduce((sum, s) => sum + s, 0) / tail.length;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function denseStrength(scores: readonly number[], baselineFraction: number): number | null {
  const top = scores[0];
  if (top === undefined) return null;
  if (top <= 0) return 0;
  const baseline = tailMean(scores, baselineFraction);
  // Too few candidates to estimate a baseline: fall back to the raw similarity,
  // which is conservative because it is bounded by 1.
  if (baseline === null) return clamp01(top);
  return clamp01((top - baseline) / top);
}

function sparseStrength(
  scores: readonly number[],
  baselineFraction: number,
  saturation: number,
): number | null {
  const top = scores[0];
  if (top === undefined) return null;
  if (top <= 0) return 0;
  const magnitude = top / (top + saturation);
  const baseline = tailMean(scores, baselineFraction);
  // A short candidate list means the unretrieved documents scored zero, so the
  // margin is 1 by construction and carries no information — lean on magnitude.
  if (baseline === null) return clamp01(magnitude);
  return clamp01(((top - baseline) / top) * magnitude);
}
