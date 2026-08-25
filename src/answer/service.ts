import { performance } from 'node:perf_hooks';
import type {
  AnswerResult,
  ChatModel,
  Citation,
  Embedder,
  FusedResult,
  VectorStore,
} from '../types.js';
import { HybridRetriever } from '../retrieval/hybrid.js';
import { rerank } from '../retrieval/rerank.js';
import { buildContext, type ContextSource } from './context.js';
import { ANSWER_SYSTEM_PROMPT, REFUSAL_TEXT, buildAnswerPrompt } from './prompt.js';
import { verifyCitations } from './citations.js';
import type { Logger } from '../util/logger.js';
import { silentLogger } from '../util/logger.js';

export interface RagServiceOptions {
  embedder: Embedder;
  chat: ChatModel;
  store: VectorStore;
  topK?: number;
  candidateK?: number;
  denseWeight?: number;
  sparseWeight?: number;
  rrfK?: number;
  rerank?: boolean;
  rerankTopN?: number;
  minConfidence?: number;
  contextTokens?: number;
  maxSources?: number;
  chatMaxTokens?: number;
  logger?: Logger;
}

export interface AskOptions {
  topK?: number;
  /** Retrieve and score, but skip the LLM call. Used by the eval harness. */
  retrieveOnly?: boolean;
  rerank?: boolean;
  minConfidence?: number;
}

/** Progressive events emitted by {@link RagService.askStream}. */
export type AskStreamEvent =
  | { type: 'retrieval'; results: FusedResult[]; confidence: number }
  | { type: 'token'; text: string }
  | { type: 'final'; result: AnswerResult }
  | { type: 'error'; message: string };

/**
 * The end-to-end pipeline: retrieve → (rerank) → budget → generate → verify.
 */
export class RagService {
  readonly embedder: Embedder;
  readonly chat: ChatModel;
  readonly store: VectorStore;
  private readonly retriever: HybridRetriever;
  private readonly options: Required<
    Omit<RagServiceOptions, 'embedder' | 'chat' | 'store' | 'logger'>
  >;
  private readonly logger: Logger;
  private initialised = false;

  constructor(options: RagServiceOptions) {
    this.embedder = options.embedder;
    this.chat = options.chat;
    this.store = options.store;
    this.logger = options.logger ?? silentLogger;
    this.options = {
      topK: options.topK ?? 6,
      candidateK: options.candidateK ?? 30,
      denseWeight: options.denseWeight ?? 1,
      sparseWeight: options.sparseWeight ?? 1,
      rrfK: options.rrfK ?? 60,
      rerank: options.rerank ?? false,
      rerankTopN: options.rerankTopN ?? 20,
      minConfidence: options.minConfidence ?? 0.3,
      contextTokens: options.contextTokens ?? 6000,
      maxSources: options.maxSources ?? 8,
      chatMaxTokens: options.chatMaxTokens ?? 1024,
    };
    this.retriever = new HybridRetriever({
      embedder: options.embedder,
      store: options.store,
      candidateK: this.options.candidateK,
      denseWeight: this.options.denseWeight,
      sparseWeight: this.options.sparseWeight,
      rrfK: this.options.rrfK,
    });
  }

  async init(): Promise<void> {
    if (this.initialised) return;
    await this.store.init(this.embedder.id, this.embedder.dimensions);
    this.initialised = true;
  }

