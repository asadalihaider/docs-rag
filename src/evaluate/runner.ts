import type { RagService } from '../answer/service.js';
import type { EvalQuestion } from './questions.js';

export interface EvalOptions {
  /** Cut-offs reported for recall@k. The largest also sets how deep we retrieve. */
  ks?: number[];
  /** Also generate answers and measure citation precision. */
  measureCitations?: boolean;
  rerank?: boolean;
  onQuestion?: (result: QuestionResult) => void;
}

export interface QuestionResult {
  id: string;
  question: string;
  expectedFiles: string[];
  /** Files of the retrieved chunks, in rank order (may repeat). */
  retrievedFiles: string[];
  /** 1-based rank of the first retrieved chunk from an expected file, or null. */
  firstRelevantRank: number | null;
  /** Rank of the first chunk whose heading path matches `expected_heading`, if given. */
  headingRank: number | null;
  citations: Array<{ file: string; correct: boolean }>;
  refused: boolean;
  confidence: number;
}

export interface EvalMetrics {
  questions: number;
  /** recall@k keyed by k. */
  recallAtK: Record<number, number>;
  mrr: number;
  /** Fraction of emitted citations that point at an expected file (micro-average). */
  citationPrecision: number | null;
  citationsEmitted: number;
  /** Questions where a heading-level expectation was set and met within the top k. */
  headingHitRate: number | null;
  refusals: number;
  meanConfidence: number;
}

export interface EvalReport {
  metrics: EvalMetrics;
  results: QuestionResult[];
}

/**
 * Retrieval + citation evaluation.
 *
 * Metrics, and why these:
 *
 * - **recall@k** — did *any* chunk from an expected file make the top k? This is
 *   the ceiling on answer quality: a generator cannot cite what retrieval never
 *   surfaced. Reported at several k so you can see whether a miss is "not
 *   retrieved" or merely "not ranked first".
 * - **MRR** — mean of 1/rank of the first relevant chunk. Sensitive to ordering
 *   in a way recall is not, which is what matters once a token budget starts
 *   truncating the tail of the context.
 * - **citation precision** — of the citations the answer actually emitted, what
 *   fraction point at a file the question set says is right. This is the metric
 *   that catches a system that retrieves well and then cites the wrong passage,
 *   which recall and MRR are both blind to.
 *
 * Labels are file-level, deliberately. Chunk-level gold labels have to be
 * re-annotated every time the chunker changes, which makes them useless for
 * comparing chunking strategies — the exact thing you most want to A/B.
 */
export async function runEval(
  service: RagService,
  questions: EvalQuestion[],
  options: EvalOptions = {},
): Promise<EvalReport> {
  const ks = (options.ks ?? [1, 3, 5, 10]).slice().sort((a, b) => a - b);
  const maxK = ks[ks.length - 1] ?? 10;
  const measureCitations = options.measureCitations ?? true;

  const results: QuestionResult[] = [];

  for (const question of questions) {
    const expected = new Set(question.expected_files);

    const answer = await service.ask(question.question, {
      topK: maxK,
      retrieveOnly: !measureCitations,
      ...(options.rerank === undefined ? {} : { rerank: options.rerank }),
    });

    const retrievedFiles = answer.retrieved.map((r) => r.chunk.documentPath);
    const firstRelevantRank =
      retrievedFiles.findIndex((file) => expected.has(file)) === -1
        ? null
        : retrievedFiles.findIndex((file) => expected.has(file)) + 1;

    let headingRank: number | null = null;
    if (question.expected_heading) {
      const needle = question.expected_heading.toLowerCase();
      const index = answer.retrieved.findIndex(
        (r) =>
          expected.has(r.chunk.documentPath) &&
          r.chunk.headingPath.join(' > ').toLowerCase().includes(needle),
      );
      headingRank = index === -1 ? null : index + 1;
    }

    const citations = answer.citations.map((c) => ({
      file: c.file,
      correct: expected.has(c.file),
    }));

    const result: QuestionResult = {
      id: question.id,
      question: question.question,
      expectedFiles: question.expected_files,
      retrievedFiles,
      firstRelevantRank,
      headingRank,
      citations,
      refused: answer.refused,
      confidence: answer.confidence,
    };
    results.push(result);
    options.onQuestion?.(result);
  }

  return { metrics: aggregate(results, ks, questions, measureCitations), results };
}

function aggregate(
  results: QuestionResult[],
  ks: number[],
  questions: EvalQuestion[],
  measureCitations: boolean,
): EvalMetrics {
  const n = results.length || 1;

  const recallAtK: Record<number, number> = {};
  for (const k of ks) {
    const hits = results.filter((r) => r.firstRelevantRank !== null && r.firstRelevantRank <= k);
    recallAtK[k] = hits.length / n;
  }

  const mrr =
    results.reduce((sum, r) => sum + (r.firstRelevantRank ? 1 / r.firstRelevantRank : 0), 0) / n;

  const allCitations = results.flatMap((r) => r.citations);
  const citationPrecision =
    !measureCitations || allCitations.length === 0
      ? null
      : allCitations.filter((c) => c.correct).length / allCitations.length;

  const withHeading = questions.filter((q) => q.expected_heading).map((q) => q.id);
  const headingHitRate =
    withHeading.length === 0
      ? null
      : results.filter((r) => withHeading.includes(r.id) && r.headingRank !== null).length /
        withHeading.length;

  return {
    questions: results.length,
    recallAtK,
    mrr,
    citationPrecision,
    citationsEmitted: allCitations.length,
    headingHitRate,
    refusals: results.filter((r) => r.refused).length,
    meanConfidence: results.reduce((sum, r) => sum + r.confidence, 0) / n,
  };
}
