/**
 * Activity registry — resolves an Op step's `fn` name to a callable activity
 * implementation for local execution.
 *
 * The base activities are core's own (`./activities`): plain async functions
 * taking a single args object, with no workflow engine anywhere in the call
 * path. They are imported statically, so `loadActivities([])` works in a
 * project that has installed nothing but chant. Product-specific appliers stay
 * in their owning lexicon (#809) and are pulled in dynamically per the
 * project's configured lexicon list.
 */

import * as baseActivities from "./activities";
import { ACTIVITY_PROFILES, type ActivityProfile } from "./activity-profiles";

export type { ActivityProfile } from "./activity-profiles";

/**
 * An activity is an async function taking a single args object and an optional
 * `AbortSignal`. Local execution passes a signal that fires on timeout or
 * Ctrl-C so the activity can kill in-flight child processes; a hosted runtime
 * may invoke activities with args only, so the signal is always optional.
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
 * Build the activity map for local execution: core's base activities plus every
 * activity module the project's configured lexicons contribute, keyed by export
 * name (`shellCmd`, `kubectlApply`, `gcpApply`, …).
 *
 * Cloud-specific appliers live in their own lexicon (aws → `flociUp`/`flociDown`,
 * gcp → `gcpApply`, azure → `azGroupEnsure`/`azGroupDelete`), so `lexicons` —
 * the project's configured lexicon list — is consulted to pull those in. A
 * lexicon that ships no `op/activities` module is skipped.
 *
 * Never throws: the base library is a static import, so there is no "no
 * activities registered" state to report.
 */
export async function loadActivities(lexicons: string[] = []): Promise<Map<string, ActivityFn>> {
  const activities = new Map<string, ActivityFn>();

  collectActivities(baseActivities as unknown as Record<string, unknown>, activities);

  for (const name of lexicons) {
    try {
      const spec = `@intentius/chant-lexicon-${name}/op/activities`;
      collectActivities((await import(spec)) as Record<string, unknown>, activities);
    } catch {
      // Lexicon absent or contributes no activities — fine.
    }
  }

  return activities;
}

/**
 * The built-in profile table. Kept async because it is awaited on the CLI's
 * run path alongside {@link loadActivities}, and because a hosted runtime may
 * one day resolve profiles from somewhere less immediate.
 */
export async function loadProfiles(): Promise<Record<string, ActivityProfile>> {
  return ACTIVITY_PROFILES as unknown as Record<string, ActivityProfile>;
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
