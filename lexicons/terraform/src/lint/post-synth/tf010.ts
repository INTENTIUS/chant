/**
 * TF010: a `variable` declares no `type`.
 *
 * Without a type constraint Terraform accepts whatever it is given and infers
 * the type from the value, so a variable meant to be a list arrives as a
 * string from a `TF_VAR_` environment variable, or a number arrives as `"3"`
 * from a tfvars file, and the failure surfaces deep inside a resource
 * argument rather than at the module boundary where it was introduced.
 *
 * A blank `type` counts as absent, matching KICS, which fails a `type` that
 * trims to empty.
 */

import type {
  PostSynthCheck,
  PostSynthContext,
  PostSynthDiagnostic,
} from "@intentius/chant/lint/post-synth";
import { VARIABLE_TYPE } from "../../hcl/parse";
import { blockName, blocksOfType, isBlank } from "./blocks";

export const tf010: PostSynthCheck = {
  id: "TF010",
  description: "Variable declares no type constraint",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const block of blocksOfType(ctx, VARIABLE_TYPE)) {
      if (!isBlank(block.body.type)) continue;

      diagnostics.push({
        checkId: "TF010",
        severity: "info",
        message:
          `Variable "${blockName(block.address)}" declares no \`type\`, so Terraform accepts any ` +
          "value and infers the type from whatever it is given. Add a type constraint " +
          "(`string`, `number`, `bool`, `list(string)`, an `object({...})`) so a wrong value is " +
          "rejected at the module boundary.",
        entity: block.key,
        lexicon: "terraform",
      });
    }

    return diagnostics;
  },
};
