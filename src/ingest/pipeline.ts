import { performance } from 'node:perf_hooks';
import type { Chunk, EmbeddedChunk, Embedder, SourceDocument, VectorStore } from '../types.js';
import { findMarkdownFiles, loadDocument } from './walk.js';
import { chunkDocument, contextualText, type ChunkOptions } from './chunker.js';
import { batch, mapWithConcurrency } from '../util/pool.js';
import type { Logger } from '../util/logger.js';
import { silentLogger } from '../util/logger.js';

export interface IngestOptions {
  embedder: Embedder;
  store: VectorStore;
  chunkOptions?: ChunkOptions;
  /** Texts per embedding request. */
  embedBatchSize?: number;
  /** Documents processed in parallel. */
  concurrency?: number;
  /** Delete documents in the store that no longer exist on disk. */
  prune?: boolean;
  /** Re-embed everything, ignoring content hashes. */
  force?: boolean;
  logger?: Logger;
  onProgress?: (event: IngestProgress) => void;
}

export interface IngestProgress {
  file: string;
  index: number;
  total: number;
  status: 'unchanged' | 'ingested';
  chunks: number;
  reusedChunks: number;
}

export interface IngestReport {
  filesScanned: number;
  documentsIngested: number;
  documentsUnchanged: number;
  documentsPruned: string[];
  chunksWritten: number;
  /** Chunks whose content hash already existed, so their vector was reused. */
  chunksReused: number;
  chunksEmbedded: number;
  embeddingTokens: number;
  durationMs: number;
}

/**
 * Incremental ingest.
 *
 * Two levels of content-hash short-circuiting:
 *
 *   1. **Document level** — if the SHA-256 of the file is unchanged, the file is
 *      skipped entirely: no parsing, no chunking, no embedding, no writes. This
 *      is what makes re-running `ingest` on an unchanged corpus a genuine no-op.
 *   2. **Chunk level** — when a file *has* changed, each chunk is hashed over
 *      (heading path + text). Chunks whose hash already exists anywhere in the
 *      store have their vector reused, so editing one paragraph of a long page
 *      re-embeds one chunk rather than forty. Hashing the heading path as well
 *      as the text matters: moving a section under a different heading changes
 *      what the chunk means for retrieval even when the prose is identical.
 */
export async function ingestDirectory(root: string, options: IngestOptions): Promise<IngestReport> {
  const logger = options.logger ?? silentLogger;
  const started = performance.now();
  const embedBatchSize = options.embedBatchSize ?? 64;
  const concurrency = options.concurrency ?? 4;

  await options.store.init(options.embedder.id, options.embedder.dimensions);

  const files = await findMarkdownFiles(root);
  logger.info('scanning corpus', { root, files: files.length });

  const report: IngestReport = {
    filesScanned: files.length,
    documentsIngested: 0,
    documentsUnchanged: 0,
    documentsPruned: [],
    chunksWritten: 0,
    chunksReused: 0,
    chunksEmbedded: 0,
    embeddingTokens: 0,
    durationMs: 0,
  };

  const documentIds: string[] = [];

  await mapWithConcurrency(files, concurrency, async (file, index) => {
    const doc = await loadDocument(root, file);
    documentIds.push(doc.id);

    if (!options.force) {
      const existing = await options.store.getDocument(doc.id);
      if (existing && existing.contentHash === doc.contentHash) {
        report.documentsUnchanged += 1;
        logger.debug('unchanged, skipping', { file: doc.id });
        options.onProgress?.({
          file: doc.id,
          index,
          total: files.length,
          status: 'unchanged',
          chunks: existing.chunkHashes.length,
          reusedChunks: existing.chunkHashes.length,
        });
        return;
      }
    }

    const chunks = chunkDocument(doc, options.chunkOptions);
    const { embedded, reused, embeddedCount, tokens } = await embedChunks(
      doc,
      chunks,
      options,
      embedBatchSize,
    );

    await options.store.upsertDocument(doc, embedded);

    report.documentsIngested += 1;
    report.chunksWritten += embedded.length;
    report.chunksReused += reused;
    report.chunksEmbedded += embeddedCount;
    report.embeddingTokens += tokens;

    logger.debug('ingested', { file: doc.id, chunks: embedded.length, reused });
    options.onProgress?.({
      file: doc.id,
      index,
      total: files.length,
      status: 'ingested',
      chunks: embedded.length,
      reusedChunks: reused,
    });
  });

  if (options.prune) {
    report.documentsPruned = await options.store.pruneDocuments(documentIds);
    if (report.documentsPruned.length > 0) {
      logger.info('pruned deleted documents', { count: report.documentsPruned.length });
    }
  }

  report.durationMs = Math.round(performance.now() - started);
  return report;
}

async function embedChunks(
  doc: SourceDocument,
  chunks: Chunk[],
  options: IngestOptions,
  embedBatchSize: number,
): Promise<{ embedded: EmbeddedChunk[]; reused: number; embeddedCount: number; tokens: number }> {
  if (chunks.length === 0) return { embedded: [], reused: 0, embeddedCount: 0, tokens: 0 };

  const cached = options.force
    ? new Map<string, number[]>()
    : await options.store.getEmbeddingsByHash(chunks.map((c) => c.contentHash));

  const pending = chunks.filter((c) => !cached.has(c.contentHash));
  let tokens = 0;
  const vectors = new Map<string, number[]>();

  // Batching happens here as well as inside OpenAIEmbedder so that the local
  // embedder and any future provider get the same bounded memory behaviour.
  for (const group of batch(pending, embedBatchSize)) {
    const groupTexts = group.map((c) =>
      contextualText({ documentTitle: doc.title, headingPath: c.headingPath, content: c.content }),
    );
    const result = await options.embedder.embed(groupTexts);
    tokens += result.tokens;
    group.forEach((chunk, i) => {
      const vector = result.vectors[i];
      if (!vector) throw new Error(`embedder returned no vector for chunk ${chunk.id}`);
      vectors.set(chunk.contentHash, vector);
    });
  }

  const embedded: EmbeddedChunk[] = chunks.map((chunk) => {
    const embedding = cached.get(chunk.contentHash) ?? vectors.get(chunk.contentHash);
    if (!embedding) throw new Error(`missing embedding for chunk ${chunk.id}`);
    return { ...chunk, embedding };
  });

  return {
    embedded,
    reused: chunks.length - pending.length,
    embeddedCount: pending.length,
    tokens,
  };
}
