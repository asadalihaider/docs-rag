import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import type {
  EmbeddedChunk,
  ScoredChunk,
  SourceDocument,
  StoreStats,
  StoredChunk,
  StoredDocumentInfo,
  VectorStore,
} from '../../types.js';
import { analyze, termFrequencies } from '../../retrieval/analyzer.js';
import { bm25Text } from './memory.js';
import type { Logger } from '../../util/logger.js';
import { silentLogger } from '../../util/logger.js';

const { Pool } = pg;

export interface PgVectorStoreOptions {
  connectionString: string;
  migrationsDir?: string;
  /**
   * HNSW search breadth. Higher = better recall, slower queries.
   * pgvector's default is 40; 100 is a good default for a docs-sized index where
   * queries are cheap and a missed chunk is expensive.
   */
  efSearch?: number;
  bm25?: { k1?: number; b?: number };
  poolSize?: number;
  logger?: Logger;
}

interface ChunkRow {
  id: string;
  document_id: string;
  ordinal: number;
  heading_path: string[];
  content: string;
  content_hash: string;
  token_count: number;
  start_line: number;
  end_line: number;
  document_path: string;
  document_title: string;
  score: string | number;
}

/** Serialise a JS array into pgvector's text input format. */
export function toVectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(',')}]`;
}

/** Parse pgvector's `[1,2,3]` text output back into numbers. */
export function parseVectorLiteral(literal: string): number[] {
  const inner = literal.trim().replace(/^\[/, '').replace(/\]$/, '');
  if (inner.length === 0) return [];
  return inner.split(',').map(Number);
}

function rowToStoredChunk(row: ChunkRow): StoredChunk {
  return {
    id: row.id,
    documentId: row.document_id,
    ordinal: row.ordinal,
    headingPath: row.heading_path ?? [],
    content: row.content,
    contentHash: row.content_hash,
    tokenCount: row.token_count,
    startLine: row.start_line,
    endLine: row.end_line,
    documentPath: row.document_path,
    documentTitle: row.document_title,
  };
}

/**
 * Postgres + pgvector store.
 *
 * Dense search uses the cosine distance operator `<=>` so the HNSW index built
 * with `vector_cosine_ops` is actually used (using `<->` here would silently
 * fall back to a sequential scan). Similarity is reported as `1 - distance`.
 *
 * Sparse search runs full Okapi BM25 in SQL against the `chunk_terms` inverted
 * index — same formula and same analyzer as the in-memory implementation.
 */
export class PgVectorStore implements VectorStore {
  readonly id = 'pgvector';
  private readonly pool: pg.Pool;
  private readonly migrationsDir: string;
  private readonly efSearch: number;
  private readonly k1: number;
  private readonly b: number;
  private readonly logger: Logger;

  constructor(options: PgVectorStoreOptions) {
    this.pool = new Pool({
      connectionString: options.connectionString,
      max: options.poolSize ?? 8,
    });
    this.migrationsDir = options.migrationsDir ?? 'migrations';
    this.efSearch = options.efSearch ?? 100;
    this.k1 = options.bm25?.k1 ?? 1.2;
    this.b = options.bm25?.b ?? 0.75;
    this.logger = options.logger ?? silentLogger;
  }

  async init(embedderId: string, dimensions: number): Promise<void> {
    await this.migrate(dimensions);

    const client = await this.pool.connect();
    try {
      const existing = await client.query<{ key: string; value: string }>(
        `SELECT key, value FROM rag_meta WHERE key IN ('embedder_id', 'dimensions')`,
      );
      const meta = new Map(existing.rows.map((r) => [r.key, r.value]));
      const storedEmbedder = meta.get('embedder_id');
      const storedDims = meta.get('dimensions');

      if (storedEmbedder && storedEmbedder !== embedderId) {
        throw new Error(
          `index was built with embedder "${storedEmbedder}" but "${embedderId}" is configured; ` +
            're-ingest (docs-rag ingest --reset) or switch back',
        );
      }
      if (storedDims && Number(storedDims) !== dimensions) {
        throw new Error(
          `index has ${storedDims} dimensions but the configured embedder produces ${dimensions}`,
        );
      }

      await client.query(
        `INSERT INTO rag_meta (key, value) VALUES ('embedder_id', $1), ('dimensions', $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [embedderId, String(dimensions)],
      );
    } finally {
      client.release();
    }
  }

  /** Apply every `.sql` file in the migrations dir, in filename order. */
  private async migrate(dimensions: number): Promise<void> {
    const files = (await readdir(this.migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      const sql = (await readFile(join(this.migrationsDir, file), 'utf8')).replaceAll(
        '{{EMBEDDING_DIM}}',
        String(dimensions),
      );
      this.logger.debug('applying migration', { file });
      await this.pool.query(sql);
    }
  }

  async getDocument(id: string): Promise<StoredDocumentInfo | null> {
    const doc = await this.pool.query<{ id: string; content_hash: string }>(
      'SELECT id, content_hash FROM documents WHERE id = $1',
      [id],
    );
    const row = doc.rows[0];
    if (!row) return null;
    const chunks = await this.pool.query<{ content_hash: string }>(
      'SELECT content_hash FROM chunks WHERE document_id = $1 ORDER BY ordinal',
      [id],
    );
    return {
      id: row.id,
      contentHash: row.content_hash,
      chunkHashes: chunks.rows.map((r) => r.content_hash),
    };
  }

  async upsertDocument(doc: SourceDocument, chunks: EmbeddedChunk[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO documents (id, title, content_hash, frontmatter, updated_at)
         VALUES ($1, $2, $3, $4::jsonb, now())
         ON CONFLICT (id) DO UPDATE
           SET title = EXCLUDED.title,
               content_hash = EXCLUDED.content_hash,
               frontmatter = EXCLUDED.frontmatter,
               updated_at = now()`,
        [doc.id, doc.title, doc.contentHash, JSON.stringify(doc.frontmatter)],
      );

      // Replace all chunks for this document; ON DELETE CASCADE clears terms.
      await client.query('DELETE FROM chunks WHERE document_id = $1', [doc.id]);

      for (const chunk of chunks) {
        const stored: StoredChunk = {
          ...chunk,
          documentPath: doc.id,
          documentTitle: doc.title,
        };
        const terms = analyze(bm25Text(stored));
        await client.query(
          `INSERT INTO chunks
             (id, document_id, ordinal, heading_path, content, content_hash,
              token_count, term_count, start_line, end_line, embedding)
           VALUES ($1, $2, $3, $4::text[], $5, $6, $7, $8, $9, $10, $11::vector)`,
          [
            chunk.id,
            doc.id,
            chunk.ordinal,
            chunk.headingPath,
            chunk.content,
            chunk.contentHash,
            chunk.tokenCount,
            terms.length,
            chunk.startLine,
            chunk.endLine,
            toVectorLiteral(chunk.embedding),
          ],
        );

        const tf = termFrequencies(terms);
        if (tf.size > 0) {
          // One multi-row INSERT per chunk keeps round-trips proportional to
          // chunks rather than to distinct terms.
          const values: string[] = [];
          const params: unknown[] = [chunk.id];
          let i = 2;
          for (const [term, count] of tf) {
            values.push(`($1, $${i}, $${i + 1})`);
            params.push(term, count);
            i += 2;
          }
          await client.query(
            `INSERT INTO chunk_terms (chunk_id, term, tf) VALUES ${values.join(', ')}
             ON CONFLICT (chunk_id, term) DO UPDATE SET tf = EXCLUDED.tf`,
            params,
          );
        }
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async pruneDocuments(keepIds: string[]): Promise<string[]> {
    const result = await this.pool.query<{ id: string }>(
      'DELETE FROM documents WHERE NOT (id = ANY($1::text[])) RETURNING id',
      [keepIds],
    );
    return result.rows.map((r) => r.id);
  }

  async getEmbeddingsByHash(hashes: string[]): Promise<Map<string, number[]>> {
    if (hashes.length === 0) return new Map();
    const result = await this.pool.query<{ content_hash: string; embedding: string }>(
      `SELECT DISTINCT ON (content_hash) content_hash, embedding::text AS embedding
       FROM chunks WHERE content_hash = ANY($1::text[])`,
      [hashes],
    );
    return new Map(result.rows.map((r) => [r.content_hash, parseVectorLiteral(r.embedding)]));
  }

  async denseSearch(vector: number[], k: number): Promise<ScoredChunk[]> {
    const client = await this.pool.connect();
    try {
      // `SET LOCAL` only takes effect inside a transaction block — outside one
      // Postgres emits a warning and ignores it. Wrapping the read in an
      // explicit transaction also guarantees the setting is reverted when the
      // connection returns to the pool.
      await client.query('BEGIN');
      // ef_search must be at least k, otherwise HNSW cannot return k candidates.
      const ef = Math.max(this.efSearch, k);
      await client.query(`SET LOCAL hnsw.ef_search = ${Number(ef)}`);
      const result = await client.query<ChunkRow>(
        `SELECT c.id, c.document_id, c.ordinal, c.heading_path, c.content, c.content_hash,
                c.token_count, c.start_line, c.end_line,
                d.id AS document_path, d.title AS document_title,
                1 - (c.embedding <=> $1::vector) AS score
         FROM chunks c
         JOIN documents d ON d.id = c.document_id
         ORDER BY c.embedding <=> $1::vector
         LIMIT $2`,
        [toVectorLiteral(vector), k],
      );
      await client.query('COMMIT');
      return result.rows.map((row) => ({ chunk: rowToStoredChunk(row), score: Number(row.score) }));
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async sparseSearch(queryTerms: string[], k: number): Promise<ScoredChunk[]> {
    if (queryTerms.length === 0) return [];
    const result = await this.pool.query<ChunkRow>(
      `
      WITH params AS (
        SELECT $2::float8 AS k1,
               $3::float8 AS b,
               (SELECT count(*)::float8 FROM chunks) AS n_docs,
               (SELECT COALESCE(avg(term_count), 1)::float8 FROM chunks) AS avgdl
      ),
      q AS (
        SELECT term, count(*)::float8 AS qtf
        FROM unnest($1::text[]) AS t(term)
        GROUP BY term
      ),
      df AS (
        SELECT ct.term, count(*)::float8 AS df
        FROM chunk_terms ct
        JOIN q ON q.term = ct.term
        GROUP BY ct.term
      ),
      scored AS (
        SELECT ct.chunk_id,
               sum(
                 ln(1 + (p.n_docs - df.df + 0.5) / (df.df + 0.5))
                 * ((ct.tf::float8 * (p.k1 + 1))
                    / (ct.tf::float8 + p.k1 * (1 - p.b + p.b * c.term_count::float8 / NULLIF(p.avgdl, 0))))
                 * q.qtf
               ) AS score
        FROM chunk_terms ct
        JOIN q  ON q.term = ct.term
        JOIN df ON df.term = ct.term
        JOIN chunks c ON c.id = ct.chunk_id
        CROSS JOIN params p
        GROUP BY ct.chunk_id
      )
      SELECT c.id, c.document_id, c.ordinal, c.heading_path, c.content, c.content_hash,
             c.token_count, c.start_line, c.end_line,
             d.id AS document_path, d.title AS document_title,
             s.score
      FROM scored s
      JOIN chunks c ON c.id = s.chunk_id
      JOIN documents d ON d.id = c.document_id
      ORDER BY s.score DESC, c.id ASC
      LIMIT $4
      `,
      [queryTerms, this.k1, this.b, k],
    );
    return result.rows.map((row) => ({ chunk: rowToStoredChunk(row), score: Number(row.score) }));
  }

  async stats(): Promise<StoreStats> {
    const [counts, meta] = await Promise.all([
      this.pool.query<{ documents: string; chunks: string; total_tokens: string | null }>(
        `SELECT (SELECT count(*) FROM documents) AS documents,
                (SELECT count(*) FROM chunks) AS chunks,
                (SELECT COALESCE(sum(token_count), 0) FROM chunks) AS total_tokens`,
      ),
      this.pool.query<{ key: string; value: string }>('SELECT key, value FROM rag_meta'),
    ]);
    const row = counts.rows[0];
    const metaMap = new Map(meta.rows.map((r) => [r.key, r.value]));
    const dims = metaMap.get('dimensions');
    return {
      documents: Number(row?.documents ?? 0),
      chunks: Number(row?.chunks ?? 0),
      totalTokens: Number(row?.total_tokens ?? 0),
      embedderId: metaMap.get('embedder_id') ?? null,
      dimensions: dims === undefined ? null : Number(dims),
    };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
