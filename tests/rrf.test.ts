import { describe, expect, it } from 'vitest';
import { reciprocalRankFusion, type RankedList } from '../src/retrieval/rrf.js';
import { computeConfidence, queryCoverage } from '../src/retrieval/confidence.js';
import { parseRerankScores } from '../src/retrieval/rerank.js';

const list = (
  name: string,
  weight: number,
  ids: string[],
  scores?: number[],
): RankedList<string> => ({
  name,
  weight,
  items: ids.map((id, i) => ({ id, score: scores?.[i] ?? 1 - i * 0.1, item: id })),
});

describe('reciprocalRankFusion', () => {
  it('ranks a document agreed on by both retrievers above a document either loves alone', () => {
    const fused = reciprocalRankFusion([
      list('dense', 1, ['agreed', 'dense-only', 'c']),
      list('sparse', 1, ['sparse-only', 'agreed', 'd']),
    ]);

    // agreed: 1/61 + 1/62 = 0.032523...
    // dense-only: 1/62 = 0.016129...
    // sparse-only: 1/61 = 0.016393...
    expect(fused[0]!.id).toBe('agreed');
    expect(fused[0]!.score).toBeCloseTo(1 / 61 + 1 / 62, 12);
    expect(fused.map((f) => f.id)).toEqual(['agreed', 'sparse-only', 'dense-only', 'c', 'd']);
  });

  it('fuses on rank, so an unbounded raw score cannot dominate', () => {
    // BM25 scores are unbounded; cosine similarity is not. Score-space fusion
    // would let the sparse list win outright here. Rank-space fusion does not.
    const fused = reciprocalRankFusion([
      list('dense', 1, ['a', 'b'], [0.91, 0.9]),
      list('sparse', 1, ['b', 'a'], [412.5, 3.1]),
    ]);
    expect(fused[0]!.score).toBeCloseTo(fused[1]!.score, 12);
    // Perfectly symmetric input: the tie-break by id keeps the order stable.
    expect(fused.map((f) => f.id)).toEqual(['a', 'b']);
  });

  it('applies weights, and a zero weight silences a retriever', () => {
    const weighted = reciprocalRankFusion([
      list('dense', 3, ['dense-top', 'x']),
      list('sparse', 1, ['sparse-top', 'y']),
    ]);
    expect(weighted[0]!.id).toBe('dense-top');
    expect(weighted[0]!.score).toBeCloseTo(3 / 61, 12);

    const silenced = reciprocalRankFusion([
      list('dense', 0, ['dense-top']),
      list('sparse', 1, ['sparse-top']),
    ]);
    expect(silenced[0]!.id).toBe('sparse-top');
    expect(silenced.find((f) => f.id === 'dense-top')!.score).toBe(0);
  });

  it('makes k control how winner-take-all the fusion is', () => {
    const lists: RankedList<string>[] = [
      list('dense', 1, ['first', 'second']),
      list('sparse', 1, ['second', 'first']),
    ];
    // Symmetric input scores identically at any k; asymmetric input does not.
    const asymmetric: RankedList<string>[] = [
      list('dense', 1, ['a', 'b', 'c']),
      list('sparse', 1, ['b', 'c', 'a']),
    ];
    const wide = reciprocalRankFusion(asymmetric, { k: 60 });
    const narrow = reciprocalRankFusion(asymmetric, { k: 1 });

    const spread = (r: Array<{ score: number }>) => r[0]!.score - r[r.length - 1]!.score;
    expect(spread(narrow) / narrow[0]!.score).toBeGreaterThan(spread(wide) / wide[0]!.score);
    expect(reciprocalRankFusion(lists, { k: 60 })[0]!.score).toBeCloseTo(
      reciprocalRankFusion(lists, { k: 60 })[1]!.score,
      12,
    );
  });

  it('preserves per-retriever provenance so fusion stays inspectable', () => {
    const fused = reciprocalRankFusion([
      list('dense', 1, ['a', 'b'], [0.82, 0.55]),
      list('sparse', 1, ['b'], [14.2]),
    ]);

    const a = fused.find((f) => f.id === 'a')!;
    const b = fused.find((f) => f.id === 'b')!;
    expect(a.contributions['dense']).toEqual({ rank: 1, score: 0.82 });
    expect(a.contributions['sparse']).toBeNull();
    expect(b.contributions['dense']).toEqual({ rank: 2, score: 0.55 });
    expect(b.contributions['sparse']).toEqual({ rank: 1, score: 14.2 });
  });

  it('honours the limit and handles empty input', () => {
    expect(reciprocalRankFusion([list('dense', 1, ['a', 'b', 'c'])], { limit: 2 })).toHaveLength(2);
    expect(reciprocalRankFusion([])).toEqual([]);
    expect(reciprocalRankFusion([list('dense', 1, [])])).toEqual([]);
  });
});

