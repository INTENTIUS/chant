/**
 * A limit on how many things run at once (#4625): members a pull request
 * plans at once (`pr-plan --parallelism`), and runs an op wave applies at
 * once (`parallelism` on the spec or a wave). A product's `parallelism`
 * maps onto both.
 */

/** Why `value` is not a parallelism, or undefined when it is one: a whole number of 1 or more. */
export function parallelismProblem(field: string, value: unknown): string | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value >= 1) return undefined;
  return `${field} is ${JSON.stringify(value)}; give a whole number of 1 or more, the most that run at once`;
}

/**
 * Run `fn` over `items` with at most `limit` in flight, results in the
 * items' order. Items start in order, and `fn` is called synchronously when
 * an item starts, so an item that awaits an earlier one's promise never
 * waits on one that has not started. No limit, or one at least the number
 * of items: all at once.
 */
export async function mapLimited<T, R>(items: readonly T[], limit: number | undefined, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  if (limit === undefined || limit >= items.length) return Promise.all(items.map((item, i) => fn(item, i)));
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, limit) }, worker));
  return out;
}

/**
 * Run `fn` alone among the calls with the same `key` (#4864): a call waits
 * for every earlier call with its key to settle, then runs, while calls
 * with other keys go on beside it. A call's failure is its own; the next
 * call with the key runs anyway.
 */
export type SerialSection = <T>(key: string, fn: () => Promise<T>) => Promise<T>;

/** A fresh {@link SerialSection}, whose keys are its own: an op wave makes one per wave job. */
export function keyedSerial(): SerialSection {
  const tails = new Map<string, Promise<unknown>>();
  return <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const before = tails.get(key) ?? Promise.resolve();
    const mine = before.then(() => fn());
    const tail = mine.then(
      () => undefined,
      () => undefined,
    );
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return mine;
  };
}
