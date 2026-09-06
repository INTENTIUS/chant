/**
 * TF012: an `output` declares no `description`.
 *
 * The other half of a module's API. An output is what a caller wires into the
 * next module, and the description is the only place to say what the value
 * actually is (an id or an ARN, a full URL or a bare hostname) and whether it
 * is stable enough to depend on.
 *
 * Report-only, for the same reason TF011 is.
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
import { OUTPUT_TYPE } from "../../hcl/parse";
import { blockName, blocksOfType, isBlank } from "./blocks";

export const tf012: PostSynthCheck = {
  id: "TF012",
  description: "Output declares no description",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const block of blocksOfType(ctx, OUTPUT_TYPE)) {
      if (!isBlank(block.body.description)) continue;

      diagnostics.push({
        checkId: "TF012",
        severity: "info",
        message:
          `Output "${blockName(block.address)}" declares no \`description\`. Outputs are a module's ` +
          "public interface, so say what the value is and what a caller can rely on it for.",
        entity: block.key,
        lexicon: "terraform",
      });
    }

    return diagnostics;
  },
};
