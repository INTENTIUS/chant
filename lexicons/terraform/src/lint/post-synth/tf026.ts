/**
 * TF026: a live root declares `delete: "never"` but its `policy` block still
 * deletes an orphaned marked resource.
 *
 * chant's cross-lexicon delete-mode vocabulary (`terraform.roots.<name>.delete`,
 * `../../config.ts`'s `TerraformDeleteMode`) maps onto choudoufu's `policy`
 * block: `undeclared_tagged` governs what happens to a resource this estate
 * marked that the configuration no longer declares, and defaults to
 * `"delete"` when the `policy` block omits it, or the root declares no
 * `policy` block at all. `delete: "never"` promises that `TerraformApplyOp`
 * never proposes deleting a resource it owns, so a root making that promise
 * has to have actually turned the quadrant's default off — `"keep"`,
 * `"untag"` or `"report"` all satisfy it; anything else (the unset default,
 * or an explicit `"delete"`) does not.
 *
 * One diagnostic per root, fired from the root's `Terraform::Live` entity —
 * the same entity TF024 and TF025 fire from.
 */

import type {
  PostSynthCheck,
  PostSynthContext,
  PostSynthDiagnostic,
} from "@intentius/chant/lint/post-synth";
import { isResourceDeclarable } from "@intentius/chant/declarable";
import { LIVE_TYPE, type BlockBody } from "../../hcl/parse";

/** Verbs that satisfy `delete: "never"` for the `undeclared_tagged` quadrant. */
const SATISFIES_NEVER = new Set(["keep", "untag", "report"]);

/** The `policy { }` block nested in a `live { }` block's body, hcl2json's own "one block, wrapped in an array" shape. */
function policyBlockOf(liveBody: BlockBody): BlockBody | undefined {
  const policy = liveBody["policy"];
  return Array.isArray(policy) && policy.length > 0 && typeof policy[0] === "object" && policy[0] !== null
    ? (policy[0] as BlockBody)
    : undefined;
}

export const tf026: PostSynthCheck = {
  id: "TF026",
  description: "Live root declares delete: \"never\" but its policy leaves undeclared_tagged at \"delete\"",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];
    const flagged = new Set<string>();

    for (const [name, entity] of ctx.entities) {
      if (entity.entityType !== LIVE_TYPE) continue;
      if (!isResourceDeclarable(entity)) continue;
      const props = entity.props as { root?: unknown; body?: unknown; mode?: unknown; delete?: unknown };
      if (props.mode !== "live") continue;
      if (props.delete !== "never") continue;
      const root = typeof props.root === "string" ? props.root : "";
      if (flagged.has(root)) continue;

      const body = (typeof props.body === "object" && props.body !== null ? props.body : {}) as BlockBody;
      const policy = policyBlockOf(body);
      const undeclaredTagged = policy && typeof policy["undeclared_tagged"] === "string" ? (policy["undeclared_tagged"] as string) : undefined;
      if (undeclaredTagged !== undefined && SATISFIES_NEVER.has(undeclaredTagged)) continue;

      flagged.add(root);
      const found =
        undeclaredTagged === undefined
          ? "leaves undeclared_tagged unset, which defaults to \"delete\""
          : `sets undeclared_tagged = "${undeclaredTagged}"`;
      diagnostics.push({
        checkId: "TF026",
        severity: "error",
        message:
          `Root module "${root}" declares delete: "never" (terraform.roots.${root}.delete), but its ` +
          `policy block ${found}. Add undeclared_tagged = "keep" (or "untag" or "report") to the live ` +
          "block's policy block, or change this root's delete mode.",
        entity: name,
        lexicon: "terraform",
      });
    }

    return diagnostics;
  },
};
