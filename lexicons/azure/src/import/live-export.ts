import type { ExportedTemplate, ResourceSelector } from "@intentius/chant/lexicon";
import { hasOwnershipMarker } from "@intentius/chant/ownership";
import { ArmParser } from "./parser";

/**
 * Map a live ARM template (from `az group export`) to full-fidelity export IR.
 *
 * `az group export --output json` returns an ARM template — either as a JSON
 * object or, via the CLI, a JSON string. `ArmParser` already turns the template
 * into `TemplateIR` — the same IR the static-import path uses — so the result
 * feeds `ArmGenerator` (templateGenerator) unchanged. Pure: all I/O stays in
 * the caller (`../export-resources`).
 *
 * Mirrors AWS `parseStackTemplate`. The one shape difference: ARM tags are a
 * `Record<string,string>` map (not the `{Key,Value}[]` array CloudFormation
 * uses), so the ownership filter reads `properties.tags` directly without
 * `tagArrayToMap`, against the `azure-tag` channel (`chant-managed-by`).
 */
export function parseExportedTemplate(
  templateBody: unknown,
  selector?: ResourceSelector,
  owned?: boolean,
): ExportedTemplate {
  const content =
    typeof templateBody === "string" ? templateBody : JSON.stringify(templateBody);
  const ir = new ArmParser().parse(content);

  const hasSelector = selector && (selector.type !== undefined || selector.name !== undefined);
  if (!hasSelector && !owned) return ir;

  return {
    ...ir,
    resources: ir.resources.filter((r) => {
      if (selector?.type !== undefined && r.type !== selector.type) return false;
      if (selector?.name !== undefined && r.logicalId !== selector.name) return false;
      if (owned) {
        const tags = (r.properties as { tags?: Record<string, unknown> }).tags;
        if (!hasOwnershipMarker(tags, "azure-tag")) return false;
      }
      return true;
    }),
  };
}
