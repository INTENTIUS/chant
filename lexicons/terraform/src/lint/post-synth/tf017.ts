/**
 * TF017: a `module` block carries `depends_on`.
 *
 * `depends_on` on a module applies to every resource inside it, including the
 * ones that had no reason to wait, so the whole module serializes behind the
 * named dependency and a plan that could have run in parallel does not. It
 * also makes the dependency invisible from inside the module, where the
 * resource that actually needed the ordering lives.
 *
 * Passing an attribute of the dependency into a module input creates the same
 * edge implicitly, only narrower and self-documenting.
 */

import type {
  PostSynthCheck,
  PostSynthContext,
  PostSynthDiagnostic,
} from "@intentius/chant/lint/post-synth";
import { MODULE_TYPE } from "../../hcl/parse";
import { blocksOfType } from "./blocks";

export const tf017: PostSynthCheck = {
  id: "TF017",
  description: "Module block uses depends_on",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const block of blocksOfType(ctx, MODULE_TYPE)) {
      if (!("depends_on" in block.body)) continue;

      diagnostics.push({
        checkId: "TF017",
        severity: "info",
        message:
          `"${block.address}" uses \`depends_on\`, which orders every resource in the module behind ` +
          "the dependency, not just the one that needs it. Pass an attribute of the dependency into " +
          "a module input instead, so Terraform derives the edge itself.",
        entity: block.key,
        lexicon: "terraform",
      });
    }

    return diagnostics;
  },
};
