/**
 * Core domain types shared across ingestion, retrieval and answering.
 *
 * Everything here is provider-agnostic on purpose: the pipeline is written
 * against these types, and concrete embedders / chat models / vector stores
 * are swapped in at the edges (see `src/providers`).
 */

/** A single markdown source file after frontmatter parsing. */
export interface SourceDocument {
  /** Stable identifier — the path relative to the ingest root, e.g. `guides/installation.md`. */
  id: string;
  /** Absolute path on disk at ingest time. */
  absolutePath: string;
  /** Human title: frontmatter `title`, else the first H1, else the filename. */
  title: string;
  /** Parsed YAML frontmatter (empty object when the file has none). */
  frontmatter: Record<string, unknown>;
  /** Markdown body with the frontmatter block removed. */
  body: string;
  /** SHA-256 of the full file contents (frontmatter included). */
  contentHash: string;
}

/** A retrieval unit produced by the heading-aware chunker. */
export interface Chunk {
  /** `${documentId}#${ordinal}` — stable for a given document + chunk position. */
  id: string;
  documentId: string;
  /** Position of this chunk within its document, 0-based. */
  ordinal: number;
  /**
   * Markdown heading ancestry for this chunk, outermost first.
   * e.g. `['Installation', 'Docker', 'Compose']`.
   */
  headingPath: string[];
  /**
   * Chunk text exactly as it appeared in the source (no synthetic prefix).
   * The heading breadcrumb is added at embedding / prompt time by
   * `contextualText()` so the stored text stays faithful to the document.
   */
  content: string;
  /** SHA-256 of `headingPath + content` — drives incremental ingest. */
  contentHash: string;
  /** Estimated token count of `content`. */
  tokenCount: number;
  /** Line span in the source document (1-based, inclusive). */
  startLine: number;
  endLine: number;
}

/** A chunk together with its embedding, ready to persist. */
export interface EmbeddedChunk extends Chunk {
  embedding: number[];
}

/** A chunk as it comes back out of a vector store. */
export interface StoredChunk extends Chunk {
  /** Path of the owning document, relative to the ingest root. */
  documentPath: string;
  documentTitle: string;
}

/** One retriever's opinion about one chunk. */
export interface ScoredChunk {
  chunk: StoredChunk;
  score: number;
}

/** A fused result carrying the per-retriever provenance so fusion stays inspectable. */
export interface FusedResult {
  chunk: StoredChunk;
  /** Final Reciprocal Rank Fusion score. */
  score: number;
  /** Cosine similarity in [-1, 1] from the dense retriever, if it returned this chunk. */
  denseScore: number | null;
  /** 1-based rank from the dense retriever, if any. */
  denseRank: number | null;
  /** Okapi BM25 score, if the sparse retriever returned this chunk. */
  sparseScore: number | null;
  /** 1-based rank from the sparse retriever, if any. */
  sparseRank: number | null;
  /** Relevance score in [0, 10] assigned by the LLM reranker, when reranking ran. */
  rerankScore: number | null;
}

/** A citation attached to an answer, after verification. */
export interface Citation {
  /** The marker number used in the answer text: `[^n]`. */
  n: number;
  /** Document path relative to the ingest root. */
  file: string;
  /** Rendered heading path, e.g. `Installation > Docker`. */
  headingPath: string;
  /** Fused retrieval score for the cited chunk. */
  score: number;
  /** Short excerpt of the cited chunk, for display. */
  excerpt: string;
  chunkId: string;
}

export interface Usage {
  embeddingTokens: number;
  promptTokens: number;
  completionTokens: number;
}

export interface Timings {
  embedMs: number;
  retrieveMs: number;
  rerankMs: number;
  generateMs: number;
  totalMs: number;
}

export interface AnswerResult {
  answer: string;
  citations: Citation[];
  usage: Usage;
  timings: Timings;
  /** True when confidence was below threshold and the model was never called. */
  refused: boolean;
  /**
   * Confidence in [0, 1] derived from the best retrieval scores.
   * See `src/retrieval/confidence.ts` for the exact definition.
   */
  confidence: number;
  /** Full fused candidate list, so callers can inspect why an answer looks the way it does. */
  retrieved: FusedResult[];
  /** Citation markers the model emitted that did not map to a retrieved chunk. */
  droppedCitations: number[];
}

/* ------------------------------------------------------------------ */
/* Provider interfaces                                                 */
/* ------------------------------------------------------------------ */

export interface EmbedResult {
  vectors: number[][];
  tokens: number;
}

export interface Embedder {
  /** Stable provider id, persisted alongside vectors so mismatches are detectable. */
  readonly id: string;
  /** Output dimensionality. Must match the vector store column width. */
  readonly dimensions: number;
  /**
   * Embed a batch of texts. Implementations must return one vector per input,
   * in input order, L2-normalised.
   */
  embed(texts: string[]): Promise<EmbedResult>;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Structured hint passed to providers that can use it (MockChat) and ignored by real LLMs. */
export interface ChatHints {
  question: string;
  sources: Array<{ n: number; file: string; headingPath: string; content: string }>;
}

export interface ChatRequest {
  messages: ChatMessage[];
  /** What the caller is asking for; lets deterministic providers behave sensibly. */
  task: 'answer' | 'rerank';
  maxTokens?: number;
  temperature?: number;
  hints?: ChatHints;
}

export interface ChatResponse {
  text: string;
  promptTokens: number;
  completionTokens: number;
}

export interface ChatModel {
  readonly id: string;
  complete(req: ChatRequest): Promise<ChatResponse>;
  /** Token-by-token streaming. Implementations must yield the same text `complete` would return. */
  stream(req: ChatRequest): AsyncIterable<string>;
}

/** Statistics used by the `stats` command and by BM25 normalisation. */
export interface StoreStats {
  documents: number;
  chunks: number;
  totalTokens: number;
  embedderId: string | null;
  dimensions: number | null;
}

/** Record of what a document looks like in the store, for incremental ingest. */
export interface StoredDocumentInfo {
  id: string;
  contentHash: string;
  chunkHashes: string[];
}

export interface VectorStore {
  readonly id: string;
  /** Create schema / warm connections. Safe to call repeatedly. */
  init(embedderId: string, dimensions: number): Promise<void>;
  /** Look up an already-ingested document by id. */
  getDocument(id: string): Promise<StoredDocumentInfo | null>;
  /**
   * Replace a document and all of its chunks atomically.
   * Implementations must delete chunks that no longer exist.
   */
  upsertDocument(doc: SourceDocument, chunks: EmbeddedChunk[]): Promise<void>;
  /** Remove documents whose ids are not in `keepIds` (files deleted from the corpus). */
  pruneDocuments(keepIds: string[]): Promise<string[]>;
  /**
   * Look up embeddings by chunk content hash, so a modified file only pays to
   * re-embed the chunks that actually changed.
   */
  getEmbeddingsByHash(hashes: string[]): Promise<Map<string, number[]>>;
  /** Dense retrieval by cosine similarity. Returns descending similarity in [-1, 1]. */
  denseSearch(vector: number[], k: number): Promise<ScoredChunk[]>;
  /** Sparse retrieval with Okapi BM25 over the ingested chunk corpus. */
  sparseSearch(queryTerms: string[], k: number): Promise<ScoredChunk[]>;
  stats(): Promise<StoreStats>;
  close(): Promise<void>;
}
