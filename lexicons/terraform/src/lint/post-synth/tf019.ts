/**
 * TF019: a meta-argument is explicitly set to its own default, `false`.
 *
 * `sensitive` and `ephemeral` on a `variable` or an `output`, `prevent_destroy`
 * and `create_before_destroy` inside a `lifecycle` block. All four default to
 * false, so writing it changes nothing and reads as though someone considered
 * the setting and turned it off, which is exactly the impression a reviewer
 * should not get from a variable called `password`.
 *
 * The first TF rule with a mechanical fix: the remediation is the deletion of
 * the line, so this ships `fixKind: "deterministic"` and `chant audit` renders
 * the diff in its quick-wins section. `packages/core/src/audit/proof.ts` owns
 * the patch, as it does for every other deterministic rule.
 *
 * Only a literal `false` counts. `prevent_destroy = var.protect` is a real
 * decision expressed as a variable, and hcl2json leaves it a `"${var.protect}"`
 * string rather than a boolean, so it never reaches the comparison.
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
import { DATA_TYPE, OUTPUT_TYPE, RESOURCE_TYPE, VARIABLE_TYPE } from "../../hcl/parse";
import { blocksOfTypes, nestedBodies, type TerraformBlock } from "./blocks";

/** Meta-arguments that default to false on a `variable` or an `output`. */
const BLOCK_ARGS = ["sensitive", "ephemeral"] as const;
/** Meta-arguments that default to false inside a `lifecycle` block. */
const LIFECYCLE_ARGS = ["prevent_destroy", "create_before_destroy"] as const;

function redundant(block: TerraformBlock, arg: string, where: string): PostSynthDiagnostic {
  return {
    checkId: "TF019",
    severity: "info",
    message:
      `"${block.address}" sets \`${arg} = false\`${where}, which is already the default. Declaring a ` +
      "default reads as a deliberate decision to turn the behaviour off. Delete the line.",
    entity: `${block.key}.${arg}`,
    lexicon: "terraform",
  };
}

export const tf019: PostSynthCheck = {
  id: "TF019",
  description: "Meta-argument explicitly set to its default of false",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const block of blocksOfTypes(ctx, [VARIABLE_TYPE, OUTPUT_TYPE])) {
      for (const arg of BLOCK_ARGS) {
        if (block.body[arg] === false) diagnostics.push(redundant(block, arg, ""));
      }
    }

    for (const block of blocksOfTypes(ctx, [RESOURCE_TYPE, DATA_TYPE])) {
      for (const lifecycle of nestedBodies(block.body, "lifecycle")) {
        for (const arg of LIFECYCLE_ARGS) {
          if (lifecycle[arg] === false) diagnostics.push(redundant(block, arg, " in its `lifecycle` block"));
        }
      }
    }

    return diagnostics;
  },
};