describe('computeConfidence', () => {
  // A realistic candidate list: one strong match above a tail of mediocre ones.
  const peaked = [0.72, 0.51, 0.44, 0.41, 0.39, 0.38, 0.37, 0.36];
  // A flat list: nothing stands out, which is what an off-topic query looks like.
  const flat = [0.42, 0.41, 0.41, 0.4, 0.4, 0.39, 0.39, 0.38];

  it('returns 0 when nothing was retrieved', () => {
    expect(computeConfidence({ dense: [], sparse: [], coverage: 1 })).toBe(0);
  });

  it('returns 0 when the best passage covers none of the question', () => {
    expect(computeConfidence({ dense: peaked, sparse: [], coverage: 0 })).toBe(0);
  });

  // The core property: a peaked candidate distribution beats a flat one even
  // when the flat one has comparable absolute scores.
  it('scores a peaked candidate list far above a flat one', () => {
    const strong = computeConfidence({ dense: peaked, sparse: [], coverage: 1 });
    const weak = computeConfidence({ dense: flat, sparse: [], coverage: 1 });
    // Note the absolute cosines barely differ (0.72 vs 0.42 top, ~0.38 tail in
    // both) - it is the *shape* that separates them, which is the whole point.
    expect(strong).toBeGreaterThan(0.6);
    expect(weak).toBeLessThan(0.3);
    expect(strong).toBeGreaterThan(weak * 2.5);
  });

  it('is invariant to a constant shift in the model baseline', () => {
    // The same shape 0.2 higher - what a different embedding model looks like.
    const shifted = peaked.map((s) => Math.min(1, s + 0.2));
    const a = computeConfidence({ dense: peaked, sparse: [], coverage: 1 });
    const b = computeConfidence({ dense: shifted, sparse: [], coverage: 1 });
    // An absolute-threshold scheme would rate these wildly differently.
    expect(Math.abs(a - b)).toBeLessThan(0.2);
  });

  it('damps a single weak lexical hit via the BM25 magnitude term', () => {
    // One rare word matching one short chunk: perfect margin, tiny magnitude.
    const single = computeConfidence({ dense: [], sparse: [3.2], coverage: 1 });
    const solid = computeConfidence({ dense: [], sparse: [24, 6, 5, 4], coverage: 1 });
    expect(single).toBeLessThan(solid);
  });

  it('scales with coverage, so partial-question matches score lower', () => {
    const full = computeConfidence({ dense: peaked, sparse: [], coverage: 1 });
    const partial = computeConfidence({ dense: peaked, sparse: [], coverage: 0.25 });
    expect(partial).toBeLessThan(full);
    // Geometric mean: quartering coverage halves confidence.
    expect(partial).toBeCloseTo(full / 2, 6);
  });

  it('stays within [0, 1] for degenerate input', () => {
    expect(computeConfidence({ dense: [-0.4, -0.5, -0.6, -0.7], sparse: [], coverage: 1 })).toBe(0);
    expect(
      computeConfidence({ dense: [], sparse: [1e6, 0, 0, 0], coverage: 1 }),
    ).toBeLessThanOrEqual(1);
    expect(
      computeConfidence({ dense: [1, 0, 0, 0], sparse: [1e6, 0, 0, 0], coverage: 2 }),
    ).toBeLessThanOrEqual(1);
  });

  it('blends both retrievers when both returned candidates', () => {
    const denseOnly = computeConfidence({ dense: peaked, sparse: [], coverage: 1 });
    const sparseOnly = computeConfidence({ dense: [], sparse: [24, 6, 5, 4], coverage: 1 });
    const both = computeConfidence({ dense: peaked, sparse: [24, 6, 5, 4], coverage: 1 });
    expect(both).toBeGreaterThan(Math.min(denseOnly, sparseOnly));
    expect(both).toBeLessThan(Math.max(denseOnly, sparseOnly));
  });
});

describe('queryCoverage', () => {
  it('measures how much of the question the best passage accounts for', () => {
    const terms = ['cron', 'expression', 'field'];
    expect(queryCoverage(terms, [new Set(['cron', 'expression', 'field'])])).toBe(1);
    expect(queryCoverage(terms, [new Set(['cron'])])).toBeCloseTo(1 / 3, 12);
    expect(queryCoverage(terms, [new Set(['vault'])])).toBe(0);
  });

  it('takes the best candidate, not the first', () => {
    const terms = ['cron', 'expression'];
    expect(queryCoverage(terms, [new Set(['cron']), new Set(['cron', 'expression'])])).toBe(1);
  });

  it('deduplicates repeated query terms', () => {
    expect(queryCoverage(['cron', 'cron', 'field'], [new Set(['cron'])])).toBeCloseTo(0.5, 12);
  });

  it('returns 0 for an empty query or no candidates', () => {
    expect(queryCoverage([], [new Set(['cron'])])).toBe(0);
    expect(queryCoverage(['cron'], [])).toBe(0);
  });
});

describe('parseRerankScores', () => {
  it('parses the documented line format', () => {
    expect([...parseRerankScores('1: 9\n2: 4\n3: 0', 3)]).toEqual([
      [1, 9],
      [2, 4],
      [3, 0],
    ]);
  });

  it('tolerates the decorations models add anyway', () => {
    const parsed = parseRerankScores('- [1]: 10/10\n* 2 - 7\nrubbish\n3. 3', 3);
    expect(parsed.get(1)).toBe(10);
    expect(parsed.get(2)).toBe(7);
    expect(parsed.get(3)).toBe(3);
  });

  it('discards out-of-range indices and scores', () => {
    const parsed = parseRerankScores('1: 9\n7: 8\n2: 44', 3);
    expect([...parsed]).toEqual([[1, 9]]);
  });

  it('returns nothing for unparseable output, which is the signal to keep fused order', () => {
    expect(parseRerankScores('I cannot rate these passages.', 5).size).toBe(0);
  });
});
