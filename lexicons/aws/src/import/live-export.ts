import type { ExportedTemplate, ResourceSelector } from "@intentius/chant/lexicon";
import { hasOwnershipMarker, tagArrayToMap } from "@intentius/chant/ownership";
import { CFParser } from "./parser";

/**
 * Map a live CloudFormation template body to full-fidelity export IR.
 *
 * `aws cloudformation get-template` returns the template body as a JSON object
 * (for JSON templates) or a string (for YAML). `CFParser` already turns either
 * into `TemplateIR` — the same IR the import path uses — so the result feeds
 * `templateGenerator()` (CFGenerator) unchanged. Pure: all I/O stays in the
 * caller.
 */
export function parseStackTemplate(
  templateBody: unknown,
  selector?: ResourceSelector,
  owned?: boolean,
): ExportedTemplate {
  const content =
    typeof templateBody === "string" ? templateBody : JSON.stringify(templateBody);
  const ir = new CFParser().parse(content);

  const hasSelector = selector && (selector.type !== undefined || selector.name !== undefined);
  if (!hasSelector && !owned) return ir;

  return {
    ...ir,
    resources: ir.resources.filter((r) => {
      if (selector?.type !== undefined && r.type !== selector.type) return false;
      if (selector?.name !== undefined && r.logicalId !== selector.name) return false;
      if (owned) {
        const tags = (r.properties as { Tags?: Array<{ Key?: string; Value?: unknown }> }).Tags;
        if (!hasOwnershipMarker(tagArrayToMap(tags), "aws-tag")) return false;
      }
      return true;
    }),
  };
}
