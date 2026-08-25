import { describe, expect, it } from 'vitest';
import { MemoryVectorStore } from '../src/providers/store/memory.js';
import { LocalEmbedder } from '../src/providers/embedder/local.js';
import { MockChat } from '../src/providers/chat/mock.js';
import { RagService } from '../src/answer/service.js';
import { REFUSAL_TEXT } from '../src/answer/prompt.js';
import { chunkDocument } from '../src/ingest/chunker.js';
import { contextualText } from '../src/ingest/chunker.js';
import { makeDoc, ScriptedChat } from './helpers.js';
import type { EmbeddedChunk } from '../src/types.js';

const CORPUS = `# Larkspur Scheduling

Larkspur uses five-field cron expressions: minute, hour, day of month, month and
day of week. There is no seconds column and no year column.

## Timezones

The schedule.timezone field takes an IANA zone name and defaults to UTC. During a
daylight saving transition a wall clock time that occurs twice runs once.

## Jitter

The schedule.jitter field spreads runs of many jobs that share a schedule by
delaying each run a random duration between zero and the jitter value.
`;

async function buildService(
  options: { chat?: ScriptedChat | MockChat; minConfidence?: number } = {},
) {
  const embedder = new LocalEmbedder({ dimensions: 512 });
  const store = new MemoryVectorStore();
  await store.init(embedder.id, embedder.dimensions);

  const doc = makeDoc('scheduling.md', CORPUS, 'Scheduling');
  const chunks = chunkDocument(doc, { targetTokens: 120, maxTokens: 220, minTokens: 20 });
  const { vectors } = await embedder.embed(
    chunks.map((c) => contextualText({ documentTitle: doc.title, ...c })),
  );
  const embedded: EmbeddedChunk[] = chunks.map((c, i) => ({ ...c, embedding: vectors[i]! }));
  await store.upsertDocument(doc, embedded);

  const service = new RagService({
    embedder,
    store,
    chat: options.chat ?? new MockChat(),
    topK: 4,
    ...(options.minConfidence === undefined ? {} : { minConfidence: options.minConfidence }),
  });
  return { service, store, embedder };
}

describe('low-confidence refusal', () => {
  it('answers a question the corpus covers', async () => {
    const { service } = await buildService();
    const result = await service.ask('How many fields does a cron expression have?');

    expect(result.refused).toBe(false);
    expect(result.answer).not.toBe(REFUSAL_TEXT);
    expect(result.citations.length).toBeGreaterThan(0);
    expect(result.confidence).toBeGreaterThanOrEqual(0.3);
  });

  // The abstention path: a question about something the corpus has never heard of
  // must produce the refusal, not a confident answer stitched from noise.
  it('refuses a question the corpus cannot support, without calling the model', async () => {
    const chat = new ScriptedChat('I should never have been called. [^1]');
    const { service } = await buildService({ chat });

    const result = await service.ask(
      'What is the airspeed velocity of an unladen swallow in metres per second?',
    );

    expect(result.refused).toBe(true);
    expect(result.answer).toBe(REFUSAL_TEXT);
    expect(result.citations).toEqual([]);
    expect(result.confidence).toBeLessThan(0.3);
    // Not calling the model is the point: no tokens are spent guessing.
    expect(chat.requests).toHaveLength(0);
    expect(result.usage.completionTokens).toBe(0);
    expect(result.timings.generateMs).toBe(0);
  });

  it('still exposes the retrieval it rejected, so a refusal is debuggable', async () => {
    const { service } = await buildService();
    const result = await service.ask('quantum chromodynamics lattice gauge parameters');
    expect(result.refused).toBe(true);
    expect(result.retrieved.length).toBeGreaterThan(0);
  });

  it('honours a per-request confidence threshold in both directions', async () => {
    const { service } = await buildService();
    const question = 'How many fields does a cron expression have?';

    // An unreachable threshold turns a good answer into a refusal...
    const strict = await service.ask(question, { minConfidence: 0.99 });
    expect(strict.refused).toBe(true);

    // ...and a permissive one lets a weak match through.
    const loose = await service.ask('unrelated nonsense topic entirely', { minConfidence: 0 });
    expect(loose.refused).toBe(false);
  });

  it('refuses when the store is empty', async () => {
    const embedder = new LocalEmbedder({ dimensions: 512 });
    const store = new MemoryVectorStore();
    const service = new RagService({ embedder, store, chat: new MockChat() });
    const result = await service.ask('anything at all');

    expect(result.refused).toBe(true);
    expect(result.retrieved).toEqual([]);
    expect(result.confidence).toBe(0);
  });

  it('reports a refusal the model itself produced', async () => {
    // Retrieval was confident enough to call the model, but the model concluded
    // the passages do not answer the question.
    const chat = new ScriptedChat(REFUSAL_TEXT);
    const { service } = await buildService({ chat });
    const result = await service.ask('How many fields does a cron expression have?');

    expect(chat.requests).toHaveLength(1);
    expect(result.refused).toBe(true);
    expect(result.answer).toBe(REFUSAL_TEXT);
  });

  it('streams the refusal as a single token plus a final event', async () => {
    const { service } = await buildService();
    const events: string[] = [];
    let final: string | undefined;

    for await (const event of service.askStream('completely unrelated subject matter here')) {
      events.push(event.type);
      if (event.type === 'final') final = event.result.answer;
    }

    expect(events).toEqual(['retrieval', 'token', 'final']);
    expect(final).toBe(REFUSAL_TEXT);
  });
});
