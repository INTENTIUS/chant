import type { ExportedTemplate, ResourceSelector } from "@intentius/chant/lexicon";
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
): ExportedTemplate {
  const content =
    typeof templateBody === "string" ? templateBody : JSON.stringify(templateBody);
  const ir = new CFParser().parse(content);

  if (!selector || (selector.type === undefined && selector.name === undefined)) {
    return ir;
  }
  return {
    ...ir,
    resources: ir.resources.filter(
      (r) =>
        (selector.type === undefined || r.type === selector.type) &&
        (selector.name === undefined || r.logicalId === selector.name),
    ),
  };
}
