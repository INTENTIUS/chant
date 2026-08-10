/**
 * CEDS010: a bare `permit(principal, action, resource);` is a standing grant
 *
 * The one policy that permits everything to everyone on everything. It is
 * valid Cedar, it is what a scaffolded policy looks like before anyone has
 * written the real one, and the Cedar validator says nothing about it — checked
 * directly against 4.12.0 (chant #1648): a schema-clean run over exactly this
 * policy returns zero errors, zero warnings, zero other warnings. There is no
 * upstream tool that will catch it, which is why the epic names this wall as a
 * definition-of-done item and why it lives here.
 *
 * The shape is unambiguous in the JSON: all three scopes unconstrained
 * (`op: "All"`) and no `when`/`unless` clause to narrow it. Anything with even
 * one constraint or one guard is somebody's deliberate decision and is not this
 * check's business (an unconstrained *action* alone is CEDS012).
 *
 * Severity is env-gated on the same `ctx.env` seam the k8s org-policy example
 * and the aws tier checks use: a production build fails, everything else warns,
 * so the scaffold-and-iterate loop stays workable while the thing that ships
 * cannot carry it.
 */
import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { conditionsOf, effectOf, isProdLikeEnv, parsedPolicySets, scopeIsAll } from "./cedar-helpers";

export const ceds010: PostSynthCheck = {
  id: "CEDS010",
  description: "A bare permit(principal, action, resource) with no scope constraints and no conditions grants everything",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];
    const prod = isProdLikeEnv(ctx.env);
    const severity = prod ? "error" : "warning";

    for (const set of parsedPolicySets(ctx)) {
      for (const entry of set.entries) {
        if (effectOf(entry.policy) !== "permit") continue;
        const policy = entry.policy;
        const bare =
          scopeIsAll(policy.principal) &&
          scopeIsAll(policy.action) &&
          scopeIsAll(policy.resource) &&
          conditionsOf(policy).length === 0;
        if (!bare) continue;

        diagnostics.push({
          checkId: "CEDS010",
          severity,
          message: `Policy "${entry.key}" is a bare permit(principal, action, resource) — every principal may take every action on every resource.${prod ? "" : " This is an error in a production build."} Constrain a scope or add a when/unless guard.`,
          entity: entry.key,
          lexicon: set.lexicon,
        });
      }
    }

    return diagnostics;
  },
};
