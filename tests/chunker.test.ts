import { describe, expect, it } from 'vitest';
import { parseBlocks } from '../src/ingest/blocks.js';
import { chunkDocument, contextualText } from '../src/ingest/chunker.js';
import { estimateTokens } from '../src/util/tokens.js';
import { makeDoc } from './helpers.js';

const FENCE = '```';

describe('parseBlocks', () => {
  it('keeps a fenced code block intact, including blank lines and headings inside it', () => {
    const md = [
      '# Title',
      '',
      'Intro paragraph.',
      '',
      FENCE + 'yaml',
      'a: 1',
      '',
      '# this is a YAML comment, not a heading',
      'b: 2',
      FENCE,
      '',
      'After.',
    ].join('\n');

    const blocks = parseBlocks(md);
    const code = blocks.filter((b) => b.kind === 'code');

    expect(code).toHaveLength(1);
    expect(code[0]?.text).toContain('a: 1');
    expect(code[0]?.text).toContain('b: 2');
    expect(code[0]?.text).toContain('# this is a YAML comment');
    // The comment line inside the fence must not have become a heading.
    expect(blocks.filter((b) => b.kind === 'heading').map((b) => b.text)).toEqual(['Title']);
  });

  it('does not treat inline backticks as a fence', () => {
    const blocks = parseBlocks('Use `lark apply` to apply a manifest.');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.kind).toBe('text');
  });

  it('handles tilde fences and unterminated fences', () => {
    const tilde = parseBlocks(['~~~js', 'const a = 1;', '~~~'].join('\n'));
    expect(tilde.filter((b) => b.kind === 'code')).toHaveLength(1);

    const unterminated = parseBlocks([FENCE + 'sh', 'echo hi', 'echo bye'].join('\n'));
    expect(unterminated).toHaveLength(1);
    expect(unterminated[0]?.kind).toBe('code');
    expect(unterminated[0]?.text).toContain('echo bye');
  });

  it('recognises setext headings but not thematic breaks', () => {
    const blocks = parseBlocks(
      ['Overview', '========', '', 'Body.', '', '---', '', 'More.'].join('\n'),
    );
    const headings = blocks.filter((b) => b.kind === 'heading');
    expect(headings).toHaveLength(1);
    expect(headings[0]).toMatchObject({ text: 'Overview', level: 1 });
    expect(blocks.filter((b) => b.kind === 'text').map((b) => b.text)).toEqual(['Body.', 'More.']);
  });

  it('keeps a loose list together as one block', () => {
    const blocks = parseBlocks(['- alpha', '', '- beta', '', '- gamma'].join('\n'));
    const text = blocks.filter((b) => b.kind === 'text');
    expect(text).toHaveLength(1);
    expect(text[0]?.text).toContain('alpha');
    expect(text[0]?.text).toContain('gamma');
  });
});

