/**
 * Reciprocal Rank Fusion (Cormack, Clarke & Buettcher, SIGIR 2009).
 *
 *   RRF(d) = Σ_r  w_r / (k + rank_r(d))
 *
 * Why fuse on *rank* rather than on score: dense cosine similarity and BM25
 * live on incompatible scales (roughly [0,1] vs unbounded and corpus-dependent),
 * and normalising them per-query is fragile — min/max normalisation over a
 * short candidate list is dominated by outliers, and z-scores assume a
 * distribution neither retriever actually has. Rank is scale-free, so RRF needs
 * no tuning to stay stable when the corpus changes.
 *
 * `k` (60 in the original paper) damps the influence of the very top ranks: with
 * k = 60 the gap between rank 1 and rank 2 is small, so a document that both
 * retrievers rank highly beats a document that only one retriever loves. Lower
 * k makes the fusion more winner-take-all.
 */
export interface RankedList<T> {
  name: string;
  weight: number;
  /** Items in descending relevance order. */
  items: Array<{ id: string; score: number; item: T }>;
}

export interface FusionEntry<T> {
  id: string;
  item: T;
  score: number;
  /** Per-retriever rank (1-based) and raw score, `null` when that retriever missed the item. */
  contributions: Record<string, { rank: number; score: number } | null>;
}

export function reciprocalRankFusion<T>(
  lists: ReadonlyArray<RankedList<T>>,
  options: { k?: number; limit?: number } = {},
): Array<FusionEntry<T>> {
  const k = options.k ?? 60;
  const names = lists.map((l) => l.name);
  const merged = new Map<string, FusionEntry<T>>();

  for (const list of lists) {
    list.items.forEach((entry, index) => {
      const rank = index + 1;
      let target = merged.get(entry.id);
      if (!target) {
        target = {
          id: entry.id,
          item: entry.item,
          score: 0,
          contributions: Object.fromEntries(names.map((n) => [n, null])),
        };
        merged.set(entry.id, target);
      }
      target.score += list.weight / (k + rank);
      target.contributions[list.name] = { rank, score: entry.score };
    });
  }

  const fused = [...merged.values()].sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
  return options.limit === undefined ? fused : fused.slice(0, options.limit);
}
