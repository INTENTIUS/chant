/**
 * Bounded concurrency — chant #1074's "a 100-entity project is not 100 serial
 * spawns" criterion.
 *
 * Unbounded is not the answer either: firing 400 requests at an API server in
 * one tick gets the client throttled (429) or the apiserver's priority-and-
 * fairness queue drops it, and both look like read failures rather than what
 * they are. A small fixed window is what `kubectl` itself uses for parallel
 * gets.
 */

/** Default in-flight request ceiling. */
export const DEFAULT_CONCURRENCY = 8;

/**
 * Map `items` through `fn` with at most `limit` running at once, preserving
 * input order in the result. Never rejects: `fn`'s own rejections are the
 * caller's to model (the observation path turns each into a per-entity
 * verdict), so `fn` is expected to resolve with a discriminated outcome.
 */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<R>,
  limit: number = DEFAULT_CONCURRENCY,
): Promise<R[]> {
  const width = Math.max(1, Math.min(limit, items.length));
  const results = new Array<R>(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: width }, () => worker()));
  return results;
}
