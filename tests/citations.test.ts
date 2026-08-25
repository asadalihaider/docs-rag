import { describe, expect, it, vi } from 'vitest';
import { extractCitationMarkers, verifyCitations } from '../src/answer/citations.js';
import { buildContext } from '../src/answer/context.js';
import type { ContextSource } from '../src/answer/context.js';
import type { FusedResult, StoredChunk } from '../src/types.js';
import { createLogger, type Logger } from '../src/util/logger.js';

function storedChunk(
  id: string,
  content: string,
  headingPath: string[] = ['Section'],
): StoredChunk {
  return {
    id,
    documentId: `${id}.md`,
    ordinal: 0,
    headingPath,
    content,
    contentHash: `hash-${id}`,
    tokenCount: 50,
    startLine: 1,
    endLine: 10,
    documentPath: `${id}.md`,
    documentTitle: id,
  };
}

function makeSources(n: number): ContextSource[] {
  return Array.from({ length: n }, (_, i) => {
    const chunk = storedChunk(`doc${i + 1}`, `Content of passage ${i + 1}.`, [
      'Guide',
      `S${i + 1}`,
    ]);
    const result: FusedResult = {
      chunk,
      score: 0.03 - i * 0.001,
      denseScore: 0.7 - i * 0.05,
      denseRank: i + 1,
      sparseScore: 9 - i,
      sparseRank: i + 1,
      rerankScore: null,
    };
    return {
      n: i + 1,
      file: chunk.documentPath,
      headingPath: `${chunk.documentTitle} > ${chunk.headingPath.join(' > ')}`,
      content: chunk.content,
      result,
      tokens: 60,
    };
  });
}

/** Captures warn-level records so the "we logged it" requirement is testable. */
function capturingLogger(): { logger: Logger; warnings: string[] } {
  const warnings: string[] = [];
  const base = createLogger('silent');
  const logger: Logger = {
    ...base,
    warn: (msg, meta) => warnings.push(`${msg} ${JSON.stringify(meta ?? {})}`),
    child: () => logger,
  };
  return { logger, warnings };
}

describe('extractCitationMarkers', () => {
  it('finds every marker in order', () => {
    expect(extractCitationMarkers('a [^2] b [^1] c [^2]')).toEqual([2, 1, 2]);
    expect(extractCitationMarkers('no markers here')).toEqual([]);
  });
});

