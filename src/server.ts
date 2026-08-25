import { resolve } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { loadConfig, type AppConfig } from './config.js';
import { createChatModel, createEmbedder, createVectorStore } from './providers/factory.js';
import { RagService } from './answer/service.js';
import { ingestDirectory } from './ingest/pipeline.js';
import { createLogger, type Logger } from './util/logger.js';
import type { VectorStore } from './types.js';

const AskBody = z.object({
  question: z.string().min(1).max(4000),
  topK: z.number().int().min(1).max(50).optional(),
  rerank: z.boolean().optional(),
  minConfidence: z.number().min(0).max(1).optional(),
  /** `false` returns a single JSON response instead of an SSE stream. */
  stream: z.boolean().optional(),
});

const IngestBody = z.object({
  dir: z.string().min(1).optional(),
  force: z.boolean().optional(),
  prune: z.boolean().optional(),
});

export interface BuildServerResult {
  app: FastifyInstance;
  service: RagService;
  store: VectorStore;
  config: AppConfig;
  logger: Logger;
}

/**
 * HTTP API.
 *
 * `POST /ask` streams Server-Sent Events by default:
 *
 *   event: retrieval  — the fused candidate list and confidence, sent before
 *                       generation starts so a UI can show sources immediately
 *   event: token      — one generated text delta
 *   event: final      — the verified answer, citations, usage and timings
 *   event: error      — a terminal error mid-stream
 *
 * The `final` event repeats the whole answer rather than only the citations,
 * because citation verification cannot run until generation completes (see
 * `RagService.askStream`). Clients render `token` deltas for responsiveness and
 * then swap in `final.answer`, which is the text whose citations are verified.
 */
export async function buildServer(): Promise<BuildServerResult> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const embedder = createEmbedder(config, logger);
  const chat = createChatModel(config, logger);
  const store = createVectorStore(config, logger);

  const service = new RagService({
    embedder,
    chat,
    store,
    logger,
    topK: config.retrieval.topK,
    candidateK: config.retrieval.candidateK,
    denseWeight: config.retrieval.denseWeight,
    sparseWeight: config.retrieval.sparseWeight,
    rrfK: config.retrieval.rrfK,
    rerank: config.retrieval.rerank,
    rerankTopN: config.retrieval.rerankTopN,
    minConfidence: config.retrieval.minConfidence,
    contextTokens: config.answering.contextTokens,
    maxSources: config.answering.maxSources,
    chatMaxTokens: config.chat.maxTokens,
  });

  // Initialise the store eagerly rather than lazily on the first /ask: a
  // health check that can report stale "0 documents" simply because nothing
  // has queried the store yet is not trustworthy, and for pgvector this is
  // also where a bad DATABASE_URL or a missing migration fails fast at boot
  // instead of on some unlucky request.
  await service.init();

  const app = Fastify({ logger: false, bodyLimit: 1_000_000 });

  app.get('/healthz', async () => {
    // A health check that does not touch the store is not a health check.
    const stats = await store.stats().catch(() => null);
    return {
      status: stats === null ? 'degraded' : 'ok',
      store: config.store.provider,
      embedder: embedder.id,
      chat: chat.id,
      documents: stats?.documents ?? null,
      chunks: stats?.chunks ?? null,
    };
  });

  app.post('/ask', async (request, reply) => {
    const parsed = AskBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid request', issues: parsed.error.issues });
    }
    const { question, topK, rerank, minConfidence, stream = true } = parsed.data;
    const askOptions = {
      ...(topK === undefined ? {} : { topK }),
      ...(rerank === undefined ? {} : { rerank }),
      ...(minConfidence === undefined ? {} : { minConfidence }),
    };

    if (!stream) {
      const result = await service.ask(question, askOptions);
      return reply.send(result);
    }

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Nginx buffers SSE into uselessness without this.
      'x-accel-buffering': 'no',
    });

    const send = (event: string, data: unknown) => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    let closed = false;
    request.raw.on('close', () => {
      closed = true;
    });

    try {
      for await (const event of service.askStream(question, askOptions)) {
        if (closed) break;
        switch (event.type) {
          case 'retrieval':
            send('retrieval', {
              confidence: event.confidence,
              results: event.results.map((r) => ({
                chunkId: r.chunk.id,
                file: r.chunk.documentPath,
                headingPath: r.chunk.headingPath,
                score: r.score,
                denseScore: r.denseScore,
                denseRank: r.denseRank,
                sparseScore: r.sparseScore,
                sparseRank: r.sparseRank,
                rerankScore: r.rerankScore,
              })),
            });
            break;
          case 'token':
            send('token', { text: event.text });
            break;
          case 'final':
            send('final', event.result);
            break;
          case 'error':
            send('error', { message: event.message });
            break;
        }
      }
    } catch (error) {
      logger.error('ask stream failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      if (!closed) send('error', { message: 'internal error while answering' });
    } finally {
      if (!closed) reply.raw.end();
    }
    return reply;
  });

  app.post('/ingest', async (request, reply) => {
    const parsed = IngestBody.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid request', issues: parsed.error.issues });
    }
    const root = resolve(parsed.data.dir ?? config.docsDir);
    const report = await ingestDirectory(root, {
      embedder,
      store,
      chunkOptions: config.chunking,
      embedBatchSize: config.embedder.batchSize,
      concurrency: config.embedder.concurrency,
      prune: parsed.data.prune ?? true,
      force: parsed.data.force ?? false,
      logger,
    });
    return reply.send({ root, ...report });
  });

  app.setErrorHandler((error, _request, reply) => {
    logger.error('request failed', { error: error.message });
    void reply.status(error.statusCode ?? 500).send({ error: error.message });
  });

  return { app, service, store, config, logger };
}

export async function startServer(): Promise<FastifyInstance> {
  const { app, store, config, logger } = await buildServer();
  await app.listen({ host: config.host, port: config.port });
  logger.info('listening', { host: config.host, port: config.port });

  const shutdown = async (signal: string) => {
    logger.info('shutting down', { signal });
    await app.close();
    await store.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  return app;
}

// `node dist/server.js` starts the server; importing the module does not.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  startServer().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}