  /** Retrieval + optional rerank + confidence, with no generation. */
  async retrieve(
    question: string,
    askOptions: AskOptions = {},
  ): Promise<{
    results: FusedResult[];
    confidence: number;
    timings: { embedMs: number; retrieveMs: number; rerankMs: number };
    embeddingTokens: number;
    rerankTokens: { prompt: number; completion: number };
  }> {
    await this.init();
    const topK = askOptions.topK ?? this.options.topK;
    const shouldRerank = askOptions.rerank ?? this.options.rerank;

    // When reranking, retrieve a wider net — the reranker can only reorder what
    // retrieval already found.
    const retrieveLimit = shouldRerank ? Math.max(topK, this.options.rerankTopN) : topK;
    const retrieval = await this.retriever.retrieve(question, retrieveLimit);

    let results = retrieval.results;
    let rerankMs = 0;
    let rerankTokens = { prompt: 0, completion: 0 };

    if (shouldRerank && results.length > 1) {
      const start = performance.now();
      const reranked = await rerank(question, results, {
        chat: this.chat,
        topN: this.options.rerankTopN,
        logger: this.logger,
      });
      results = reranked.results;
      rerankTokens = { prompt: reranked.promptTokens, completion: reranked.completionTokens };
      rerankMs = performance.now() - start;
    }

    // Confidence comes from the retriever, which sees the full candidate lists
    // before fusion and truncation, so it does not depend on topK.
    return {
      results: results.slice(0, topK),
      confidence: retrieval.confidence,
      timings: {
        embedMs: retrieval.timings.embedMs,
        retrieveMs: retrieval.timings.searchMs,
        rerankMs,
      },
      embeddingTokens: retrieval.embeddingTokens,
      rerankTokens,
    };
  }

  async ask(question: string, askOptions: AskOptions = {}): Promise<AnswerResult> {
    const started = performance.now();
    const retrieval = await this.retrieve(question, askOptions);
    const minConfidence = askOptions.minConfidence ?? this.options.minConfidence;

    const base = {
      retrieved: retrieval.results,
      confidence: retrieval.confidence,
      usage: {
        embeddingTokens: retrieval.embeddingTokens,
        promptTokens: retrieval.rerankTokens.prompt,
        completionTokens: retrieval.rerankTokens.completion,
      },
    };

    if (retrieval.results.length === 0 || retrieval.confidence < minConfidence) {
      this.logger.info('refusing: low retrieval confidence', {
        question,
        confidence: Number(retrieval.confidence.toFixed(4)),
        threshold: minConfidence,
      });
      return {
        ...base,
        answer: REFUSAL_TEXT,
        citations: [],
        refused: true,
        droppedCitations: [],
        timings: {
          ...retrieval.timings,
          generateMs: 0,
          totalMs: Math.round(performance.now() - started),
        },
      };
    }

    const context = this.prepareContext(retrieval.results);
    if (askOptions.retrieveOnly) {
      return {
        ...base,
        answer: '',
        citations: context.sources.map(sourceToCitation),
        refused: false,
        droppedCitations: [],
        timings: {
          ...retrieval.timings,
          generateMs: 0,
          totalMs: Math.round(performance.now() - started),
        },
      };
    }

    const generateStart = performance.now();
    const response = await this.chat.complete({
      task: 'answer',
      maxTokens: this.options.chatMaxTokens,
      messages: [
        { role: 'system', content: ANSWER_SYSTEM_PROMPT },
        { role: 'user', content: buildAnswerPrompt(question, context.sources) },
      ],
      hints: {
        question,
        sources: context.sources.map((s) => ({
          n: s.n,
          file: s.file,
          headingPath: s.headingPath,
          content: s.result.chunk.content,
        })),
      },
    });
    const generateMs = performance.now() - generateStart;

    const verified = verifyCitations(response.text, context.sources, { logger: this.logger });

    return {
      ...base,
      answer: verified.text,
      citations: verified.citations,
      refused: verified.text.trim() === REFUSAL_TEXT,
      droppedCitations: verified.dropped,
      usage: {
        embeddingTokens: retrieval.embeddingTokens,
        promptTokens: retrieval.rerankTokens.prompt + response.promptTokens,
        completionTokens: retrieval.rerankTokens.completion + response.completionTokens,
      },
      timings: {
        ...retrieval.timings,
        generateMs: Math.round(generateMs),
        totalMs: Math.round(performance.now() - started),
      },
    };
  }

