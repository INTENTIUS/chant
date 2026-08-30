/**
 * Default action-usage policy for GHA061 — opt-in, so it ships with an empty
 * allow/deny list: with nothing configured, GHA061 reports nothing (#445
 * acceptance criteria: "silent when unconfigured").
 *
 * `PostSynthContext` carries no per-check runtime config channel today (see
 * `trusted-action-owners.ts`'s doc for the same constraint), so — like that
 * file — this is a vendored, code-level default. A project that wants a real
 * policy doesn't edit this file: it authors a `lint.policies` entry
 * (`chant.config.ts`'s `lint.policies`, see `packages/core/src/lint/config.ts`)
 * that imports `evaluateUsagePolicy` from `../../post-synth/gha061` and calls
 * it with its own `ActionUsagePolicy`, wrapped in a `PostSynthCheck`. That is
 * the supported opt-in path; this default only documents the "nothing
 * configured" shape and is what the shipped GHA061 check itself passes.
 */

/**
 * An opt-in allow/deny policy over third-party action references.
 * Entries match an exact `owner/repo` slug, a bare `owner` (every repo under
 * that owner), or an `owner/*` wildcard (equivalent to a bare owner, offered
 * for readability). `deny` always wins over `allow` for an entry that somehow
 * appears in both.
 */
export interface ActionUsagePolicy {
  /** If set, any reference whose owner/slug isn't matched here is flagged. Unset = no allowlist restriction. */
  allow?: string[];
  /** Always flagged, regardless of `allow`. */
  deny?: string[];
}

export const DEFAULT_ACTION_USAGE_POLICY: ActionUsagePolicy = {};
