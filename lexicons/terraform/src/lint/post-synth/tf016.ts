/**
 * TF016: an attribute whose whole value is one quoted interpolation,
 * `x = "${var.y}"`, the pre-0.12 style Terraform deprecated in 2019.
 *
 * The quotes buy nothing and cost readability: the expression is already an
 * expression, and wrapping it in a template makes every value in the file look
 * like a string whether it is one or not, which hides the actual type of an
 * argument that takes a list or a bool.
 *
 * This is the one rule in the family that reads the block's SOURCE rather than
 * its parsed body, and it has to. `@cdktf/hcl2json` renders both `x = var.y`
 * and `x = "${var.y}"` as the string `"${var.y}"`, so a check over the parse
 * cannot tell the deprecated form from the idiomatic one and would report every
 * reference in the root. The quotes only survive in the text, so the text is
 * what is scanned, one pass per file, through the same
 * `interpolationOnlyLine` the deterministic fix uses, so the finding and the
 * patch can never disagree.
 *
 * Out of reach, and deliberately not guessed at: tflint also reports the
 * deprecated interpolation inside an object KEY (`"${var.k}" = "value"`).
 * That is a different line shape and its fix is not a simple unquote, so this
 * rule leaves it alone rather than emit a diff it cannot justify.
 */

import type {
  PostSynthCheck,
  PostSynthContext,
  PostSynthDiagnostic,
} from "@intentius/chant/lint/post-synth";
import { isResourceDeclarable } from "@intentius/chant/declarable";
import { interpolationOnlyLine } from "@intentius/chant/audit/proof";
import type { TerraformEntity } from "../../hcl/parse";

export const tf016: PostSynthCheck = {
  id: "TF016",
  description: "Attribute value is a quoted interpolation of a single expression",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];
    /** `<root>/<file>` to that file's source, so a file is scanned once however many blocks it holds. */
    const sources = new Map<string, string>();

    for (const entity of ctx.entities.values()) {
      if (entity.lexicon !== "terraform") continue;
      if (!isResourceDeclarable(entity)) continue;
      const props = (entity as TerraformEntity).props as Partial<TerraformEntity["props"]>;
      if (typeof props.source !== "string" || props.source === "") continue;
      sources.set(`${props.root ?? ""}/${props.file ?? ""}`, props.source);
    }

    for (const [key, source] of sources) {
      const lines = source.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const parsed = interpolationOnlyLine(lines[i]);
        if (!parsed) continue;
        diagnostics.push({
          checkId: "TF016",
          severity: "info",
          message:
            `${key}:${i + 1}: \`${parsed.name}\` wraps a single expression in a template ` +
            `("\${${parsed.expr}}"). Terraform deprecated that spelling in 0.12. Write ` +
            `\`${parsed.name} = ${parsed.expr}\` instead, so the argument keeps its own type.`,
          entity: `${key}:${i + 1}`,
          lexicon: "terraform",
        });
      }
    }

    return diagnostics;
  },
};