  /**
   * Streaming variant.
   *
   * Tokens are forwarded as they arrive, but citation verification needs the
   * complete answer — you cannot know a `[^3]` is valid until you have seen it,
   * and you cannot renumber until you know which markers survived. So the stream
   * emits raw tokens for perceived latency and then a `final` event carrying the
   * verified text plus citations; a client should render the streamed text and
   * then replace it with `final.result.answer`.
   */
  async *askStream(question: string, askOptions: AskOptions = {}): AsyncGenerator<AskStreamEvent> {
    const started = performance.now();
    const retrieval = await this.retrieve(question, askOptions);
    const minConfidence = askOptions.minConfidence ?? this.options.minConfidence;

    yield { type: 'retrieval', results: retrieval.results, confidence: retrieval.confidence };

    const base = {
      retrieved: retrieval.results,
      confidence: retrieval.confidence,
    };

    if (retrieval.results.length === 0 || retrieval.confidence < minConfidence) {
      this.logger.info('refusing: low retrieval confidence', {
        question,
        confidence: Number(retrieval.confidence.toFixed(4)),
        threshold: minConfidence,
      });
      yield { type: 'token', text: REFUSAL_TEXT };
      yield {
        type: 'final',
        result: {
          ...base,
          answer: REFUSAL_TEXT,
          citations: [],
          refused: true,
          droppedCitations: [],
          usage: {
            embeddingTokens: retrieval.embeddingTokens,
            promptTokens: retrieval.rerankTokens.prompt,
            completionTokens: retrieval.rerankTokens.completion,
          },
          timings: {
            ...retrieval.timings,
            generateMs: 0,
            totalMs: Math.round(performance.now() - started),
          },
        },
      };
      return;
    }

    const context = this.prepareContext(retrieval.results);
    const generateStart = performance.now();
    let raw = '';

    for await (const token of this.chat.stream({
      task: 'answer',
      maxTokens: this.options.chatMaxTokens,
      messages: [
        { role: 'system', content: ANSWER_SYSTEM_PROMPT },
        { role: 'user', content: buildAnswerPrompt(question, context.sources) },
      ],
      hints: {
        question,
        sources: context.sources.map((s) => ({
          n: s.n,
          file: s.file,
          headingPath: s.headingPath,
          content: s.result.chunk.content,
        })),
      },
    })) {
      raw += token;
      yield { type: 'token', text: token };
    }

    const generateMs = performance.now() - generateStart;
    const verified = verifyCitations(raw, context.sources, { logger: this.logger });

    yield {
      type: 'final',
      result: {
        ...base,
        answer: verified.text,
        citations: verified.citations,
        refused: verified.text.trim() === REFUSAL_TEXT,
        droppedCitations: verified.dropped,
        usage: {
          embeddingTokens: retrieval.embeddingTokens,
          // Streaming APIs do not always report prompt tokens; estimated usage
          // for the non-streaming path is exact, this one is best-effort.
          promptTokens: retrieval.rerankTokens.prompt,
          completionTokens: retrieval.rerankTokens.completion,
        },
        timings: {
          ...retrieval.timings,
          generateMs: Math.round(generateMs),
          totalMs: Math.round(performance.now() - started),
        },
      },
    };
  }

  private prepareContext(results: FusedResult[]): { sources: ContextSource[] } {
    const context = buildContext(results, {
      tokenBudget: this.options.contextTokens,
      maxSources: this.options.maxSources,
    });
    if (context.dropped.length > 0) {
      this.logger.debug('dropped low-ranked chunks to fit context budget', {
        dropped: context.dropped.length,
        kept: context.sources.length,
        tokens: context.tokens,
      });
    }
    return { sources: context.sources };
  }
}

function sourceToCitation(source: ContextSource): Citation {
  return {
    n: source.n,
    file: source.file,
    headingPath: source.result.chunk.headingPath.join(' > '),
    score: source.result.score,
    excerpt: source.result.chunk.content.slice(0, 240),
    chunkId: source.result.chunk.id,
  };
}
