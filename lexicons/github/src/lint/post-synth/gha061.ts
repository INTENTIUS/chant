/**
 * GHA061: Action Reference Outside the Configured Usage Policy
 *
 * An opt-in allow/deny check over third-party `uses:` references, for
 * environments that constrain which external components may run at all —
 * distinct from GHA029/031/032, which judge a reference on its own pinning/
 * naming/health, not against an organizational decision about who is trusted.
 *
 * Ships silent: `DEFAULT_ACTION_USAGE_POLICY` (../rules/data/action-usage-
 * policy.ts) is empty, and {@link evaluateUsagePolicy} returns no findings
 * for an empty policy — see that module's doc for why (`PostSynthContext`
 * carries no per-check runtime config channel) and how a project actually
 * opts in: author a `lint.policies` entry that calls `evaluateUsagePolicy`
 * with its own policy, wrapped in a `PostSynthCheck`.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, extractActionRefs, parseActionUses } from "./yaml-helpers";
import { DEFAULT_ACTION_USAGE_POLICY, type ActionUsagePolicy } from "../rules/data/action-usage-policy";

export type { ActionUsagePolicy } from "../rules/data/action-usage-policy";

function matches(entry: string, owner: string, slug: string): boolean {
  if (entry === slug) return true;
  if (entry === owner) return true;
  if (entry.endsWith("/*") && entry.slice(0, -2) === owner) return true;
  return false;
}

function matchesAny(entries: string[] | undefined, owner: string, slug: string): boolean {
  return (entries ?? []).some((e) => matches(e, owner, slug));
}

/**
 * Evaluate a workflow's `uses:` references against a usage policy. Pure: no
 * fs, no network, no default policy baked in — an empty/unset policy (no
 * `allow` and no `deny`) always yields no findings, which is what makes this
 * genuinely opt-in rather than "opt-in by omission of one flag."
 */
export function evaluateUsagePolicy(yaml: string, policy: ActionUsagePolicy): PostSynthDiagnostic[] {
  const { allow, deny } = policy;
  if ((!allow || allow.length === 0) && (!deny || deny.length === 0)) return [];

  const diagnostics: PostSynthDiagnostic[] = [];
  for (const { job, ref } of extractActionRefs(yaml)) {
    const parsed = parseActionUses(ref);
    if (!parsed) continue; // local or docker:// reference — not a registry policy carries slugs for

    if (matchesAny(deny, parsed.owner, parsed.slug)) {
      diagnostics.push({
        checkId: "GHA061",
        severity: "error",
        message: `Job "${job}" uses "${parsed.slug}", which is denied by the configured action-usage policy.`,
        entity: job,
        lexicon: "github",
      });
      continue;
    }

    if (allow && allow.length > 0 && !matchesAny(allow, parsed.owner, parsed.slug)) {
      diagnostics.push({
        checkId: "GHA061",
        severity: "warning",
        message: `Job "${job}" uses "${parsed.slug}", which is not in the configured action-usage allowlist.`,
        entity: job,
        lexicon: "github",
      });
    }
  }
  return diagnostics;
}

export const gha061: PostSynthCheck = {
  id: "GHA061",
  description: "Action reference outside the configured usage policy (opt-in)",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];
    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      diagnostics.push(...evaluateUsagePolicy(yaml, DEFAULT_ACTION_USAGE_POLICY));
    }
    return diagnostics;
  },
};
