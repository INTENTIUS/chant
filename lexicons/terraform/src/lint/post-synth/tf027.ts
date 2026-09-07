/**
 * TF027: a live root's `policy` block sets `undeclared_untagged = "delete"`.
 *
 * The `undeclared_untagged` quadrant covers a live resource this estate never
 * marked and the configuration does not declare, a resource chant does not
 * own. `"delete"` there is account-scoped reconciliation: choudoufu compares
 * the configuration against everything a `scope` block reaches and removes
 * what is not in it. chant never proposes deleting a resource it does not
 * own, and neither does an Op it generates, so the setting is refused on any
 * live root the project builds, scoped or not. Narrowing the estate's own
 * ownership answer (`undeclared_tagged`, which TF026 checks against
 * `delete: "never"`) is the setting to reach for instead.
 *
 * `TerraformApplyOp` (`../../composites/terraform-apply-op.ts`) makes the
 * same refusal when it builds, but only for a project on a `chant.config.json`
 * whose root it can resolve synchronously (#2216): a `chant.config.ts` is
 * project-authored code that `resolveRootModeSync` will not evaluate, so the
 * composite reads the root as stock and never asks the policy question. This
 * check reads `props.mode` off the parsed HCL instead, which the build stamps
 * on every entity whatever the config file is written in, so it is the
 * refusal that actually fires. It also fires for a live root with no apply Op
 * at all, since the setting is a statement about the estate rather than about
 * one Op.
 *
 * One diagnostic per root, fired from the root's `Terraform::Live` entity,
 * the same entity TF024, TF025 and TF026 fire from.
 */

import type {
  PostSynthCheck,
  PostSynthContext,
  PostSynthDiagnostic,
} from "@intentius/chant/lint/post-synth";
import { isResourceDeclarable } from "@intentius/chant/declarable";
import { LIVE_TYPE, type BlockBody } from "../../hcl/parse";
import { policyBlockOf } from "./tf026";

export const tf027: PostSynthCheck = {
  id: "TF027",
  description: "Live root's policy block sets undeclared_untagged = \"delete\", which deletes resources chant does not own",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];
    const flagged = new Set<string>();

    for (const [name, entity] of ctx.entities) {
      if (entity.entityType !== LIVE_TYPE) continue;
      if (!isResourceDeclarable(entity)) continue;
      const props = entity.props as { root?: unknown; body?: unknown; mode?: unknown };
      if (props.mode !== "live") continue;
      const root = typeof props.root === "string" ? props.root : "";
      if (flagged.has(root)) continue;

      const body = (typeof props.body === "object" && props.body !== null ? props.body : {}) as BlockBody;
      const policy = policyBlockOf(body);
      if (!policy || policy["undeclared_untagged"] !== "delete") continue;

      flagged.add(root);
      diagnostics.push({
        checkId: "TF027",
        severity: "error",
        message:
          `Root module "${root}"'s policy block sets undeclared_untagged = "delete" (account-scoped ` +
          "reconciliation, scoped by a `scope` block). chant never proposes deleting a resource it does " +
          "not own, and neither does an Op it generates. Remove that setting from the policy block, or " +
          "narrow the estate's ownership answer (undeclared_tagged) instead of the account's.",
        entity: name,
        lexicon: "terraform",
      });
    }

    return diagnostics;
  },
};
