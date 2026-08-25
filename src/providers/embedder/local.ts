import { fnv1a32 } from '../../util/hash.js';
import { estimateTokens } from '../../util/tokens.js';
import type { EmbedResult, Embedder } from '../../types.js';
import { l2Normalize } from './vector-math.js';

export interface LocalEmbedderOptions {
  /** Output dimensionality. 512 is plenty for a docs-sized corpus. */
  dimensions?: number;
  /** Character n-gram sizes extracted from each word. */
  charNGrams?: number[];
  /** Weight applied to whole-word features relative to character n-grams. */
  wordWeight?: number;
  /** Weight applied to adjacent word-bigram features. */
  bigramWeight?: number;
}

/**
 * A deterministic, dependency-free, offline embedder.
 *
 * This is **not** a learned model and does not pretend to be. It is a classic
 * hashed n-gram ("feature hashing" / hashing-trick) text vectoriser, which is a
 * real information-retrieval technique and behaves like a bag-of-character-
 * n-grams TF vector projected into a fixed-width space:
 *
 *   1. Normalise text and split into words.
 *   2. Extract features: word unigrams, word bigrams, and character n-grams of
 *      length 3–5 taken from `#word#`-padded words (the padding lets prefixes
 *      and suffixes act as features, which is what gives morphological
 *      robustness — "install" vs "installing" share 6 of their n-grams).
 *   3. Accumulate each feature into a bucket chosen by a hash of the feature,
 *      with a **sign** taken from a second, independent hash.
 *   4. L2-normalise, so cosine similarity is a plain dot product.
 *
 * The signed hashing in step 3 is the important detail: unsigned feature hashing
 * makes every collision *add* mass, so unrelated documents drift toward each
 * other and the whole space develops a positive bias. With random signs,
 * collisions cancel in expectation (Weinberger et al., 2009), which keeps the
 * inner product an unbiased estimator of the true sparse-space inner product.
 *
 * Term weights use sublinear TF (`1 + ln(count)`) for the same reason BM25
 * saturates term frequency: the tenth occurrence of a word says much less than
 * the second.
 *
 * What it gives you: genuine lexical/morphological similarity, zero API keys,
 * byte-identical vectors on every machine — good enough to make the offline
 * demo and the test suite meaningful. What it does not give you: semantic
 * similarity between different words for the same concept ("shut down" vs
 * "terminate"). That is exactly what the BM25 half of the hybrid retriever is
 * also bad at, which is why the offline eval numbers in the README are reported
 * separately from what you would expect with a real embedding model.
 */
export class LocalEmbedder implements Embedder {
  readonly id: string;
  readonly dimensions: number;
  private readonly charNGrams: number[];
  private readonly wordWeight: number;
  private readonly bigramWeight: number;

  constructor(options: LocalEmbedderOptions = {}) {
    this.dimensions = options.dimensions ?? 512;
    if (this.dimensions < 16) throw new RangeError('dimensions must be >= 16');
    this.charNGrams = options.charNGrams ?? [3, 4, 5];
    this.wordWeight = options.wordWeight ?? 1.4;
    this.bigramWeight = options.bigramWeight ?? 0.8;
    this.id = `local-hashed-ngram-${this.dimensions}`;
  }

  async embed(texts: string[]): Promise<EmbedResult> {
    const vectors = texts.map((text) => this.embedOne(text));
    const tokens = texts.reduce((sum, t) => sum + estimateTokens(t), 0);
    return { vectors, tokens };
  }

  /** Synchronous single-text embedding — handy in tests and hot loops. */
  embedOne(text: string): number[] {
    const features = this.extractFeatures(text);
    const vector = new Array<number>(this.dimensions).fill(0);

    for (const [feature, rawCount] of features) {
      // Sublinear term-frequency scaling.
      const tf = 1 + Math.log(rawCount.count);
      const weight = tf * rawCount.weight;

      const h1 = fnv1a32(feature);
      // Second hash with a different offset basis — independent enough for signs.
      const h2 = fnv1a32(feature, 0x9e3779b1);
      const index = h1 % this.dimensions;
      const sign = (h2 & 1) === 0 ? 1 : -1;
      vector[index] = (vector[index] as number) + sign * weight;
    }

    return l2Normalize(vector);
  }

  private normalize(text: string): string[] {
    return (
      text
        // Split camelCase *before* lowercasing, so `maxRetries` contributes
        // `max` and `retries` as separate word features.
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .toLowerCase()
        // Strip combining marks so `café` and `cafe` hash to the same features.
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .match(/[a-z0-9]+/g) ?? []
    );
  }

  private extractFeatures(text: string): Map<string, { count: number; weight: number }> {
    const words = this.normalize(text);
    const features = new Map<string, { count: number; weight: number }>();

    const bump = (key: string, weight: number) => {
      const existing = features.get(key);
      if (existing) existing.count += 1;
      else features.set(key, { count: 1, weight });
    };

    for (let w = 0; w < words.length; w++) {
      const word = words[w] as string;
      bump(`w:${word}`, this.wordWeight);

      if (w + 1 < words.length) bump(`b:${word}_${words[w + 1]}`, this.bigramWeight);

      const padded = `#${word}#`;
      for (const n of this.charNGrams) {
        if (padded.length < n) continue;
        for (let i = 0; i + n <= padded.length; i++) {
          bump(`c${n}:${padded.slice(i, i + n)}`, 1);
        }
      }
    }
    return features;
  }
}
