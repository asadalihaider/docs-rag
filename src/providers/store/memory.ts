import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  EmbeddedChunk,
  ScoredChunk,
  SourceDocument,
  StoreStats,
  StoredChunk,
  StoredDocumentInfo,
  VectorStore,
} from '../../types.js';
import { cosineSimilarity } from '../embedder/vector-math.js';
import { Bm25Index } from '../../retrieval/bm25.js';
import { analyze } from '../../retrieval/analyzer.js';

interface MemoryDocumentRecord {
  id: string;
  path: string;
  title: string;
  contentHash: string;
  frontmatter: Record<string, unknown>;
  chunkIds: string[];
}

interface MemoryChunkRecord {
  chunk: StoredChunk;
  embedding: number[];
}

const SNAPSHOT_VERSION = 1;

interface Snapshot {
  version: number;
  embedderId: string | null;
  dimensions: number | null;
  documents: MemoryDocumentRecord[];
  chunks: MemoryChunkRecord[];
}

/**
 * In-process vector store with brute-force cosine search and an in-process BM25
 * index.
 *
 * Brute force is the right call at this scale: a documentation corpus is
 * thousands of chunks, and a full scan of 2k × 512 floats is well under a
 * millisecond — an ANN index would add approximation error and build time for no
 * measurable win. `PgVectorStore` is the one that needs HNSW.
 *
 * The optional JSON snapshot exists so the CLI's zero-setup path can `ingest`
 * in one process and `ask` in another without Postgres. It is a developer
 * convenience, not a database: writes are whole-file and atomic-by-rename, with
 * no concurrent-writer story.
 */
export class MemoryVectorStore implements VectorStore {
  readonly id = 'memory';

  private documents = new Map<string, MemoryDocumentRecord>();
  private chunks = new Map<string, MemoryChunkRecord>();
  private bm25 = new Bm25Index();
  private embedderId: string | null = null;
  private dimensions: number | null = null;
  private readonly snapshotPath: string | undefined;

  constructor(options: { snapshotPath?: string } = {}) {
    this.snapshotPath = options.snapshotPath;
  }

  async init(embedderId: string, dimensions: number): Promise<void> {
    if (this.snapshotPath) await this.load();
    if (this.embedderId && this.embedderId !== embedderId) {
      throw new Error(
        `index was built with embedder "${this.embedderId}" but "${embedderId}" is configured; ` +
          're-ingest or switch back',
      );
    }
    if (this.dimensions && this.dimensions !== dimensions) {
      throw new Error(
        `index has ${this.dimensions} dimensions but embedder produces ${dimensions}`,
      );
    }
    this.embedderId = embedderId;
    this.dimensions = dimensions;
  }

  async getDocument(id: string): Promise<StoredDocumentInfo | null> {
    const record = this.documents.get(id);
    if (!record) return null;
    return {
      id: record.id,
      contentHash: record.contentHash,
      chunkHashes: record.chunkIds.map((c) => this.chunks.get(c)?.chunk.contentHash ?? ''),
    };
  }

  async upsertDocument(doc: SourceDocument, chunks: EmbeddedChunk[]): Promise<void> {
    this.removeDocumentChunks(doc.id);

    const record: MemoryDocumentRecord = {
      id: doc.id,
      path: doc.id,
      title: doc.title,
      contentHash: doc.contentHash,
      frontmatter: doc.frontmatter,
      chunkIds: chunks.map((c) => c.id),
    };
    this.documents.set(doc.id, record);

    for (const chunk of chunks) {
      const { embedding, ...rest } = chunk;
      const stored: StoredChunk = { ...rest, documentPath: doc.id, documentTitle: doc.title };
      this.chunks.set(chunk.id, { chunk: stored, embedding });
      this.bm25.addAnalyzed(chunk.id, analyze(bm25Text(stored)));
    }
  }

