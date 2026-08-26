/**
 * Default advisory feed for GHA062 — ships empty, so the check degrades to
 * "no findings" rather than erroring when nothing is supplied (#445
 * acceptance criteria: "degrades gracefully when the feed is unreachable").
 *
 * Per epic #350's design spine, the pure core never fetches: a live feed is
 * the CALLER's concern (a `chant audit` CLI flag reading a local JSON file,
 * a pre-fetched structure a hosted service passes in) — never a `fetch()`
 * inside a rule. This module documents the "nothing supplied" shape and is
 * what the shipped GHA062 check itself passes; a caller with a real feed
 * calls `checkAdvisories` (`../../post-synth/gha062`) directly with its own
 * `AdvisoryFeed`, the same way a `lint.policies` entry supplies GHA061 its
 * own `ActionUsagePolicy` (see `action-usage-policy.ts`).
 */

/** One disclosed advisory affecting a pinned action reference. */
export interface AdvisoryEntry {
  /** `owner/repo` slug the advisory applies to. */
  slug: string;
  /** Affected commit SHA(s) — for SHA-pinned refs. */
  shas?: string[];
  /** Affected tag/branch ref(s) — for refs still pinned to a mutable tag. */
  refs?: string[];
  /** Advisory identifier (e.g. a GHSA id). */
  id: string;
  /** Human-readable summary of the issue. */
  summary: string;
  /** A ref/SHA known to be patched, if the feed carries one. */
  patchedRef?: string;
  /** Link to the advisory. */
  url?: string;
}

export interface AdvisoryFeed {
  entries: AdvisoryEntry[];
}

export const DEFAULT_ADVISORY_FEED: AdvisoryFeed = { entries: [] };
