import { describe, expect, it } from 'vitest';
import { LocalEmbedder } from '../src/providers/embedder/local.js';
import { cosineSimilarity, l2Normalize } from '../src/providers/embedder/vector-math.js';

const embedder = new LocalEmbedder({ dimensions: 512 });
const sim = (a: string, b: string) => cosineSimilarity(embedder.embedOne(a), embedder.embedOne(b));

describe('LocalEmbedder', () => {
  it('is deterministic across instances and calls', async () => {
    const other = new LocalEmbedder({ dimensions: 512 });
    const a = embedder.embedOne('How do I install the CLI?');
    const b = other.embedOne('How do I install the CLI?');
    expect(a).toEqual(b);
    expect(embedder.embedOne('x')).toEqual(embedder.embedOne('x'));

    const batched = await embedder.embed(['one', 'two']);
    expect(batched.vectors[0]).toEqual(embedder.embedOne('one'));
    expect(batched.vectors[1]).toEqual(embedder.embedOne('two'));
    expect(batched.tokens).toBeGreaterThan(0);
  });

  it('produces L2-normalised vectors of the configured dimensionality', () => {
    for (const text of [
      'short',
      'a much longer piece of documentation text about scheduling',
      '```yaml\na: 1\n```',
    ]) {
      const vector = embedder.embedOne(text);
      expect(vector).toHaveLength(512);
      const norm = Math.sqrt(vector.reduce((s, v) => s + v * v, 0));
      expect(norm).toBeCloseTo(1, 10);
    }
    expect(new LocalEmbedder({ dimensions: 64 }).embedOne('x')).toHaveLength(64);
    expect(() => new LocalEmbedder({ dimensions: 4 })).toThrow(RangeError);
  });

  it('gives a text maximal similarity with itself', () => {
    expect(sim('lease expired', 'lease expired')).toBeCloseTo(1, 10);
  });

  // The property that makes this embedder useful rather than decorative:
  // genuinely similar text must land closer together than unrelated text.
  it('ranks related text above unrelated text', () => {
    const query = 'How do I install the command line tool?';

    const related = sim(query, 'Installing the command-line tool with Homebrew');
    const sameTopic = sim(query, 'Install the lark CLI using npm or a direct download');
    const unrelated = sim(query, 'Prometheus histogram buckets for database pool wait time');
    const nonsense = sim(query, 'zqxjkv wbmfhl prnvtg');

    expect(related).toBeGreaterThan(unrelated);
    expect(sameTopic).toBeGreaterThan(unrelated);
    expect(unrelated).toBeGreaterThan(nonsense);
    expect(related).toBeGreaterThan(0.3);
    expect(nonsense).toBeLessThan(0.15);
  });

  it('is robust to morphology, because character n-grams overlap across word forms', () => {
    // "install" vs "installing" share most of their padded character n-grams.
    expect(sim('install the worker', 'installing the worker')).toBeGreaterThan(0.75);
    expect(sim('retry policy', 'retries policy')).toBeGreaterThan(0.65);
    // ...but a shared morphology must not beat a genuine topical match.
    expect(sim('schedule a job with cron', 'scheduling jobs using cron')).toBeGreaterThan(
      sim('schedule a job with cron', 'scheduled maintenance of the office building'),
    );
  });

  it('degrades smoothly rather than cliff-edging as text diverges', () => {
    const base = 'the worker leases a run and renews the lease every ten seconds';
    const oneWordOff = 'the worker leases a run and renews the lease every twenty seconds';
    const halfShared = 'the worker leases a run from the control plane';
    const disjoint = 'parquet files are written to object storage nightly';

    expect(sim(base, oneWordOff)).toBeGreaterThan(sim(base, halfShared));
    expect(sim(base, halfShared)).toBeGreaterThan(sim(base, disjoint));
  });

  it('keeps unrelated documents near-orthogonal, which signed hashing is what buys', () => {
    const texts = [
      'cron expressions have five fields',
      'prometheus metrics are exposed on port 9842',
      'vault kv v2 paths include a data segment',
      'the npm package downloads a binary on postinstall',
      'audit rows are retained for a year',
    ];
    const sims: number[] = [];
    for (let i = 0; i < texts.length; i++) {
      for (let j = i + 1; j < texts.length; j++) {
        sims.push(sim(texts[i]!, texts[j]!));
      }
    }
    const mean = sims.reduce((a, b) => a + b, 0) / sims.length;
    // With unsigned feature hashing collisions only ever add mass and this mean
    // drifts up; with signed hashing they cancel in expectation.
    expect(mean).toBeLessThan(0.2);
    expect(Math.max(...sims)).toBeLessThan(0.4);
  });

  it('exposes a stable provider id that encodes the dimensionality', () => {
    expect(embedder.id).toBe('local-hashed-ngram-512');
    expect(new LocalEmbedder({ dimensions: 256 }).id).toBe('local-hashed-ngram-256');
  });
});

describe('vector math', () => {
  it('normalises in place and leaves a zero vector alone', () => {
    expect(l2Normalize([3, 4])).toEqual([0.6, 0.8]);
    expect(l2Normalize([0, 0])).toEqual([0, 0]);
  });

  it('computes cosine similarity, including for un-normalised input', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
    expect(cosineSimilarity([2, 0], [5, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(() => cosineSimilarity([1], [1, 2])).toThrow(/length mismatch/);
  });
});
