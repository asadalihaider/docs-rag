import { createHash } from 'node:crypto';

/** SHA-256 hex digest. Used for content-addressing documents and chunks. */
export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * FNV-1a 32-bit. Fast, dependency-free, and good enough for the hashing trick
 * used by {@link LocalEmbedder} — we only need decorrelated bucket assignment,
 * not cryptographic strength.
 */
export function fnv1a32(input: string, seed = 0x811c9dc5): number {
  let hash = seed >>> 0;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i) & 0xff;
    // hash *= 16777619, done with shifts to stay in 32-bit integer space.
    hash = Math.imul(hash, 0x01000193) >>> 0;
    // Mix the high byte of the char code too, so non-ASCII text still spreads.
    hash ^= input.charCodeAt(i) >>> 8;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}
