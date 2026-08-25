#!/usr/bin/env node
import { resolve } from 'node:path';
import { Command } from 'commander';
import { loadConfig, type AppConfig } from './config.js';
import { createChatModel, createEmbedder, createVectorStore } from './providers/factory.js';
import { ingestDirectory } from './ingest/pipeline.js';
import { RagService } from './answer/service.js';
import { loadQuestions } from './evaluate/questions.js';
import { runEval, type EvalReport } from './evaluate/runner.js';
import { fixed, percent, renderTable } from './evaluate/table.js';
import { createLogger } from './util/logger.js';
import { truncate } from './util/text.js';
import type { VectorStore } from './types.js';

const program = new Command();

program
  .name('docs-rag')
  .description(
    'Retrieval-augmented Q&A over a markdown documentation set, with verified citations.',
  )
  .version('0.1.0');

interface Wired {
  config: AppConfig;
  service: RagService;
  store: VectorStore;
  close: () => Promise<void>;
}

function wire(overrides: Partial<AppConfig['retrieval']> = {}): Wired {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const embedder = createEmbedder(config, logger);
  const chat = createChatModel(config, logger);
  const store = createVectorStore(config, logger);
  const retrieval = { ...config.retrieval, ...overrides };

  const service = new RagService({
    embedder,
    chat,
    store,
    logger,
    topK: retrieval.topK,
    candidateK: retrieval.candidateK,
    denseWeight: retrieval.denseWeight,
    sparseWeight: retrieval.sparseWeight,
    rrfK: retrieval.rrfK,
    rerank: retrieval.rerank,
    rerankTopN: retrieval.rerankTopN,
    minConfidence: retrieval.minConfidence,
    contextTokens: config.answering.contextTokens,
    maxSources: config.answering.maxSources,
    chatMaxTokens: config.chat.maxTokens,
  });

  return { config, service, store, close: () => store.close() };
}

/* ---------------------------------------------------------------- ingest */

program
  .command('ingest')
  .description('Walk a directory of markdown, chunk it, embed it and write it to the vector store')
  .argument('[dir]', 'directory of .md/.mdx files (defaults to DOCS_DIR)')
  .option('--force', 'ignore content hashes and re-embed everything', false)
  .option('--no-prune', 'keep documents that no longer exist on disk')
  .option('--json', 'emit the report as JSON', false)
  .action(
    async (dir: string | undefined, opts: { force: boolean; prune: boolean; json: boolean }) => {
      const { config, service, store, close } = wire();
      const logger = createLogger(config.logLevel);
      const root = resolve(dir ?? config.docsDir);

      try {
        const report = await ingestDirectory(root, {
          embedder: service.embedder,
          store,
          chunkOptions: config.chunking,
          embedBatchSize: config.embedder.batchSize,
          concurrency: config.embedder.concurrency,
          prune: opts.prune,
          force: opts.force,
          logger,
        });

        if (opts.json) {
          process.stdout.write(JSON.stringify(report, null, 2) + '\n');
        } else {
          process.stdout.write(
            [
              '',
              `Ingested ${root}`,
              renderTable(
                [{ header: 'Metric' }, { header: 'Value', align: 'right' }],
                [
                  ['files scanned', String(report.filesScanned)],
                  ['documents ingested', String(report.documentsIngested)],
                  ['documents unchanged (skipped)', String(report.documentsUnchanged)],
                  ['documents pruned', String(report.documentsPruned.length)],
                  ['chunks written', String(report.chunksWritten)],
                  ['chunks embedded', String(report.chunksEmbedded)],
                  ['chunks reused (hash hit)', String(report.chunksReused)],
                  ['embedding tokens', String(report.embeddingTokens)],
                  ['duration', `${report.durationMs} ms`],
                ],
              ),
              '',
            ].join('\n'),
          );
        }
      } finally {
        await close();
      }
    },
  );

/* ------------------------------------------------------------------- ask */

