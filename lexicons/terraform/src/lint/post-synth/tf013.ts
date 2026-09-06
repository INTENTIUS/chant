/**
 * TF013: `lifecycle { ignore_changes = all }`.
 *
 * `all` tells Terraform to ignore drift on every attribute of the resource
 * after it is created. Nothing about that resource is ever reconciled again:
 * a manual console edit, a deleted security-group rule, a downgraded instance
 * class, all of it plans clean forever. It is also silent, because a plan that
 * finds nothing looks exactly like a plan that was told to look at nothing.
 *
 * That is the observe half of chant's lifecycle switched off, so this is
 * merge-worthy rather than hygiene. A list of specific attributes is fine and
 * is not reported: ignoring `tags` an external tool writes is a real need, and
 * naming them is what makes the intent auditable.
 */

import type {
  PostSynthCheck,
  PostSynthContext,
  PostSynthDiagnostic,
} from "@intentius/chant/lint/post-synth";
import { DATA_TYPE, RESOURCE_TYPE } from "../../hcl/parse";
import { blocksOfTypes, nestedBodies } from "./blocks";

/**
 * `ignore_changes = all` parses to the string `"${all}"`: hcl2json renders the
 * bare keyword as an expression template. A list of attributes parses to an
 * array, so an array is only a match if `all` is the whole of it.
 */
function ignoresEverything(value: unknown): boolean {
  if (value === "${all}") return true;
  return Array.isArray(value) && value.length === 1 && value[0] === "${all}";
}

export const tf013: PostSynthCheck = {
  id: "TF013",
  description: "lifecycle ignore_changes is set to all",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const block of blocksOfTypes(ctx, [RESOURCE_TYPE, DATA_TYPE])) {
      for (const lifecycle of nestedBodies(block.body, "lifecycle")) {
        if (!ignoresEverything(lifecycle.ignore_changes)) continue;
        diagnostics.push({
          checkId: "TF013",
          severity: "warning",
          message:
            `"${block.address}" sets \`ignore_changes = all\`, so Terraform stops reconciling every ` +
            "attribute of the resource after it is created. Drift becomes invisible: a manual change " +
            "in the console plans clean forever. List the specific attributes to ignore instead.",
          entity: block.key,
          lexicon: "terraform",
        });
      }
    }

    return diagnostics;
  },
};
