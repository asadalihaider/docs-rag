import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';
import type { LogLevel } from './util/logger.js';

loadDotenv({ override: false });

const bool = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? defaultValue : /^(1|true|yes|on)$/i.test(v)));

const int = (defaultValue: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? defaultValue : Number(v)))
    .pipe(z.number().int().finite());

const num = (defaultValue: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? defaultValue : Number(v)))
    .pipe(z.number().finite());

const EnvSchema = z.object({
  /* providers */
  EMBEDDER_PROVIDER: z.enum(['local', 'openai']).default('local'),
  CHAT_PROVIDER: z.enum(['mock', 'anthropic', 'openai']).default('mock'),
  VECTOR_STORE: z.enum(['memory', 'pgvector']).default('memory'),

  /* embedder */
  LOCAL_EMBEDDING_DIM: int(512),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().optional(),
  OPENAI_EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
  OPENAI_EMBEDDING_DIM: z.string().optional(),
  EMBED_BATCH_SIZE: int(64),
  EMBED_CONCURRENCY: int(4),

  /* chat */
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_BASE_URL: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-4-5'),
  OPENAI_CHAT_MODEL: z.string().default('gpt-4o-mini'),
  CHAT_MAX_TOKENS: int(1024),
  CHAT_TEMPERATURE: num(0),

  /* stores */
  DATABASE_URL: z.string().optional(),
  MEMORY_INDEX_PATH: z.string().default('.docs-rag/index.json'),
  MIGRATIONS_DIR: z.string().default('migrations'),
  PGVECTOR_EF_SEARCH: int(100),

  /* chunking */
  CHUNK_TARGET_TOKENS: int(400),
  CHUNK_MAX_TOKENS: int(700),
  CHUNK_MIN_TOKENS: int(120),
  CHUNK_OVERLAP_TOKENS: int(60),

  /* retrieval */
  RAG_TOP_K: int(6),
  RAG_CANDIDATE_K: int(30),
  RAG_DENSE_WEIGHT: num(1),
  RAG_SPARSE_WEIGHT: num(1),
  RAG_RRF_K: int(60),
  RAG_RERANK: bool(false),
  RAG_RERANK_TOP_N: int(20),
  RAG_MIN_CONFIDENCE: num(0.3),

  /* answering */
  RAG_CONTEXT_TOKENS: int(6000),
  RAG_MAX_SOURCES: int(8),

  /* runtime */
  DOCS_DIR: z.string().default('sample-docs'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
  HOST: z.string().default('0.0.0.0'),
  PORT: int(8080),
});

export type Env = z.infer<typeof EnvSchema>;

export interface AppConfig {
  embedder: {
    provider: 'local' | 'openai';
    localDimensions: number;
    openai: {
      apiKey: string | undefined;
      baseUrl: string | undefined;
      model: string;
      dimensions: number | undefined;
    };
    batchSize: number;
    concurrency: number;
  };
  chat: {
    provider: 'mock' | 'anthropic' | 'openai';
    anthropic: { apiKey: string | undefined; baseUrl: string | undefined; model: string };
    openai: { apiKey: string | undefined; baseUrl: string | undefined; model: string };
    maxTokens: number;
    temperature: number;
  };
  store: {
    provider: 'memory' | 'pgvector';
    databaseUrl: string | undefined;
    memoryIndexPath: string;
    migrationsDir: string;
    efSearch: number;
  };
  chunking: {
    targetTokens: number;
    maxTokens: number;
    minTokens: number;
    overlapTokens: number;
  };
  retrieval: {
    topK: number;
    candidateK: number;
    denseWeight: number;
    sparseWeight: number;
    rrfK: number;
    rerank: boolean;
    rerankTopN: number;
    minConfidence: number;
  };
  answering: {
    contextTokens: number;
    maxSources: number;
  };
  docsDir: string;
  logLevel: LogLevel;
  host: string;
  port: number;
}

/** Parse process.env (or an override map) into a validated config object. */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const env = parsed.data;

  const config: AppConfig = {
    embedder: {
      provider: env.EMBEDDER_PROVIDER,
      localDimensions: env.LOCAL_EMBEDDING_DIM,
      openai: {
        apiKey: env.OPENAI_API_KEY,
        baseUrl: env.OPENAI_BASE_URL,
        model: env.OPENAI_EMBEDDING_MODEL,
        dimensions: env.OPENAI_EMBEDDING_DIM ? Number(env.OPENAI_EMBEDDING_DIM) : undefined,
      },
      batchSize: env.EMBED_BATCH_SIZE,
      concurrency: env.EMBED_CONCURRENCY,
    },
    chat: {
      provider: env.CHAT_PROVIDER,
      anthropic: {
        apiKey: env.ANTHROPIC_API_KEY,
        baseUrl: env.ANTHROPIC_BASE_URL,
        model: env.ANTHROPIC_MODEL,
      },
      openai: {
        apiKey: env.OPENAI_API_KEY,
        baseUrl: env.OPENAI_BASE_URL,
        model: env.OPENAI_CHAT_MODEL,
      },
      maxTokens: env.CHAT_MAX_TOKENS,
      temperature: env.CHAT_TEMPERATURE,
    },
    store: {
      provider: env.VECTOR_STORE,
      databaseUrl: env.DATABASE_URL,
      memoryIndexPath: env.MEMORY_INDEX_PATH,
      migrationsDir: env.MIGRATIONS_DIR,
      efSearch: env.PGVECTOR_EF_SEARCH,
    },
    chunking: {
      targetTokens: env.CHUNK_TARGET_TOKENS,
      maxTokens: env.CHUNK_MAX_TOKENS,
      minTokens: env.CHUNK_MIN_TOKENS,
      overlapTokens: env.CHUNK_OVERLAP_TOKENS,
    },
    retrieval: {
      topK: env.RAG_TOP_K,
      candidateK: env.RAG_CANDIDATE_K,
      denseWeight: env.RAG_DENSE_WEIGHT,
      sparseWeight: env.RAG_SPARSE_WEIGHT,
      rrfK: env.RAG_RRF_K,
      rerank: env.RAG_RERANK,
      rerankTopN: env.RAG_RERANK_TOP_N,
      minConfidence: env.RAG_MIN_CONFIDENCE,
    },
    answering: {
      contextTokens: env.RAG_CONTEXT_TOKENS,
      maxSources: env.RAG_MAX_SOURCES,
    },
    docsDir: env.DOCS_DIR,
    logLevel: env.LOG_LEVEL,
    host: env.HOST,
    port: env.PORT,
  };

  validate(config);
  return config;
}

