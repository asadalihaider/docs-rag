import { describe, expect, it } from 'vitest';
import { Bm25Index } from '../src/retrieval/bm25.js';
import { analyze, stem, termFrequencies } from '../src/retrieval/analyzer.js';

describe('analyzer', () => {
  it('lowercases, drops stopwords and stems conservatively', () => {
    expect(analyze('How do I configure the retries?')).toEqual(['configure', 'retry']);
    expect(analyze('Scheduling jobs')).toEqual(['schedule', 'job']);
  });

  it('emits identifiers both whole and split', () => {
    expect(analyze('larkspur.yaml')).toEqual(['larkspuryaml', 'larkspur', 'yaml']);
    expect(analyze('--dry-run')).toEqual(['dryrun', 'dry', 'run']);
  });

  it('splits camelCase', () => {
    expect(analyze('maxRetries')).toEqual(['max', 'retry']);
  });

  it('refuses to stem short tokens or tokens containing digits', () => {
    expect(stem('bus')).toBe('bus');
    expect(stem('v2s')).toBe('v2s');
    expect(stem('LK-3007'.toLowerCase())).toBe('lk-3007');
  });

  it('counts term frequencies', () => {
    expect([...termFrequencies(['a', 'b', 'a'])]).toEqual([
      ['a', 2],
      ['b', 1],
    ]);
  });
});

describe('Bm25Index', () => {
  /**
   * Correctness is checked against the formula computed by hand rather than
   * against a golden number, so the test documents the maths instead of
   * enshrining whatever the implementation happened to produce.
   */
  it('scores a single-term query exactly as Okapi BM25 specifies', () => {
    const index = new Bm25Index({ k1: 1.2, b: 0.75 });
    // Analysed lengths: doc1 -> [cron, schedule, cron] (3), doc2 -> [cron] (1),
    // doc3 -> [vault, secret] (2).
    index.addAnalyzed('doc1', ['cron', 'schedule', 'cron']);
    index.addAnalyzed('doc2', ['cron']);
    index.addAnalyzed('doc3', ['vault', 'secret']);

    const N = 3;
    const avgdl = (3 + 1 + 2) / 3;
    expect(index.averageDocumentLength).toBeCloseTo(avgdl, 12);

    // df('cron') = 2  =>  idf = ln(1 + (3 - 2 + 0.5) / (2 + 0.5))
    const idf = Math.log(1 + (N - 2 + 0.5) / (2 + 0.5));
    expect(index.idf('cron')).toBeCloseTo(idf, 12);

    const score = (tf: number, dl: number) =>
      (idf * (tf * (1.2 + 1))) / (tf + 1.2 * (1 - 0.75 + (0.75 * dl) / avgdl));

    const hits = index.searchTerms(['cron'], 10);
    expect(hits.map((h) => h.id)).toEqual(['doc2', 'doc1']);
    expect(hits[0]!.score).toBeCloseTo(score(1, 1), 12);
    expect(hits[1]!.score).toBeCloseTo(score(2, 3), 12);

    // Worth stating explicitly: doc2 outranks doc1 despite half the term
    // frequency, because it is a third the length. Length normalisation (b) and
    // tf saturation (k1) together mean raw occurrence counts do not decide the
    // ranking - which is the whole reason BM25 beats naive tf-idf.
    expect(score(1, 1)).toBeGreaterThan(score(2, 3));
  });

  it('saturates term frequency: doubling tf does not double the score', () => {
    const index = new Bm25Index();
    index.addAnalyzed('few', ['cron', 'x', 'x', 'x', 'x', 'x', 'x', 'x', 'x', 'x']);
    index.addAnalyzed(
      'many',
      Array.from({ length: 10 }, (_, i) => (i < 5 ? 'cron' : 'x')),
    );
    index.addAnalyzed('none', ['vault']);

    const [manyHit, fewHit] = index.searchTerms(['cron'], 10);
    expect(manyHit!.id).toBe('many');
    // 5x the term frequency, nowhere near 5x the score.
    expect(manyHit!.score).toBeGreaterThan(fewHit!.score);
    expect(manyHit!.score).toBeLessThan(fewHit!.score * 2);
  });

  it('normalises by document length: a short document beats a long one at equal tf', () => {
    const index = new Bm25Index();
    index.addAnalyzed('short', ['cron', 'filler']);
    index.addAnalyzed('long', ['cron', ...Array.from({ length: 60 }, () => 'filler')]);

    const hits = index.searchTerms(['cron'], 10);
    expect(hits[0]!.id).toBe('short');
  });

  it('keeps IDF non-negative for a term present in every document', () => {
    const index = new Bm25Index();
    index.addAnalyzed('a', ['job']);
    index.addAnalyzed('b', ['job']);
    index.addAnalyzed('c', ['job']);
    // The unsmoothed IDF variant would be negative here and would rank documents
    // *down* for matching. ln(1 + ...) cannot go below zero.
    expect(index.idf('job')).toBeGreaterThan(0);
    expect(index.searchTerms(['job'], 10)).toHaveLength(3);
  });

  it('rewards rarer query terms more than common ones', () => {
    const index = new Bm25Index();
    for (let i = 0; i < 20; i++) index.addAnalyzed(`common-${i}`, ['job', `pad${i}`]);
    index.addAnalyzed('rare', ['job', 'vault']);

    expect(index.idf('vault')).toBeGreaterThan(index.idf('job'));
    const hits = index.searchTerms(['job', 'vault'], 5);
    expect(hits[0]!.id).toBe('rare');
  });

  it('supports incremental add, replace and remove', () => {
    const index = new Bm25Index();
    index.add('a', 'cron scheduling');
    index.add('b', 'vault secrets');
    expect(index.size).toBe(2);

    // Re-adding the same id replaces rather than duplicating.
    index.add('a', 'vault secrets too');
    expect(index.size).toBe(2);
    expect(index.searchTerms(['cron'], 5)).toEqual([]);
    expect(
      index
        .searchTerms(['vault'], 5)
        .map((h) => h.id)
        .sort(),
    ).toEqual(['a', 'b']);

    index.remove('a');
    expect(index.size).toBe(1);
    expect(index.searchTerms(['vault'], 5).map((h) => h.id)).toEqual(['b']);

    index.clear();
    expect(index.size).toBe(0);
    expect(index.searchTerms(['vault'], 5)).toEqual([]);
  });

  it('matches query wording to document wording through the shared analyzer', () => {
    const index = new Bm25Index();
    index.add('sched', 'Larkspur uses five-field cron expressions for scheduling.');
    index.add('other', 'Prometheus metrics are exposed on a separate port.');
    // "How does scheduling work?" -> stems to `schedule`, matching "scheduling".
    expect(index.search('How does scheduling work?', 3)[0]?.id).toBe('sched');
  });

  it('returns an empty result for an empty index or an all-stopword query', () => {
    expect(new Bm25Index().search('anything', 5)).toEqual([]);
    const index = new Bm25Index();
    index.add('a', 'cron');
    expect(index.search('the and of', 5)).toEqual([]);
  });

  it('breaks score ties deterministically by id', () => {
    const index = new Bm25Index();
    index.addAnalyzed('zeta', ['cron']);
    index.addAnalyzed('alpha', ['cron']);
    expect(index.searchTerms(['cron'], 5).map((h) => h.id)).toEqual(['alpha', 'zeta']);
  });
});
