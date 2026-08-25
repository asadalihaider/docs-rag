import { performance } from 'node:perf_hooks';
import type { Embedder, FusedResult, StoredChunk, VectorStore } from '../types.js';
import { analyze, analyzeUnique } from './analyzer.js';
import { reciprocalRankFusion } from './rrf.js';
import { computeConfidence, queryCoverage } from './confidence.js';
import { contextualText } from '../ingest/chunker.js';

export interface HybridRetrieverOptions {
  embedder: Embedder;
  store: VectorStore;
  /** How many candidates each retriever contributes before fusion. */
  candidateK?: number;
  /** RRF weights. Set `sparseWeight: 0` for pure dense, `denseWeight: 0` for pure BM25. */
  denseWeight?: number;
  sparseWeight?: number;
  /** RRF damping constant. */
  rrfK?: number;
}

export interface RetrieveResult {
  results: FusedResult[];
  timings: { embedMs: number; searchMs: number };
  embeddingTokens: number;
  queryTerms: string[];
  /**
   * Abstention signal in [0, 1], computed from the *full* candidate lists rather
   * than the truncated fused output — the tail of the candidate list is what
   * makes the top result's margin measurable, so it must not be sliced away
   * before confidence is computed.
   */
  confidence: number;
}

/**
 * Hybrid dense + sparse retrieval fused with Reciprocal Rank Fusion.
 *
 * Both retrievers run over the same chunk corpus and each returns `candidateK`
 * results; fusion then produces the final ordering. Deliberately *not* a
 * cascade (BM25 filter → vector rerank): a cascade can only lose recall, and
 * the whole point of the hybrid is that the two retrievers fail on different
 * queries. BM25 nails exact identifiers, flag names and error codes that an
 * embedding smooths away; dense search handles paraphrase.
 */
export class HybridRetriever {
  private readonly embedder: Embedder;
  private readonly store: VectorStore;
  private readonly candidateK: number;
  private readonly denseWeight: number;
  private readonly sparseWeight: number;
  private readonly rrfK: number;

  constructor(options: HybridRetrieverOptions) {
    this.embedder = options.embedder;
    this.store = options.store;
    this.candidateK = options.candidateK ?? 30;
    this.denseWeight = options.denseWeight ?? 1;
    this.sparseWeight = options.sparseWeight ?? 1;
    this.rrfK = options.rrfK ?? 60;
  }

  async retrieve(query: string, limit: number): Promise<RetrieveResult> {
    const queryTerms = analyze(query);

    const embedStart = performance.now();
    const wantDense = this.denseWeight > 0;
    const embedding = wantDense ? await this.embedder.embed([query]) : { vectors: [], tokens: 0 };
    const embedMs = performance.now() - embedStart;

    const searchStart = performance.now();
    const [dense, sparse] = await Promise.all([
      wantDense && embedding.vectors[0]
        ? this.store.denseSearch(embedding.vectors[0], this.candidateK)
        : Promise.resolve([]),
      this.sparseWeight > 0
        ? this.store.sparseSearch(queryTerms, this.candidateK)
        : Promise.resolve([]),
    ]);
    const searchMs = performance.now() - searchStart;

    const fused = reciprocalRankFusion<StoredChunk>(
      [
        {
          name: 'dense',
          weight: this.denseWeight,
          items: dense.map((d) => ({ id: d.chunk.id, score: d.score, item: d.chunk })),
        },
        {
          name: 'sparse',
          weight: this.sparseWeight,
          items: sparse.map((s) => ({ id: s.chunk.id, score: s.score, item: s.chunk })),
        },
      ],
      { k: this.rrfK, limit },
    );

    const results: FusedResult[] = fused.map((entry) => ({
      chunk: entry.item,
      score: entry.score,
      denseScore: entry.contributions['dense']?.score ?? null,
      denseRank: entry.contributions['dense']?.rank ?? null,
      sparseScore: entry.contributions['sparse']?.score ?? null,
      sparseRank: entry.contributions['sparse']?.rank ?? null,
      rerankScore: null,
    }));

    const confidence = computeConfidence({
      dense: dense.map((d) => d.score),
      sparse: sparse.map((s) => s.score),
      // Coverage is measured over the best few fused candidates, whichever
      // retriever found them.
      coverage: queryCoverage(
        queryTerms,
        results.slice(0, 5).map((r) => new Set(analyzeUnique(contextualText(r.chunk)))),
      ),
    });

    return {
      results,
      timings: { embedMs, searchMs },
      embeddingTokens: embedding.tokens,
      queryTerms,
      confidence,
    };
  }
}
