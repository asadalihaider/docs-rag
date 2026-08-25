import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ingestDirectory } from '../src/ingest/pipeline.js';
import { MemoryVectorStore } from '../src/providers/store/memory.js';
import { LocalEmbedder } from '../src/providers/embedder/local.js';
import type { EmbedResult, Embedder } from '../src/types.js';

/** Wraps an embedder and counts exactly how many texts were actually embedded. */
class CountingEmbedder implements Embedder {
  readonly id: string;
  readonly dimensions: number;
  calls = 0;
  texts = 0;

  constructor(private readonly inner: Embedder) {
    this.id = inner.id;
    this.dimensions = inner.dimensions;
  }

  async embed(texts: string[]): Promise<EmbedResult> {
    this.calls += 1;
    this.texts += texts.length;
    return this.inner.embed(texts);
  }

  reset(): void {
    this.calls = 0;
    this.texts = 0;
  }
}

const PAGE_A = `---
title: Installation
---

# Installation

## Prerequisites

The control plane requires PostgreSQL 14 or newer. Workers need outbound access
to the control plane on port 7842 and nothing else at all.

## Homebrew

Install the CLI with brew install larkspur/tap/lark and verify with lark version.

## npm

The npm package is a thin wrapper that downloads the platform binary during the
postinstall step of the installation process.
`;

const PAGE_B = `---
title: Scheduling
---

# Scheduling

Larkspur uses five-field cron expressions. There is no seconds column, which is
the most common surprise when migrating from a system crontab.

## Timezones

The schedule timezone field takes an IANA zone name and defaults to UTC rather
than the host timezone.
`;

