/**
 * TF006: a `sensitive = true` variable carries a `default`.
 *
 * Marking a variable sensitive is a statement that its value must not be seen.
 * A default is a value committed to the repository, so the two together are a
 * contradiction: the secret is in git, and the `sensitive` flag only hides it
 * from plan output, where it was never the exposure. It is also the shape that
 * survives longest, because every environment that forgets to pass the variable
 * silently gets the committed one.
 *
 * Any default counts, not only a secret-shaped one. `default = ""` and
 * `default = null` are the two that look harmless, and both make a required
 * secret optional, which is the other half of the failure.
 *
 * Scope: root and child modules alike (#2112). The condition is a property
 * of the block itself, so a descended module's block is read exactly as a
 * root's is.
 */

import type {
  PostSynthCheck,
  PostSynthContext,
  PostSynthDiagnostic,
} from "@intentius/chant/lint/post-synth";
import { VARIABLE_TYPE } from "../../hcl/parse";
import { blockName, blocksOfType } from "./blocks";

export const tf006: PostSynthCheck = {
  id: "TF006",
  description: "Sensitive variable declares a default value",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const block of blocksOfType(ctx, VARIABLE_TYPE)) {
      if (block.body.sensitive !== true) continue;
      if (!("default" in block.body)) continue;

      diagnostics.push({
        checkId: "TF006",
        severity: "error",
        message:
          `Variable "${blockName(block.address)}" is marked \`sensitive = true\` and declares a ` +
          "`default`. A default is committed to the repository, so the value the variable is meant " +
          "to protect is already public. Drop the default and require the value to be passed in.",
        entity: block.key,
        lexicon: "terraform",
      });
    }

    return diagnostics;
  },
};
