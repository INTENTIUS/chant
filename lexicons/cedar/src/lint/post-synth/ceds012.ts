/**
 * CEDS012: a `permit` over every action is IAM's `"Action": "*"`
 *
 * A permit that names a principal or a resource but leaves `action`
 * unconstrained grants every action Cedar's schema defines on that target —
 * including the ones added next quarter, which is what makes it different from
 * a wide-but-enumerated grant. The author almost always meant a specific verb
 * or a group (`action in [Action::"read", Action::"list"]`).
 *
 * Scoped deliberately narrow so it does not double-report: a policy with *no*
 * constraint anywhere and no guard is a bare permit, which is CEDS010's
 * finding and a more serious one. This check speaks only to a policy that
 * constrained something and then left the verb open.
 */
import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { conditionsOf, effectOf, parsedPolicySets, scopeIsAll } from "./cedar-helpers";

export const ceds012: PostSynthCheck = {
  id: "CEDS012",
  description: "A permit that leaves the action scope unconstrained grants every action, including future ones",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const set of parsedPolicySets(ctx)) {
      for (const entry of set.entries) {
        const policy = entry.policy;
        if (effectOf(policy) !== "permit") continue;
        if (!scopeIsAll(policy.action)) continue;

        // The everything-permit belongs to CEDS010.
        const narrowedElsewhere =
          !scopeIsAll(policy.principal) ||
          !scopeIsAll(policy.resource) ||
          conditionsOf(policy).length > 0;
        if (!narrowedElsewhere) continue;

        diagnostics.push({
          checkId: "CEDS012",
          severity: "warning",
          message: `Policy "${entry.key}" permits every action — the action scope is unconstrained, so the grant widens on its own as the schema gains actions. Name the actions it needs (action == Action::"read", or action in [ … ]).`,
          entity: entry.key,
          lexicon: set.lexicon,
        });
      }
    }

    return diagnostics;
  },
};
