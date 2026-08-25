import type { AppConfig } from '../config.js';
import type { ChatModel, Embedder, VectorStore } from '../types.js';
import { LocalEmbedder } from './embedder/local.js';
import { OpenAIEmbedder } from './embedder/openai.js';
import { MockChat } from './chat/mock.js';
import { AnthropicChat } from './chat/anthropic.js';
import { OpenAIChat } from './chat/openai.js';
import { MemoryVectorStore } from './store/memory.js';
import { PgVectorStore } from './store/pgvector.js';
import type { Logger } from '../util/logger.js';
import { silentLogger } from '../util/logger.js';

/**
 * Provider selection.
 *
 * Everything downstream depends on the `Embedder` / `ChatModel` / `VectorStore`
 * interfaces only, so this file is the single place that knows which concrete
 * implementation is in play. That is what makes the default configuration —
 * local embedder, mock chat, in-memory store — a fully working system with no
 * API keys and no database, rather than a mocked-out stub of one.
 */
export function createEmbedder(config: AppConfig, logger: Logger = silentLogger): Embedder {
  switch (config.embedder.provider) {
    case 'local':
      return new LocalEmbedder({ dimensions: config.embedder.localDimensions });
    case 'openai': {
      const { apiKey, baseUrl, model, dimensions } = config.embedder.openai;
      if (!apiKey) throw new Error('OPENAI_API_KEY is required for EMBEDDER_PROVIDER=openai');
      return new OpenAIEmbedder({
        apiKey,
        model,
        batchSize: config.embedder.batchSize,
        concurrency: config.embedder.concurrency,
        logger,
        ...(baseUrl ? { baseUrl } : {}),
        ...(dimensions ? { dimensions } : {}),
      });
    }
  }
}

export function createChatModel(config: AppConfig, logger: Logger = silentLogger): ChatModel {
  switch (config.chat.provider) {
    case 'mock':
      return new MockChat();
    case 'anthropic': {
      const { apiKey, baseUrl, model } = config.chat.anthropic;
      if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required for CHAT_PROVIDER=anthropic');
      return new AnthropicChat({
        apiKey,
        model,
        maxTokens: config.chat.maxTokens,
        temperature: config.chat.temperature,
        logger,
        ...(baseUrl ? { baseUrl } : {}),
      });
    }
    case 'openai': {
      const { apiKey, baseUrl, model } = config.chat.openai;
      if (!apiKey) throw new Error('OPENAI_API_KEY is required for CHAT_PROVIDER=openai');
      return new OpenAIChat({
        apiKey,
        model,
        maxTokens: config.chat.maxTokens,
        temperature: config.chat.temperature,
        logger,
        ...(baseUrl ? { baseUrl } : {}),
      });
    }
  }
}

export function createVectorStore(config: AppConfig, logger: Logger = silentLogger): VectorStore {
  switch (config.store.provider) {
    case 'memory':
      return new MemoryVectorStore({ snapshotPath: config.store.memoryIndexPath });
    case 'pgvector': {
      const connectionString = config.store.databaseUrl;
      if (!connectionString) throw new Error('DATABASE_URL is required for VECTOR_STORE=pgvector');
      return new PgVectorStore({
        connectionString,
        migrationsDir: config.store.migrationsDir,
        efSearch: config.store.efSearch,
        logger,
      });
    }
  }
}
