import { analyze, termFrequencies } from './analyzer.js';

/**
 * Okapi BM25, implemented directly.
 *
 * score(D, Q) = Σ_{t ∈ Q}  IDF(t) · ( f(t,D) · (k1 + 1) )
 *                          ---------------------------------------------
 *                          ( f(t,D) + k1 · (1 − b + b · |D| / avgdl) )
 *
 * with the "probabilistic IDF with +1 smoothing" variant used by Lucene:
 *
 *   IDF(t) = ln( 1 + (N − n(t) + 0.5) / (n(t) + 0.5) )
 *
 * The +1 inside the log keeps IDF non-negative even for terms that appear in
 * more than half the corpus — the unsmoothed form goes negative there and lets
 * a common term actively push a document *down* the ranking, which is a
 * classic source of "why did BM25 rank that last?" confusion on small corpora
 * like a documentation set.
 *
 * `k1` controls term-frequency saturation (how quickly repeated occurrences
 * stop helping); `b` controls length normalisation (0 = ignore document
 * length, 1 = fully normalise). 1.2 / 0.75 are the standard defaults.
 */
export interface Bm25Options {
  k1?: number;
  b?: number;
}

export interface Bm25Document {
  id: string;
  text: string;
}

interface Posting {
  docId: string;
  tf: number;
}

export interface Bm25Hit {
  id: string;
  score: number;
}

export class Bm25Index {
  private readonly k1: number;
  private readonly b: number;

  /** term -> postings list */
  private readonly postings = new Map<string, Posting[]>();
  /** docId -> document length in terms */
  private readonly lengths = new Map<string, number>();
  private totalLength = 0;

  constructor(options: Bm25Options = {}) {
    this.k1 = options.k1 ?? 1.2;
    this.b = options.b ?? 0.75;
  }

  get size(): number {
    return this.lengths.size;
  }

  get averageDocumentLength(): number {
    return this.lengths.size === 0 ? 0 : this.totalLength / this.lengths.size;
  }

  /** Add a document. Re-adding the same id replaces the previous version. */
  add(id: string, text: string): void {
    this.remove(id);
    const terms = analyze(text);
    this.addAnalyzed(id, terms);
  }

  /** Add a document whose terms have already been analysed (used by stores). */
  addAnalyzed(id: string, terms: readonly string[]): void {
    this.remove(id);
    const tf = termFrequencies(terms);
    for (const [term, count] of tf) {
      let list = this.postings.get(term);
      if (!list) {
        list = [];
        this.postings.set(term, list);
      }
      list.push({ docId: id, tf: count });
    }
    this.lengths.set(id, terms.length);
    this.totalLength += terms.length;
  }

  remove(id: string): void {
    const length = this.lengths.get(id);
    if (length === undefined) return;
    this.lengths.delete(id);
    this.totalLength -= length;
    for (const [term, list] of this.postings) {
      const next = list.filter((p) => p.docId !== id);
      if (next.length === 0) this.postings.delete(term);
      else if (next.length !== list.length) this.postings.set(term, next);
    }
  }

  clear(): void {
    this.postings.clear();
    this.lengths.clear();
    this.totalLength = 0;
  }

  /** Inverse document frequency for a term, Lucene-style smoothed. */
  idf(term: string): number {
    const n = this.postings.get(term)?.length ?? 0;
    const N = this.lengths.size;
    return Math.log(1 + (N - n + 0.5) / (n + 0.5));
  }

  /** Score every document that contains at least one query term. */
  search(query: string, k: number): Bm25Hit[] {
    return this.searchTerms(analyze(query), k);
  }

  searchTerms(queryTerms: readonly string[], k: number): Bm25Hit[] {
    if (this.lengths.size === 0) return [];
    const avgdl = this.averageDocumentLength;
    const scores = new Map<string, number>();

    // Query-side term frequency matters for repeated terms in long questions.
    const qtf = termFrequencies(queryTerms);

    for (const [term, queryCount] of qtf) {
      const list = this.postings.get(term);
      if (!list || list.length === 0) continue;
      const idf = this.idf(term);
      if (idf <= 0) continue;
      for (const posting of list) {
        const dl = this.lengths.get(posting.docId) ?? 0;
        const denominator = posting.tf + this.k1 * (1 - this.b + (this.b * dl) / (avgdl || 1));
        const contribution = (idf * (posting.tf * (this.k1 + 1))) / denominator;
        scores.set(posting.docId, (scores.get(posting.docId) ?? 0) + contribution * queryCount);
      }
    }

    return [...scores.entries()]
      .map(([id, score]) => ({ id, score }))
      .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
      .slice(0, k);
  }
}
