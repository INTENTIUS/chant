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

/** Add every exported function from an activity module to `into`, keyed by name. */
function collectActivities(mod: Record<string, unknown>, into: Map<string, ActivityFn>): void {
  for (const [name, value] of Object.entries(mod)) {
    if (typeof value === "function") {
      into.set(name, value as ActivityFn);
    }
  }
}

/**
 * Build the activity map for local execution by importing activity libraries and
 * keying every exported function by name (`shellCmd`, `kubectlApply`, `gcpApply`, …).
 *
 * The base activities always live in the temporal lexicon. Cloud-specific
 * appliers live in their own lexicon (aws → `flociUp`/`flociDown`, gcp →
 * `gcpApply`, azure → `azGroupEnsure`/`azGroupDelete`), so `lexicons` — the
 * project's configured lexicon list — is consulted to pull those in. A lexicon
 * that ships no `op/activities` module is skipped.
 *
 * Throws only if the temporal base library is missing — local execution needs
 * the activity implementations even though it never starts a worker.
 */
export async function loadActivities(lexicons: string[] = []): Promise<Map<string, ActivityFn>> {
  const activities = new Map<string, ActivityFn>();

  try {
    // Variable specifier so tsc does not statically resolve the optional dep.
    const spec = "@intentius/chant-lexicon-temporal/op/activities";
    collectActivities((await import(spec)) as Record<string, unknown>, activities);
  } catch {
    throw new Error(
      "no activities registered — install `@intentius/chant-lexicon-temporal`",
    );
  }

  for (const name of lexicons) {
    if (name === "temporal") continue;
    try {
      const spec = `@intentius/chant-lexicon-${name}/op/activities`;
      collectActivities((await import(spec)) as Record<string, unknown>, activities);
    } catch {
      // Lexicon absent or contributes no activities — fine.
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
 *
 * Imports the lexicon's `/config` entry, not its root index. `/config` is a
 * side-effect-free data module; the root index pulls in the plugin, serializer,
 * composites, and re-exported Op machinery, any of which could throw on load
 * and make this silently return `{}` — which would drop every profiled step to
 * the 5-minute default while the Temporal path (reading the same table) kept the
 * declared timeout. Importing the narrow module keeps the two executors agreed.
 */
export async function loadProfiles(): Promise<Record<string, ActivityProfile>> {
  try {
    const spec = "@intentius/chant-lexicon-temporal/config";
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
