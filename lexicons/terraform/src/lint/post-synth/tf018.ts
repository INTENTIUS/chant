/**
 * TF018: an `output` returns a whole resource or data source.
 *
 * `value = aws_instance.web` exports every attribute the provider schema
 * happens to have, which is a much larger promise than the module meant to
 * make. Consumers reach into whatever they find, the module can no longer
 * change any of it, and a provider upgrade that adds or renames an attribute
 * moves the module's public interface without anyone editing it. Sensitive
 * attributes ride along too.
 *
 * A bare `module.x` reference is not reported: a module's outputs are already
 * a curated surface, which is the property this rule is asking for.
 */

import type {
  PostSynthCheck,
  PostSynthContext,
  PostSynthDiagnostic,
} from "@intentius/chant/lint/post-synth";
import { OUTPUT_TYPE } from "../../hcl/parse";
import { blockName, blocksOfType } from "./blocks";

/** Reference prefixes that are not a managed resource type. */
const NOT_A_RESOURCE = new Set(["var", "local", "module", "each", "count", "self", "path", "terraform"]);

/**
 * Is this value a reference to a whole resource (`type.name`) or a whole data
 * source (`data.type.name`), with no attribute selected? Anything with a third
 * segment, an index, or a function call around it has already narrowed the
 * value down, which is the fix.
 */
function wholeBlockReference(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const m = /^\$\{([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)+)\}$/.exec(value);
  if (!m) return undefined;
  const parts = m[1].split(".");
  if (parts[0] === "data") return parts.length === 3 ? m[1] : undefined;
  if (NOT_A_RESOURCE.has(parts[0])) return undefined;
  return parts.length === 2 ? m[1] : undefined;
}

export const tf018: PostSynthCheck = {
  id: "TF018",
  description: "Output value is a whole resource or data source",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const block of blocksOfType(ctx, OUTPUT_TYPE)) {
      const reference = wholeBlockReference(block.body.value);
      if (!reference) continue;

      diagnostics.push({
        checkId: "TF018",
        severity: "info",
        message:
          `Output "${blockName(block.address)}" returns the whole of \`${reference}\`, so every ` +
          "attribute the provider schema has becomes part of this module's public interface, " +
          "including the ones a provider upgrade adds later. Return the attribute the caller needs " +
          `(\`${reference}.id\`, \`${reference}.arn\`) instead.`,
        entity: block.key,
        lexicon: "terraform",
      });
    }

    return diagnostics;
  },
};
