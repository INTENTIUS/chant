/**
 * Activity registry — resolves an Op step's `fn` name to a callable activity
 * implementation for local execution.
 *
 * Activities live in the Temporal lexicon (`@intentius/chant-lexicon-temporal`)
 * but are plain async functions taking a single args object — Temporal-free to
 * call. Local mode loads them by name instead of registering them with a worker.
 */

/**
 * An activity is an async function taking a single args object and an optional
 * `AbortSignal`. Local execution passes a signal that fires on timeout or
 * Ctrl-C so the activity can kill in-flight child processes; the Temporal
 * worker invokes activities with args only (cancellation comes from its own
 * `Context`), so the signal is always optional.
 */
export type ActivityFn = (args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;

/**
 * Dynamically import the Temporal lexicon's activity library and return a map
 * of every exported function keyed by its export name (`shellCmd`, `chantBuild`,
 * `kubectlApply`, …).
 *
 * Throws a friendly error if the lexicon is not installed — local execution
 * needs the activity implementations even though it never starts a worker.
 */
export async function loadActivities(): Promise<Map<string, ActivityFn>> {
  let mod: Record<string, unknown>;
  try {
    // Variable specifier so tsc does not statically resolve the optional dep.
    const spec = "@intentius/chant-lexicon-temporal/op/activities";
    mod = (await import(spec)) as Record<string, unknown>;
  } catch {
    throw new Error(
      "no activities registered — install `@intentius/chant-lexicon-temporal`",
    );
  }

  const activities = new Map<string, ActivityFn>();
  for (const [name, value] of Object.entries(mod)) {
    if (typeof value === "function") {
      activities.set(name, value as ActivityFn);
    }
  }
  return activities;
}

/** Structural shape of a TEMPORAL_ACTIVITY_PROFILES entry (timeout + retry). */
export interface ActivityProfile {
  startToCloseTimeout?: string;
  heartbeatTimeout?: string;
  retry?: {
    initialInterval?: string;
    backoffCoefficient?: number;
    maximumAttempts?: number;
    maximumInterval?: string;
    /** Error names (`Error.name`) that should fail immediately without retry. */
    nonRetryableErrorTypes?: string[];
  };
}

/**
 * Dynamically import the lexicon's `TEMPORAL_ACTIVITY_PROFILES` (pure data, no
 * Temporal SDK). Returns an empty record if the lexicon is absent — the
 * executor then falls back to built-in defaults per step.
 */
export async function loadProfiles(): Promise<Record<string, ActivityProfile>> {
  try {
    const spec = "@intentius/chant-lexicon-temporal";
    const mod = (await import(spec)) as { TEMPORAL_ACTIVITY_PROFILES?: Record<string, ActivityProfile> };
    return mod.TEMPORAL_ACTIVITY_PROFILES ?? {};
  } catch {
    return {};
  }
}

/**
 * Resolve a step's `fn` against the loaded activity map.
 * Throws a clear error listing known names if the activity is missing.
 */
export function resolveActivity(
  activities: Map<string, ActivityFn>,
  fn: string,
): ActivityFn {
  const activity = activities.get(fn);
  if (!activity) {
    const known = [...activities.keys()].sort().join(", ");
    throw new Error(`no activity named "${fn}" (known: ${known})`);
  }
  return activity;
}