describe('chunkDocument', () => {
  it('carries the full heading path into every chunk', () => {
    const md = [
      '# Guide',
      '',
      'Guide intro that is long enough to survive small-chunk merging on its own. '.repeat(12),
      '',
      '## Installation',
      '',
      'Installation body text repeated to make a substantial chunk. '.repeat(14),
      '',
      '### Docker',
      '',
      'Docker specific body text repeated to make a substantial chunk. '.repeat(14),
      '',
      '## Configuration',
      '',
      'Configuration body text repeated to make a substantial chunk. '.repeat(14),
    ].join('\n');

    const chunks = chunkDocument(makeDoc('guide.md', md));
    const paths = chunks.map((c) => c.headingPath.join(' > '));

    expect(paths).toContain('Guide');
    expect(paths).toContain('Guide > Installation');
    expect(paths).toContain('Guide > Installation > Docker');
    expect(paths).toContain('Guide > Configuration');
    // Popping back to H2 must not leave `Docker` on the stack.
    expect(paths).not.toContain('Guide > Installation > Docker > Configuration');
  });

  it('never splits a code fence across chunks, even an oversized one', () => {
    const bigFence = [
      FENCE + 'yaml',
      ...Array.from({ length: 400 }, (_, i) => `key_${i}: value_${i}`),
      FENCE,
    ].join('\n');
    const md = [
      '# Reference',
      '',
      'Some prose before the fence.',
      '',
      bigFence,
      '',
      'Prose after.',
    ].join('\n');

    const chunks = chunkDocument(makeDoc('ref.md', md), {
      targetTokens: 120,
      maxTokens: 200,
      minTokens: 30,
    });

    const holder = chunks.filter((c) => c.content.includes('key_0: value_0'));
    expect(holder).toHaveLength(1);
    // The strongest possible statement: the fence survives verbatim, in one piece.
    expect(holder[0]?.content).toContain(bigFence);
    // And no chunk anywhere holds an unbalanced number of fence markers.
    for (const chunk of chunks) {
      expect((chunk.content.match(/```/g) ?? []).length % 2).toBe(0);
    }
    // The chunk is allowed to exceed maxTokens - an atomic fence outranks the budget.
    expect(estimateTokens(holder[0]!.content)).toBeGreaterThan(200);
  });

  it('overlaps consecutive chunks within a section but never across a heading', () => {
    const paragraphs = Array.from(
      { length: 14 },
      (_, i) =>
        `Paragraph ${i} about scheduling behaviour and how the control plane materialises runs.`,
    );
    const md = [
      '# Scheduling',
      '',
      ...paragraphs.flatMap((p) => [p, '']),
      '## Secrets',
      '',
      'Secrets are resolved at run start and never cached between runs of a job. '.repeat(6),
    ].join('\n');

    const chunks = chunkDocument(makeDoc('sched.md', md), {
      targetTokens: 60,
      maxTokens: 100,
      minTokens: 20,
      overlapTokens: 30,
    });

    const scheduling = chunks.filter((c) => c.headingPath.join() === 'Scheduling');
    expect(scheduling.length).toBeGreaterThan(2);

    // Consecutive chunks in the same section share at least one paragraph.
    const first = scheduling[0]!;
    const second = scheduling[1]!;
    const tailParagraph = first.content.split('\n\n').at(-1)!;
    expect(second.content).toContain(tailParagraph);

    // `## Secrets` nests under `# Scheduling`, so the path is the full ancestry.
    const secrets = chunks.filter((c) => c.headingPath.at(-1) === 'Secrets');
    expect(secrets.length).toBeGreaterThan(0);
    expect(secrets[0]?.headingPath).toEqual(['Scheduling', 'Secrets']);
    // Overlap must not leak across the section boundary.
    for (const chunk of secrets) {
      expect(chunk.content).not.toContain('Paragraph 13');
    }
  });

  it('honours overlapTokens: 0 by producing no shared text', () => {
    const paragraphs = Array.from({ length: 10 }, (_, i) => `Distinct paragraph number ${i} here.`);
    const md = ['# Section', '', ...paragraphs.flatMap((p) => [p, ''])].join('\n');

    const chunks = chunkDocument(makeDoc('a.md', md), {
      targetTokens: 30,
      maxTokens: 60,
      minTokens: 10,
      overlapTokens: 0,
    });

    expect(chunks.length).toBeGreaterThan(1);
    const joined = chunks.map((c) => c.content).join('\n');
    for (const paragraph of paragraphs) {
      expect(joined.split(paragraph).length - 1).toBe(1);
    }
  });

  it('merges a stub section into its neighbour and keeps a truthful heading path', () => {
    const md = [
      '# API',
      '',
      'Tiny intro.',
      '',
      '## Jobs',
      '',
      'Short.',
      '',
      '## Runs',
      '',
      'Also short.',
    ].join('\n');

    const chunks = chunkDocument(makeDoc('api.md', md), { minTokens: 200, targetTokens: 400 });

    expect(chunks).toHaveLength(1);
    // Merging siblings must fall back to the shared ancestor, never claim one sibling.
    expect(chunks[0]?.headingPath).toEqual(['API']);
    expect(chunks[0]?.content).toContain('Tiny intro.');
    expect(chunks[0]?.content).toContain('Also short.');
  });

  it('does not merge past maxTokens', () => {
    const body = 'Sentence with a reasonable amount of words in it. '.repeat(40);
    const md = ['# One', '', body, '', '# Two', '', body].join('\n');
    const chunks = chunkDocument(makeDoc('b.md', md), {
      targetTokens: 200,
      maxTokens: 260,
      minTokens: 190,
    });
    for (const chunk of chunks) {
      expect(estimateTokens(chunk.content)).toBeLessThanOrEqual(300);
    }
  });

  it('produces stable ids and content hashes, and rehashes when the heading path changes', () => {
    const body = 'Body text that is long enough to stand alone as a chunk. '.repeat(10);
    const a = chunkDocument(makeDoc('x.md', ['# Alpha', '', body].join('\n')));
    const b = chunkDocument(makeDoc('x.md', ['# Alpha', '', body].join('\n')));
    const c = chunkDocument(makeDoc('x.md', ['# Beta', '', body].join('\n')));

    expect(a[0]?.id).toBe('x.md#0');
    expect(a[0]?.contentHash).toBe(b[0]?.contentHash);
    // Same prose, different section: retrieval-relevant change, so a new hash.
    expect(a[0]?.contentHash).not.toBe(c[0]?.contentHash);
  });

  it('records a line span that points back into the source', () => {
    const md = ['# Title', '', 'First paragraph.', '', '## Sub', '', 'Second paragraph.'].join(
      '\n',
    );
    const chunks = chunkDocument(makeDoc('lines.md', md), { minTokens: 1, targetTokens: 20 });
    for (const chunk of chunks) {
      expect(chunk.startLine).toBeGreaterThanOrEqual(1);
      expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine);
      expect(chunk.endLine).toBeLessThanOrEqual(md.split('\n').length);
    }
  });
});

describe('contextualText', () => {
  it('prefixes the document title and heading breadcrumb', () => {
    const text = contextualText({
      documentTitle: 'Installation',
      headingPath: ['Prerequisites', 'Docker'],
      content: 'You need Postgres 14.',
    });
    expect(text).toBe('Installation > Prerequisites > Docker\n\nYou need Postgres 14.');
  });

  it('degrades gracefully with no heading path', () => {
    expect(contextualText({ headingPath: [], content: 'Body' })).toBe('Body');
  });
});