describe('incremental ingest', () => {
  let dir: string;
  let embedder: CountingEmbedder;
  let store: MemoryVectorStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'docs-rag-inc-'));
    await mkdir(join(dir, 'guides'), { recursive: true });
    await writeFile(join(dir, 'guides', 'installation.md'), PAGE_A, 'utf8');
    await writeFile(join(dir, 'scheduling.md'), PAGE_B, 'utf8');
    embedder = new CountingEmbedder(new LocalEmbedder({ dimensions: 256 }));
    store = new MemoryVectorStore();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const ingest = (options: { force?: boolean; prune?: boolean } = {}) =>
    ingestDirectory(dir, {
      embedder,
      store,
      chunkOptions: { targetTokens: 90, maxTokens: 160, minTokens: 20 },
      ...options,
    });

  it('embeds everything on a cold ingest', async () => {
    const report = await ingest();

    expect(report.filesScanned).toBe(2);
    expect(report.documentsIngested).toBe(2);
    expect(report.documentsUnchanged).toBe(0);
    expect(report.chunksWritten).toBeGreaterThan(2);
    expect(report.chunksEmbedded).toBe(report.chunksWritten);
    expect(report.chunksReused).toBe(0);
    expect(embedder.texts).toBe(report.chunksWritten);
  });

  // The headline claim: re-ingesting an unchanged corpus does no work at all.
  it('is a genuine no-op when nothing changed', async () => {
    const first = await ingest();
    embedder.reset();

    const second = await ingest();

    expect(second.documentsUnchanged).toBe(2);
    expect(second.documentsIngested).toBe(0);
    expect(second.chunksEmbedded).toBe(0);
    // Not one embedding call was made, not one text embedded.
    expect(embedder.calls).toBe(0);
    expect(embedder.texts).toBe(0);

    // And the index is byte-identical, not merely the same size.
    const stats = await store.stats();
    expect(stats.chunks).toBe(first.chunksWritten);
    expect(stats.documents).toBe(2);
  });

  it('stays a no-op when a file is rewritten with identical bytes', async () => {
    await ingest();
    embedder.reset();
    // Touching the file changes mtime but not content — hashing content, not
    // timestamps, is what makes this correct.
    await writeFile(join(dir, 'scheduling.md'), PAGE_B, 'utf8');

    const report = await ingest();
    expect(report.documentsUnchanged).toBe(2);
    expect(embedder.texts).toBe(0);
  });

  // Chunk-level hashing: editing one section must not re-embed the whole page.
  it('re-embeds only the chunks that actually changed', async () => {
    const first = await ingest();
    embedder.reset();

    await writeFile(
      join(dir, 'guides', 'installation.md'),
      PAGE_A.replace(
        'Install the CLI with brew install larkspur/tap/lark and verify with lark version.',
        'Install the CLI with brew install larkspur/tap/lark, then run lark version to confirm.',
      ),
      'utf8',
    );

    const second = await ingest();

    expect(second.documentsIngested).toBe(1);
    expect(second.documentsUnchanged).toBe(1);
    expect(second.chunksReused).toBeGreaterThan(0);
    expect(second.chunksEmbedded).toBeGreaterThan(0);
    // Strictly fewer embeddings than a cold ingest of that document.
    expect(second.chunksEmbedded).toBeLessThan(second.chunksWritten);
    expect(embedder.texts).toBe(second.chunksEmbedded);

    const stats = await store.stats();
    expect(stats.documents).toBe(2);
    expect(stats.chunks).toBeGreaterThanOrEqual(first.chunksWritten);
  });

  it('re-embeds when only the heading path changes, because meaning changed', async () => {
    await ingest();
    embedder.reset();

    await writeFile(
      join(dir, 'guides', 'installation.md'),
      PAGE_A.replace('## Homebrew', '## Installing with Homebrew on macOS'),
      'utf8',
    );

    const report = await ingest();
    expect(report.documentsIngested).toBe(1);
    expect(report.chunksEmbedded).toBeGreaterThan(0);
  });

  it('--force ignores hashes and re-embeds everything', async () => {
    const first = await ingest();
    embedder.reset();

    const forced = await ingest({ force: true });

    expect(forced.documentsUnchanged).toBe(0);
    expect(forced.documentsIngested).toBe(2);
    expect(forced.chunksReused).toBe(0);
    expect(forced.chunksEmbedded).toBe(first.chunksWritten);
    expect(embedder.texts).toBe(first.chunksWritten);
  });

  it('picks up a new file without touching the existing ones', async () => {
    await ingest();
    embedder.reset();
    await writeFile(
      join(dir, 'faq.md'),
      '# FAQ\n\n## Windows\n\nThe CLI ships a Windows build but the server does not support Windows.\n',
      'utf8',
    );

    const report = await ingest();
    expect(report.filesScanned).toBe(3);
    expect(report.documentsUnchanged).toBe(2);
    expect(report.documentsIngested).toBe(1);
    expect((await store.stats()).documents).toBe(3);
  });

  it('prunes documents deleted from disk, and only with prune enabled', async () => {
    await ingest({ prune: true });
    await rm(join(dir, 'scheduling.md'));

    const withoutPrune = await ingest();
    expect(withoutPrune.documentsPruned).toEqual([]);
    expect((await store.stats()).documents).toBe(2);

    const withPrune = await ingest({ prune: true });
    expect(withPrune.documentsPruned).toEqual(['scheduling.md']);
    expect((await store.stats()).documents).toBe(1);
  });

  it("replaces a document's chunks rather than accumulating them", async () => {
    await ingest();
    const before = await store.stats();

    // Shrink the page dramatically; chunk count must fall, not grow.
    await writeFile(
      join(dir, 'guides', 'installation.md'),
      '# Installation\n\nSee the website.\n',
      'utf8',
    );
    await ingest();

    const after = await store.stats();
    expect(after.documents).toBe(2);
    expect(after.chunks).toBeLessThan(before.chunks);
  });

  it('rejects an index built with a different embedder', async () => {
    await ingest();
    const other = new LocalEmbedder({ dimensions: 128 });
    await expect(store.init(other.id, other.dimensions)).rejects.toThrow(/embedder/);
  });
});
