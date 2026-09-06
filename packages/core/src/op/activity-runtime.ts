/**
 * Activity runtime helpers shared by every Op activity implementation, wherever
 * it lives — the base activities in `./activities` and the product-specific
 * appliers in the aws/gcp/azure/k8s/fly lexicons. Hosting them in core keeps a
 * lexicon from depending on another lexicon just to sleep between polls.
 */

/**
 * No-op.
 *
 * @deprecated Heartbeating was a liveness protocol between a Temporal worker
 * and a Temporal server. chant's ops run in-process on a machine that keeps
 * state and leaves a record (chant #2114), so nothing is listening for a
 * heartbeat and nothing acts on a missed one. An activity that wants to report
 * progress should write a line — the executor streams an activity's output with
 * the step record it belongs to.
 *
 * Kept as a call-compatible no-op so the lexicons that call it keep compiling;
 * it goes away with the rest of the Temporal surface.
 */
export function safeHeartbeat(_details?: unknown): void {
  // Intentionally empty.
}

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
