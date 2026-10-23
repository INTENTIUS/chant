import type { ExportedTemplate, ResourceSelector } from "@intentius/chant/lexicon";
import { hasOwnershipMarker } from "@intentius/chant/ownership";
import { AWS_TAG_OWNERSHIP_KEYS, OWNERSHIP_METADATA_KEY } from "../ownership";
import { readResourceTags, readTagValue } from "../taggable";
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
        // The marker sits in the type's own tag property, in either shape, or
        // in the resource's Metadata for a type whose tags can't be stamped (#4350).
        const tags = readResourceTags(r.type, r.properties as Record<string, unknown>);
        const marker = readTagValue(r.metadata?.[OWNERSHIP_METADATA_KEY]);
        if (!hasOwnershipMarker(tags, AWS_TAG_OWNERSHIP_KEYS) && !hasOwnershipMarker(marker, AWS_TAG_OWNERSHIP_KEYS)) return false;
      }
      return true;
    }),
  };
}
