/** Public library surface. The CLI and HTTP server are thin wrappers over this. */

export type {
  AnswerResult,
  ChatHints,
  ChatMessage,
  ChatModel,
  ChatRequest,
  ChatResponse,
  Chunk,
  Citation,
  EmbedResult,
  Embedder,
  EmbeddedChunk,
  FusedResult,
  ScoredChunk,
  SourceDocument,
  StoreStats,
  StoredChunk,
  StoredDocumentInfo,
  Timings,
  Usage,
  VectorStore,
} from './types.js';

export { loadConfig, type AppConfig } from './config.js';
export { createChatModel, createEmbedder, createVectorStore } from './providers/factory.js';

export { LocalEmbedder } from './providers/embedder/local.js';
export { OpenAIEmbedder } from './providers/embedder/openai.js';
export { cosineSimilarity, l2Normalize } from './providers/embedder/vector-math.js';
export { MockChat } from './providers/chat/mock.js';
export { AnthropicChat } from './providers/chat/anthropic.js';
export { OpenAIChat } from './providers/chat/openai.js';
export { MemoryVectorStore } from './providers/store/memory.js';
export { PgVectorStore } from './providers/store/pgvector.js';

export { parseBlocks, type Block } from './ingest/blocks.js';
export { parseFrontmatter } from './ingest/frontmatter.js';
export { findMarkdownFiles, loadDocument } from './ingest/walk.js';
export {
  chunkDocument,
  contextualText,
  DEFAULT_CHUNK_OPTIONS,
  type ChunkOptions,
} from './ingest/chunker.js';
export { ingestDirectory, type IngestOptions, type IngestReport } from './ingest/pipeline.js';

export { analyze, analyzeUnique, stem, termFrequencies } from './retrieval/analyzer.js';
export { Bm25Index, type Bm25Hit, type Bm25Options } from './retrieval/bm25.js';
export { reciprocalRankFusion, type FusionEntry, type RankedList } from './retrieval/rrf.js';
export { HybridRetriever, type HybridRetrieverOptions } from './retrieval/hybrid.js';
export { rerank, parseRerankScores } from './retrieval/rerank.js';
export { computeConfidence } from './retrieval/confidence.js';

export { buildContext, type BuiltContext, type ContextSource } from './answer/context.js';
export { ANSWER_SYSTEM_PROMPT, REFUSAL_TEXT, buildAnswerPrompt } from './answer/prompt.js';
export {
  extractCitationMarkers,
  verifyCitations,
  type VerifiedAnswer,
} from './answer/citations.js';
export {
  RagService,
  type AskOptions,
  type AskStreamEvent,
  type RagServiceOptions,
} from './answer/service.js';

export { loadQuestions, type EvalQuestion } from './evaluate/questions.js';
export {
  runEval,
  type EvalMetrics,
  type EvalReport,
  type QuestionResult,
} from './evaluate/runner.js';
export { renderTable, percent, fixed } from './evaluate/table.js';

export { createLogger, silentLogger, type Logger, type LogLevel } from './util/logger.js';
export { estimateTokens, heuristicTokenizer, type Tokenizer } from './util/tokens.js';
export { sha256, fnv1a32 } from './util/hash.js';
export { withRetry, HttpError, type RetryOptions } from './util/retry.js';
export { mapWithConcurrency, batch } from './util/pool.js';
export { parseSse, type SseEvent } from './util/sse.js';
export { squish, truncate, splitSentences, renderHeadingPath } from './util/text.js';
