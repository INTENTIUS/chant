/**
 * TF007: a variable default or a `locals` value holds a secret-shaped literal.
 *
 * This is the check tfsec shipped as `general-secrets-sensitive-in-variable`
 * and `general-secrets-sensitive-in-local`, and that trivy dropped when it
 * absorbed tfsec. #2107's survey found no maintained tool that has it today.
 *
 * A committed default or local is a credential in git history, which no later
 * edit removes, and Terraform copies it into state and into plan output on
 * every run. Both heuristics in `../secret-shape.ts` count: the name (a
 * variable called `db_password`) and the value (something shaped like a live
 * credential whatever it is called). References and interpolations are never
 * flagged, because passing the value in is the fix.
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
import { LOCALS_TYPE, VARIABLE_TYPE } from "../../hcl/parse";
import { secretShapedAssignment, type SecretShape } from "../secret-shape";
import { blockName, blocksOfType } from "./blocks";

/** Why the value was flagged, in the words of the heuristic that fired. */
function because(shape: SecretShape): string {
  return shape.reason === "value"
    ? `the value (${shape.length} characters, redacted here) matches a credential shape`
    : "the name reads like a credential and the value is a committed literal";
}

export const tf007: PostSynthCheck = {
  id: "TF007",
  description: "Secret-shaped literal in a variable default or a locals value",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const block of blocksOfType(ctx, VARIABLE_TYPE)) {
      const name = blockName(block.address);
      const shape = secretShapedAssignment(name, block.body.default);
      if (!shape) continue;
      diagnostics.push({
        checkId: "TF007",
        severity: "error",
        message:
          `Variable "${name}" defaults to what looks like a secret: ${because(shape)}. A default is ` +
          "committed to the repository and copied into state on every run. Remove it, mark the " +
          "variable `sensitive = true`, and pass the value from a secret store at apply time.",
        entity: block.key,
        lexicon: "terraform",
      });
    }

    for (const block of blocksOfType(ctx, LOCALS_TYPE)) {
      for (const [name, value] of Object.entries(block.body)) {
        const shape = secretShapedAssignment(name, value);
        if (!shape) continue;
        diagnostics.push({
          checkId: "TF007",
          severity: "error",
          message:
            `Local value "${name}" looks like a secret: ${because(shape)}. A local is a committed ` +
            "constant with no way to override it per environment. Read the value from a data source " +
            "or a sensitive variable instead.",
          entity: `${block.key}.${name}`,
          lexicon: "terraform",
        });
      }
    }

    return diagnostics;
  },
};
