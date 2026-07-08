/**
 * Activity runtime helpers shared by every Op activity implementation, wherever
 * it lives — the base activities in the temporal lexicon and the cloud-specific
 * appliers relocated into the aws/gcp/azure lexicons. Hosting them in core keeps
 * a cloud lexicon from having to depend on the temporal lexicon just to
 * heartbeat or sleep.
 */

interface ActivityContext {
  current(): { heartbeat(details?: unknown): void };
}

// undefined = not yet attempted; null = unavailable; object = resolved Context.
let cachedContext: ActivityContext | null | undefined;
let loading: Promise<void> | undefined;

function ensureContext(): void {
  if (cachedContext !== undefined || loading) return;
  // Variable specifier so bundlers/tsc do not statically require the optional dep.
  const spec = "@temporalio/activity";
  loading = import(spec)
    .then((mod: unknown) => {
      cachedContext = (mod as { Context?: ActivityContext }).Context ?? null;
    })
    .catch(() => {
      cachedContext = null;
    });
}

/**
 * Emit an activity heartbeat if running under a Temporal worker; otherwise no-op.
 *
 * The first call kicks off a one-time lazy load of `@temporalio/activity` and
 * returns immediately; once resolved, subsequent calls heartbeat. Heartbeats
 * are periodic (every ~15s, well inside the 60s heartbeat timeout), so the
 * single missed first tick is harmless. Under chant's local executor (no
 * Temporal SDK present) it no-ops, and the module imports cleanly without the SDK.
 */
export function safeHeartbeat(details?: unknown): void {
  if (cachedContext === undefined) {
    ensureContext();
    return;
  }
  if (cachedContext === null) return;
  try {
    cachedContext.current().heartbeat(details);
  } catch {
    // Not inside an activity execution context — nothing to do.
  }
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
