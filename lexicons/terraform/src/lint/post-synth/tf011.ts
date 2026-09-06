/**
 * TF011: a `variable` declares no `description`.
 *
 * A module's variables are its API. The description is what `terraform-docs`
 * renders into the README, what the HCP Terraform and Terraform Cloud variable
 * UI shows next to the input box, and what a caller reads before deciding what
 * to pass. Without it the only documentation is the variable's name.
 *
 * Report-only: this is documentation hygiene, filed the way KICS files it (as
 * INFO) and the way tflint files it (in the `all` preset, not `recommended`).
 */

import type {
  PostSynthCheck,
  PostSynthContext,
  PostSynthDiagnostic,
} from "@intentius/chant/lint/post-synth";
import { VARIABLE_TYPE } from "../../hcl/parse";
import { blockName, blocksOfType, isBlank } from "./blocks";

export const tf011: PostSynthCheck = {
  id: "TF011",
  description: "Variable declares no description",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const block of blocksOfType(ctx, VARIABLE_TYPE)) {
      if (!isBlank(block.body.description)) continue;

      diagnostics.push({
        checkId: "TF011",
        severity: "info",
        message:
          `Variable "${blockName(block.address)}" declares no \`description\`, so the module's ` +
          "generated documentation and the variable prompt have nothing to show but the name. Add a " +
          "description saying what the value is for and what a valid one looks like.",
        entity: block.key,
        lexicon: "terraform",
      });
    }

    return diagnostics;
  },
};
