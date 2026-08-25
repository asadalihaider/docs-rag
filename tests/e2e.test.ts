import { fileURLToPath } from 'node:url';
import { describe, expect, it, beforeAll } from 'vitest';
import { ingestDirectory, type IngestReport } from '../src/ingest/pipeline.js';
import { MemoryVectorStore } from '../src/providers/store/memory.js';
import { LocalEmbedder } from '../src/providers/embedder/local.js';
import { MockChat } from '../src/providers/chat/mock.js';
import { RagService } from '../src/answer/service.js';
import { REFUSAL_TEXT } from '../src/answer/prompt.js';

/**
 * End-to-end offline path: real `sample-docs/` corpus, real chunker, real
 * hybrid retriever, real citation verification — the only swapped parts are
 * the ones that would otherwise cost an API key (`LocalEmbedder`, `MockChat`).
 *
 * This is the test that would catch a change which breaks the *system*, as
 * opposed to a unit that breaks one module in isolation: a chunking regression
 * that orphans a heading, a retrieval change that stops finding an obviously
 * relevant page, or a citation-verification change that starts stripping
 * legitimate markers, would all fail a test built on synthetic fixtures far
 * less reliably than they fail this one.
 */
const SAMPLE_DOCS_ROOT = fileURLToPath(new URL('../sample-docs', import.meta.url));

describe('end-to-end over the real sample-docs corpus', () => {
  let service: RagService;
  let report: IngestReport;

  beforeAll(async () => {
    const embedder = new LocalEmbedder({ dimensions: 512 });
    const store = new MemoryVectorStore();

    report = await ingestDirectory(SAMPLE_DOCS_ROOT, { embedder, store });

    service = new RagService({
      embedder,
      store,
      chat: new MockChat(),
      topK: 6,
    });
  }, 30_000);

  it('actually ingested the real corpus, not an empty directory', () => {
    expect(report.filesScanned).toBeGreaterThanOrEqual(18);
    expect(report.documentsIngested).toBe(report.filesScanned);
    expect(report.chunksWritten).toBeGreaterThan(report.filesScanned);
  });

  // eval/questions.jsonl#q07: exact identifiers are the case BM25 nails and a
  // pure embedding tends to smooth away, so this also exercises the hybrid path.
  it('answers an exact-identifier question with a citation into the real error-codes page', async () => {
    const result = await service.ask('What does error LK-3007 mean and what should I do about it?');

    expect(result.refused).toBe(false);
    expect(result.answer).not.toBe(REFUSAL_TEXT);
    expect(result.droppedCitations).toEqual([]);
    expect(result.citations.length).toBeGreaterThan(0);

    // The question set accepts either page; a real system should land on one.
    const expectedFiles = new Set(['reference/error-codes.md', 'ops/troubleshooting.md']);
    expect(result.citations.some((c) => expectedFiles.has(c.file))).toBe(true);

    // The winning citation must carry a real heading path from the real
    // document, and its excerpt must actually contain the error code — this
    // is checking against `sample-docs/reference/error-codes.md` on disk, not
    // a fixture that merely says it does.
    const errorCodesCitation = result.citations.find((c) => c.file === 'reference/error-codes.md');
    if (errorCodesCitation) {
      expect(errorCodesCitation.headingPath.length).toBeGreaterThan(0);
      expect(errorCodesCitation.headingPath).toContain('execution');
      expect(errorCodesCitation.excerpt).toContain('LK-3007');
    } else {
      // At minimum the troubleshooting page's citation must be real and grounded.
      const fallback = result.citations.find((c) => c.file === 'ops/troubleshooting.md');
      expect(fallback?.excerpt.length).toBeGreaterThan(0);
    }
  });

  // eval/questions.jsonl#q18: a whole-page match, and a different corpus page
  // than the previous test, so this is not just re-testing the same chunk.
  it('answers a how-do-I question with a citation into the real docker-compose guide', async () => {
    const result = await service.ask('How do I run the whole thing locally with docker compose?');

    expect(result.refused).toBe(false);
    expect(result.citations.length).toBeGreaterThan(0);
    expect(result.citations.some((c) => c.file === 'guides/deployment-docker.md')).toBe(true);

    const citation = result.citations.find((c) => c.file === 'guides/deployment-docker.md');
    expect(citation?.headingPath).toContain('Deploying with Docker Compose');
  });

  // The same real corpus must still abstain on a question it has no evidence
  // for, so the positive results above are not merely "always cite something".
  it('refuses a question the real corpus has no evidence for', async () => {
    const result = await service.ask(
      'What is the airspeed velocity of an unladen swallow in metres per second?',
    );

    expect(result.refused).toBe(true);
    expect(result.answer).toBe(REFUSAL_TEXT);
    expect(result.citations).toEqual([]);
  });
});