/** Fail fast on combinations the schema cannot express. */
function validate(config: AppConfig): void {
  const problems: string[] = [];
  if (config.embedder.provider === 'openai' && !config.embedder.openai.apiKey) {
    problems.push('EMBEDDER_PROVIDER=openai requires OPENAI_API_KEY');
  }
  if (config.chat.provider === 'anthropic' && !config.chat.anthropic.apiKey) {
    problems.push('CHAT_PROVIDER=anthropic requires ANTHROPIC_API_KEY');
  }
  if (config.chat.provider === 'openai' && !config.chat.openai.apiKey) {
    problems.push('CHAT_PROVIDER=openai requires OPENAI_API_KEY');
  }
  if (config.store.provider === 'pgvector' && !config.store.databaseUrl) {
    problems.push('VECTOR_STORE=pgvector requires DATABASE_URL');
  }
  if (config.retrieval.denseWeight === 0 && config.retrieval.sparseWeight === 0) {
    problems.push('RAG_DENSE_WEIGHT and RAG_SPARSE_WEIGHT cannot both be 0');
  }
  if (config.chunking.minTokens >= config.chunking.targetTokens) {
    problems.push('CHUNK_MIN_TOKENS must be less than CHUNK_TARGET_TOKENS');
  }
  if (config.chunking.maxTokens < config.chunking.targetTokens) {
    problems.push('CHUNK_MAX_TOKENS must be >= CHUNK_TARGET_TOKENS');
  }
  if (problems.length > 0) {
    throw new Error(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }
}
