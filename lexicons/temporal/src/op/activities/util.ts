/** Shared helpers for activity implementations. */

/**
 * Sleep for `ms`, rejecting early if `signal` aborts. Polling activities use
 * this between attempts so a local-executor timeout or Ctrl-C interrupts the
 * wait instead of running it to completion.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