program
  .command('ask')
  .description('Answer a question from the ingested documentation, with verified citations')
  .argument('<question>', 'the question to answer')
  .option('-k, --top-k <n>', 'number of chunks to retrieve', (v) => Number(v))
  .option('--rerank', 'enable the LLM reranking pass')
  .option('--no-rerank', 'disable the LLM reranking pass')
  .option('--show-retrieval', 'print the fused candidate table before the answer', false)
  .option('--json', 'emit the full answer object as JSON', false)
  .action(
    async (
      question: string,
      opts: { topK?: number; rerank?: boolean; showRetrieval: boolean; json: boolean },
    ) => {
      const { service, close } = wire();
      try {
        const result = await service.ask(question, {
          ...(opts.topK ? { topK: opts.topK } : {}),
          ...(opts.rerank === undefined ? {} : { rerank: opts.rerank }),
        });

        if (opts.json) {
          process.stdout.write(JSON.stringify(result, null, 2) + '\n');
          return;
        }

        if (opts.showRetrieval) {
          process.stdout.write('\nRetrieval (fused candidates)\n');
          process.stdout.write(
            renderTable(
              [
                { header: '#', align: 'right' },
                { header: 'RRF', align: 'right' },
                { header: 'dense', align: 'right' },
                { header: 'bm25', align: 'right' },
                { header: 'rerank', align: 'right' },
                { header: 'source' },
              ],
              result.retrieved.map((r, i) => [
                String(i + 1),
                r.score.toFixed(5),
                r.denseRank === null ? '—' : `${(r.denseScore ?? 0).toFixed(3)} (#${r.denseRank})`,
                r.sparseRank === null
                  ? '—'
                  : `${(r.sparseScore ?? 0).toFixed(2)} (#${r.sparseRank})`,
                r.rerankScore === null ? '—' : r.rerankScore.toFixed(0),
                `${r.chunk.documentPath} › ${r.chunk.headingPath.join(' › ') || '(top)'}`,
              ]),
            ) + '\n',
          );
        }

        process.stdout.write(`\n${result.answer}\n`);

        if (result.citations.length > 0) {
          process.stdout.write('\nSources\n');
          for (const citation of result.citations) {
            process.stdout.write(
              `  [^${citation.n}] ${citation.file}` +
                (citation.headingPath ? ` › ${citation.headingPath}` : '') +
                `  (rrf ${citation.score.toFixed(5)})\n` +
                `        ${truncate(citation.excerpt, 150)}\n`,
            );
          }
        }

        if (result.droppedCitations.length > 0) {
          process.stdout.write(
            `\n! stripped ${result.droppedCitations.length} unverifiable citation marker(s): ` +
              `${[...new Set(result.droppedCitations)].join(', ')}\n`,
          );
        }

        process.stdout.write(
          `\nconfidence ${result.confidence.toFixed(3)}` +
            `${result.refused ? ' (below threshold — refused)' : ''}` +
            ` · embed ${Math.round(result.timings.embedMs)}ms` +
            ` · retrieve ${Math.round(result.timings.retrieveMs)}ms` +
            ` · rerank ${Math.round(result.timings.rerankMs)}ms` +
            ` · generate ${result.timings.generateMs}ms` +
            ` · total ${result.timings.totalMs}ms\n\n`,
        );
      } finally {
        await close();
      }
    },
  );

/* ------------------------------------------------------------------ eval */

