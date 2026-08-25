/**
 * Bounded-concurrency map. Results keep input order.
 *
 * Written by hand rather than pulling in p-map: it is 25 lines, and embedding
 * throughput control is a place where you want to be able to read the code.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (concurrency < 1) throw new RangeError('concurrency must be >= 1');
  const results = new Array<R>(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index] as T, index);
    }
  });

  await Promise.all(runners);
  return results;
}

/** Split an array into fixed-size batches. */
export function batch<T>(items: readonly T[], size: number): T[][] {
  if (size < 1) throw new RangeError('batch size must be >= 1');
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