describe('verifyCitations', () => {
  it('keeps valid markers and builds citations from retrieval data, not model output', () => {
    const sources = makeSources(3);
    const result = verifyCitations(
      'Postgres 14 is required. [^1] Workers need a token. [^2]',
      sources,
    );

    expect(result.dropped).toEqual([]);
    expect(result.text).toContain('[^1]');
    expect(result.text).toContain('[^2]');
    expect(result.citations).toHaveLength(2);
    expect(result.citations[0]).toMatchObject({
      n: 1,
      file: 'doc1.md',
      headingPath: 'Guide > S1',
      chunkId: 'doc1',
    });
    expect(result.citations[0]!.excerpt).toBe('Content of passage 1.');
    expect(result.citations[0]!.score).toBeCloseTo(0.03, 12);
  });

  // The headline defence: a marker the model invented must not survive.
  it('strips a citation that maps to no retrieved chunk, and logs it', () => {
    const sources = makeSources(3);
    const { logger, warnings } = capturingLogger();

    const result = verifyCitations(
      'Grounded claim. [^1] Invented claim. [^7] Another grounded claim. [^2]',
      sources,
      { logger },
    );

    expect(result.dropped).toEqual([7]);
    expect(result.text).not.toContain('[^7]');
    expect(result.text).toContain('Invented claim.');
    expect(result.citations.map((c) => c.chunkId)).toEqual(['doc1', 'doc2']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('stripped unverifiable citation markers');
    expect(warnings[0]).toContain('"dropped":[7]');
    expect(warnings[0]).toContain('1-3');
  });

  it('strips every marker when nothing was retrieved', () => {
    const result = verifyCitations('Fully invented. [^1] [^2]', []);
    expect(result.dropped).toEqual([1, 2]);
    expect(result.citations).toEqual([]);
    expect(result.text).toBe('Fully invented.');
  });

  it('renumbers survivors densely, in order of first appearance', () => {
    const sources = makeSources(5);
    const result = verifyCitations('First. [^4] Second. [^2] Third, same source. [^4]', sources);

    expect(result.text).toBe('First. [^1] Second. [^2] Third, same source. [^1]');
    expect(result.citations).toHaveLength(2);
    expect(result.citations[0]).toMatchObject({ n: 1, chunkId: 'doc4' });
    expect(result.citations[1]).toMatchObject({ n: 2, chunkId: 'doc2' });
  });

  it('handles a swap without clobbering, and never mistakes prose numbers for markers', () => {
    const sources = makeSources(2);
    const result = verifyCitations(
      'Retries default to 3 attempts over 2 minutes. [^2] The port is 7842. [^1]',
      sources,
    );
    expect(result.text).toBe(
      'Retries default to 3 attempts over 2 minutes. [^1] The port is 7842. [^2]',
    );
    expect(result.citations.map((c) => c.chunkId)).toEqual(['doc2', 'doc1']);
  });

  it('can be told not to renumber', () => {
    const sources = makeSources(5);
    const result = verifyCitations('Claim. [^4]', sources, { renumber: false });
    expect(result.text).toBe('Claim. [^4]');
    expect(result.citations[0]).toMatchObject({ n: 4, chunkId: 'doc4' });
  });

  it('removes footnote definition blocks the model adds despite instructions', () => {
    const sources = makeSources(2);
    const result = verifyCitations(
      ['Answer text. [^1]', '', '[^1]: doc1.md — Guide > S1', '[^2]: doc2.md — Guide > S2'].join(
        '\n',
      ),
      sources,
    );
    expect(result.text).toBe('Answer text. [^1]');
    expect(result.citations).toHaveLength(1);
  });

  it('tidies the whitespace a removed marker leaves behind', () => {
    const sources = makeSources(1);
    const result = verifyCitations('A sentence [^9] . And another  one. [^1]', sources, {
      logger: createLogger('silent'),
    });
    expect(result.text).toBe('A sentence. And another one. [^1]');
  });

  it('truncates long excerpts', () => {
    const sources = makeSources(1);
    sources[0]!.result.chunk.content = 'word '.repeat(400);
    const result = verifyCitations('Claim. [^1]', sources, { excerptChars: 50 });
    expect(result.citations[0]!.excerpt.length).toBeLessThanOrEqual(51);
    expect(result.citations[0]!.excerpt.endsWith('…')).toBe(true);
  });
});

describe('buildContext', () => {
  const results = (n: number, tokensEach = 100): FusedResult[] =>
    Array.from({ length: n }, (_, i) => ({
      chunk: storedChunk(`c${i}`, 'word '.repeat(tokensEach)),
      score: 1 - i * 0.01,
      denseScore: 0.5,
      denseRank: i + 1,
      sparseScore: 1,
      sparseRank: i + 1,
      rerankScore: null,
    }));

  it('numbers sources from 1 in rank order', () => {
    const context = buildContext(results(3));
    expect(context.sources.map((s) => s.n)).toEqual([1, 2, 3]);
    expect(context.dropped).toEqual([]);
  });

  it('drops the lowest-ranked chunks when over budget', () => {
    const context = buildContext(results(20, 200), { tokenBudget: 1000, headroom: 0 });
    expect(context.sources.length).toBeLessThan(20);
    expect(context.dropped.length).toBeGreaterThan(0);
    expect(context.tokens).toBeLessThanOrEqual(1000);
    // Everything kept outranks everything dropped.
    const worstKept = Math.min(...context.sources.map((s) => s.result.score));
    const bestDropped = Math.max(...context.dropped.map((d) => d.score));
    expect(worstKept).toBeGreaterThan(bestDropped);
  });

  it('caps the source count independently of the budget', () => {
    const context = buildContext(results(20, 5), { tokenBudget: 100_000, maxSources: 4 });
    expect(context.sources).toHaveLength(4);
    expect(context.dropped).toHaveLength(16);
  });

  it('skips one oversized chunk rather than letting it starve the rest', () => {
    const mixed = [
      ...results(1, 5000),
      ...results(3, 20).map((r, i) => ({ ...r, score: 0.5 - i * 0.01 })),
    ];
    const context = buildContext(mixed, { tokenBudget: 900, headroom: 0 });
    expect(context.sources.length).toBe(3);
    expect(context.dropped).toHaveLength(1);
  });

  it('reserves headroom for tokenizer estimation error', () => {
    // maxSources has to be out of the way, or it, not the budget, is the binding constraint.
    const opts = { tokenBudget: 4000, maxSources: 100 };
    const withHeadroom = buildContext(results(50, 100), { ...opts, headroom: 0.15 });
    const without = buildContext(results(50, 100), { ...opts, headroom: 0 });
    expect(withHeadroom.tokens).toBeLessThan(without.tokens);
    expect(withHeadroom.tokens).toBeLessThanOrEqual(4000 * 0.85);
  });

  it('handles an empty candidate list', () => {
    const context = buildContext([]);
    expect(context.sources).toEqual([]);
    expect(context.tokens).toBe(0);
  });
});

describe('logger', () => {
  it('respects the level threshold', () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    const logger = createLogger('warn', { component: 'test' });
    logger.debug('hidden');
    logger.info('also hidden');
    logger.warn('shown', { n: 1 });
    spy.mockRestore();

    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('shown');
    expect(writes[0]).toContain('component=test');
    expect(writes[0]).toContain('n=1');
  });
});
