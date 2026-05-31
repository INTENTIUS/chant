/**
 * Activity heartbeat shim.
 *
 * Activities heartbeat so a Temporal worker knows they are still alive. Two
 * things make a naive `Context.current().heartbeat()` call unsafe outside a
 * worker:
 *
 *   1. `@temporalio/activity` may not be installed at all — chant's local
 *      executor runs these same activity implementations with no Temporal SDK
 *      present. A static `import` would make the entire activity library fail
 *      to load. So we resolve `Context` lazily via dynamic import and cache it.
 *   2. Even when installed, `Context.current()` throws when called outside an
 *      activity execution context. We swallow that too.
 *
 * Net effect: identical activity code heartbeats under a Temporal worker and
 * no-ops locally, and the activity library imports cleanly without the SDK.
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
 * single missed first tick is harmless.
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