  async pruneDocuments(keepIds: string[]): Promise<string[]> {
    const keep = new Set(keepIds);
    const removed: string[] = [];
    for (const id of [...this.documents.keys()]) {
      if (keep.has(id)) continue;
      this.removeDocumentChunks(id);
      this.documents.delete(id);
      removed.push(id);
    }
    return removed;
  }

  async getEmbeddingsByHash(hashes: string[]): Promise<Map<string, number[]>> {
    const wanted = new Set(hashes);
    const out = new Map<string, number[]>();
    for (const record of this.chunks.values()) {
      if (wanted.has(record.chunk.contentHash) && !out.has(record.chunk.contentHash)) {
        out.set(record.chunk.contentHash, record.embedding);
      }
    }
    return out;
  }

  async denseSearch(vector: number[], k: number): Promise<ScoredChunk[]> {
    const hits: ScoredChunk[] = [];
    for (const record of this.chunks.values()) {
      hits.push({ chunk: record.chunk, score: cosineSimilarity(vector, record.embedding) });
    }
    hits.sort((a, b) => b.score - a.score || (a.chunk.id < b.chunk.id ? -1 : 1));
    return hits.slice(0, k);
  }

  async sparseSearch(queryTerms: string[], k: number): Promise<ScoredChunk[]> {
    return this.bm25
      .searchTerms(queryTerms, k)
      .map((hit) => {
        const record = this.chunks.get(hit.id);
        return record ? { chunk: record.chunk, score: hit.score } : null;
      })
      .filter((x): x is ScoredChunk => x !== null);
  }

  async stats(): Promise<StoreStats> {
    let totalTokens = 0;
    for (const record of this.chunks.values()) totalTokens += record.chunk.tokenCount;
    return {
      documents: this.documents.size,
      chunks: this.chunks.size,
      totalTokens,
      embedderId: this.embedderId,
      dimensions: this.dimensions,
    };
  }

  async close(): Promise<void> {
    if (this.snapshotPath) await this.save();
  }

  /** Persist without closing — used by the ingest pipeline. */
  async flush(): Promise<void> {
    if (this.snapshotPath) await this.save();
  }

  /* ---------------------------------------------------------------- */

  private removeDocumentChunks(documentId: string): void {
    const existing = this.documents.get(documentId);
    if (!existing) return;
    for (const chunkId of existing.chunkIds) {
      this.chunks.delete(chunkId);
      this.bm25.remove(chunkId);
    }
  }

  private async save(): Promise<void> {
    const path = this.snapshotPath;
    if (!path) return;
    const snapshot: Snapshot = {
      version: SNAPSHOT_VERSION,
      embedderId: this.embedderId,
      dimensions: this.dimensions,
      documents: [...this.documents.values()],
      chunks: [...this.chunks.values()],
    };
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(snapshot), 'utf8');
    await rename(tmp, path);
  }

  private async load(): Promise<void> {
    const path = this.snapshotPath;
    if (!path) return;
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const snapshot = JSON.parse(raw) as Snapshot;
    if (snapshot.version !== SNAPSHOT_VERSION) {
      throw new Error(
        `index snapshot at ${path} is version ${snapshot.version}, expected ${SNAPSHOT_VERSION}; delete it and re-ingest`,
      );
    }
    this.documents = new Map(snapshot.documents.map((d) => [d.id, d]));
    this.chunks = new Map(snapshot.chunks.map((c) => [c.chunk.id, c]));
    this.embedderId = snapshot.embedderId;
    this.dimensions = snapshot.dimensions;
    this.bm25 = new Bm25Index();
    for (const record of this.chunks.values()) {
      this.bm25.addAnalyzed(record.chunk.id, analyze(bm25Text(record.chunk)));
    }
  }
}

/**
 * Text handed to BM25 for a chunk.
 *
 * The heading path and document title are included because a query like
 * "docker compose" should match a chunk under `Deployment > Docker Compose`
 * even when the body never repeats those words.
 */
export function bm25Text(chunk: StoredChunk): string {
  return `${chunk.documentTitle}\n${chunk.headingPath.join(' ')}\n${chunk.content}`;
}