program
  .command('eval')
  .description('Run the evaluation set and report recall@k, MRR and citation precision')
  .option('-q, --questions <path>', 'JSONL question set', 'eval/questions.jsonl')
  .option('-k, --ks <list>', 'comma-separated cut-offs for recall@k', '1,3,5,10')
  .option(
    '-m, --modes <list>',
    'comma-separated subset of: hybrid, dense, sparse',
    'hybrid,dense,sparse',
  )
  .option('--rerank', 'run the LLM reranker in every mode', false)
  .option('--json', 'emit raw metrics as JSON', false)
  .option('--per-question', 'print a per-question breakdown for the hybrid mode', false)
  .action(
    async (opts: {
      questions: string;
      ks: string;
      modes: string;
      rerank: boolean;
      json: boolean;
      perQuestion: boolean;
    }) => {
      const ks = opts.ks
        .split(',')
        .map((k) => Number(k.trim()))
        .filter((k) => Number.isInteger(k) && k > 0);
      const modes = opts.modes.split(',').map((m) => m.trim().toLowerCase());
      const questions = await loadQuestions(resolve(opts.questions));

      const weights: Record<string, { denseWeight: number; sparseWeight: number }> = {
        hybrid: { denseWeight: 1, sparseWeight: 1 },
        dense: { denseWeight: 1, sparseWeight: 0 },
        sparse: { denseWeight: 0, sparseWeight: 1 },
      };

      const reports: Array<{ mode: string; report: EvalReport }> = [];
      let providerLine = '';

      for (const mode of modes) {
        const weight = weights[mode];
        if (!weight) throw new Error(`unknown eval mode "${mode}" (expected hybrid|dense|sparse)`);
        const { config, service, close } = wire({ ...weight, rerank: opts.rerank });
        providerLine =
          `embedder=${service.embedder.id}  chat=${service.chat.id}  ` +
          `store=${config.store.provider}  rerank=${opts.rerank}`;
        try {
          // Abstention would hide retrieval failures behind refusals, so the
          // eval always generates an answer and lets citation precision speak.
          const report = await runEval(service, questions, {
            ks,
            measureCitations: true,
            rerank: opts.rerank,
          });
          reports.push({ mode, report });

          if (opts.perQuestion && mode === 'hybrid') {
            process.stdout.write('\nPer-question (hybrid)\n');
            process.stdout.write(
              renderTable(
                [
                  { header: 'id' },
                  { header: 'rank', align: 'right' },
                  { header: 'conf', align: 'right' },
                  { header: 'cites ok', align: 'right' },
                  { header: 'question' },
                ],
                report.results.map((r) => [
                  r.id,
                  r.firstRelevantRank === null ? 'miss' : String(r.firstRelevantRank),
                  r.confidence.toFixed(3),
                  `${r.citations.filter((c) => c.correct).length}/${r.citations.length}`,
                  truncate(r.question, 58),
                ]),
              ) + '\n',
            );
          }
        } finally {
          await close();
        }
      }

      if (opts.json) {
        process.stdout.write(
          JSON.stringify(
            reports.map((r) => ({ mode: r.mode, metrics: r.report.metrics })),
            null,
            2,
          ) + '\n',
        );
        return;
      }

      const columns = [
        { header: 'mode' as const },
        ...ks.map((k) => ({ header: `recall@${k}`, align: 'right' as const })),
        { header: 'MRR', align: 'right' as const },
        { header: 'citation prec.', align: 'right' as const },
        { header: 'cites', align: 'right' as const },
        { header: 'mean conf.', align: 'right' as const },
      ];

      const rows = reports.map(({ mode, report }) => [
        mode,
        ...ks.map((k) => percent(report.metrics.recallAtK[k] ?? 0)),
        fixed(report.metrics.mrr),
        percent(report.metrics.citationPrecision),
        String(report.metrics.citationsEmitted),
        fixed(report.metrics.meanConfidence),
      ]);

      process.stdout.write(
        [
          '',
          `Evaluation — ${questions.length} questions from ${opts.questions}`,
          providerLine,
          '',
          renderTable(columns, rows),
          '',
        ].join('\n'),
      );
    },
  );

/* ----------------------------------------------------------------- stats */

program
  .command('stats')
  .description('Show what is currently in the vector store')
  .option('--json', 'emit as JSON', false)
  .action(async (opts: { json: boolean }) => {
    const { config, service, store, close } = wire();
    try {
      await service.init();
      const stats = await store.stats();
      const payload = {
        store: config.store.provider,
        embedder: service.embedder.id,
        chat: service.chat.id,
        ...stats,
        averageChunkTokens: stats.chunks === 0 ? 0 : Math.round(stats.totalTokens / stats.chunks),
        averageChunksPerDocument:
          stats.documents === 0 ? 0 : Number((stats.chunks / stats.documents).toFixed(2)),
      };

      if (opts.json) {
        process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
        return;
      }

      process.stdout.write(
        '\n' +
          renderTable(
            [{ header: 'Property' }, { header: 'Value', align: 'right' }],
            [
              ['store', payload.store],
              ['embedder', payload.embedder],
              ['chat model', payload.chat],
              ['dimensions', String(payload.dimensions ?? 'n/a')],
              ['documents', String(payload.documents)],
              ['chunks', String(payload.chunks)],
              ['total chunk tokens', String(payload.totalTokens)],
              ['avg tokens / chunk', String(payload.averageChunkTokens)],
              ['avg chunks / document', String(payload.averageChunksPerDocument)],
            ],
          ) +
          '\n\n',
      );
    } finally {
      await close();
    }
  });

/* ----------------------------------------------------------------- serve */

program
  .command('serve')
  .description('Start the HTTP API (POST /ask with SSE streaming, POST /ingest, GET /healthz)')
  .action(async () => {
    const { startServer } = await import('./server.js');
    await startServer();
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  process.stderr.write(`\n${error instanceof Error ? error.message : String(error)}\n\n`);
  process.exitCode = 1;
});
