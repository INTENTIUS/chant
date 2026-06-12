/**
 * GHA029: Unpinned Action or Reusable-Workflow Reference
 *
 * Flags any `uses:` (step action or job-level reusable workflow) that is pinned
 * to a mutable tag or branch instead of a full 40-character commit SHA. A tag
 * can be repointed to malicious code after review, so every external reference
 * is a supply-chain trust decision.
 *
 * `actions/checkout` is intentionally left to the more specific GHA021. Local
 * references (`./`, `../`) and `docker://` images (GHA030) are out of scope.
 * Owners in the trusted allowlist are exempt.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, extractActionRefs, parseActionUses } from "./yaml-helpers";
import { TRUSTED_ACTION_OWNERS } from "../rules/data/trusted-action-owners";

const SHA_RE = /^[0-9a-f]{40}$/;

export interface UnpinnedRef {
  job: string;
  ref: string;
  slug: string;
}

/**
 * Find every action/reusable-workflow `uses:` that is not pinned to a commit
 * SHA. Exposed as a pure function so the allowlist behaviour is testable.
 */
export function findUnpinnedActions(
  yaml: string,
  trustedOwners: ReadonlySet<string> = TRUSTED_ACTION_OWNERS,
): UnpinnedRef[] {
  const result: UnpinnedRef[] = [];
  for (const { job, ref } of extractActionRefs(yaml)) {
    const parsed = parseActionUses(ref);
    if (!parsed) continue; // local or docker:// reference
    if (parsed.slug === "actions/checkout") continue; // owned by GHA021
    if (trustedOwners.has(parsed.owner)) continue;
    if (SHA_RE.test(parsed.gitRef)) continue; // already pinned
    result.push({ job, ref, slug: parsed.slug });
  }
  return result;
}

export const gha029: PostSynthCheck = {
  id: "GHA029",
  description: "Action or reusable workflow not pinned to a commit SHA",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      for (const { job, ref } of findUnpinnedActions(yaml)) {
        diagnostics.push({
          checkId: "GHA029",
          severity: "warning",
          message: `Job "${job}" uses ${ref} pinned to a tag or branch — pin to a full commit SHA for supply-chain security.`,
          entity: job,
          lexicon: "github",
        });
      }
    }

    return diagnostics;
  },
};
