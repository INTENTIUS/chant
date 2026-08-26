/**
 * GHA062: Pinned Reference Matches a Known-Vulnerability Advisory
 *
 * Cross-references every pinned `uses:` (commit SHA or tag/branch) against a
 * caller-supplied advisory feed and flags a match. Unlike GHA031/032's
 * vendored, committed reference lists, a vulnerability feed is meant to be
 * refreshed continuously — so this rule takes it as data, not code: the pure
 * core never fetches (epic #350's design spine), and an absent/empty feed
 * degrades to "no findings," never an error or a thrown exception. That is
 * what "unreachable" means for a rule that makes no network call of its own:
 * whatever couldn't reach the feed already failed upstream of this function,
 * and this function's job is to not compound that with a crash.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, extractActionRefs, parseActionUses } from "./yaml-helpers";
import { DEFAULT_ADVISORY_FEED, type AdvisoryFeed, type AdvisoryEntry } from "../rules/data/advisory-feed";

export type { AdvisoryFeed, AdvisoryEntry } from "../rules/data/advisory-feed";

function matchesEntry(entry: AdvisoryEntry, slug: string, gitRef: string): boolean {
  if (entry.slug !== slug) return false;
  if (entry.shas?.includes(gitRef)) return true;
  if (entry.refs?.includes(gitRef)) return true;
  return false;
}

/**
 * Check a workflow's pinned action references against an advisory feed. Pure
 * and total: a missing/empty feed (`entries.length === 0`, including the
 * `undefined` default) always yields `[]`, never a throw.
 */
export function checkAdvisories(yaml: string, feed: AdvisoryFeed | undefined = DEFAULT_ADVISORY_FEED): PostSynthDiagnostic[] {
  if (!feed || !feed.entries || feed.entries.length === 0) return [];

  const diagnostics: PostSynthDiagnostic[] = [];
  for (const { job, ref } of extractActionRefs(yaml)) {
    const parsed = parseActionUses(ref);
    if (!parsed) continue;
    for (const entry of feed.entries) {
      if (!matchesEntry(entry, parsed.slug, parsed.gitRef)) continue;
      const patch = entry.patchedRef ? ` A patched ref is available: ${entry.patchedRef}.` : "";
      const link = entry.url ? ` (${entry.url})` : "";
      diagnostics.push({
        checkId: "GHA062",
        severity: "error",
        message: `Job "${job}" uses "${parsed.slug}@${parsed.gitRef}", which matches disclosed advisory ${entry.id}${link}: ${entry.summary}.${patch}`,
        entity: job,
        lexicon: "github",
      });
    }
  }
  return diagnostics;
}

export const gha062: PostSynthCheck = {
  id: "GHA062",
  description: "Pinned action reference matches a known-vulnerability advisory (feed-driven)",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];
    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      diagnostics.push(...checkAdvisories(yaml, DEFAULT_ADVISORY_FEED));
    }
    return diagnostics;
  },
};
