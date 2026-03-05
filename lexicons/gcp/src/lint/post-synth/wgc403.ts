/**
 * WGC403: Type/structure mismatch in spec field
 *
 * Flags spec fields where the value type doesn't match the CRD schema:
 * - String where number expected (e.g. availableMemoryMb: "512")
 * - Scalar string where resourceRef object expected (e.g. topicRef: "name")
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseGcpManifests, isConfigConnectorResource, getResourceName, getSpec } from "./gcp-helpers";
import { getSchemaRegistry } from "./schema-registry";

export const wgc403: PostSynthCheck = {
  id: "WGC403",
  description: "Config Connector resource spec field has wrong type or structure",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];
    const registry = getSchemaRegistry();

    for (const [_lexicon, output] of ctx.outputs) {
      if (typeof output !== "string") continue;

      const manifests = parseGcpManifests(output);

      for (const manifest of manifests) {
        if (!isConfigConnectorResource(manifest)) continue;

        const kind = manifest.kind;
        if (!kind) continue;

        const schema = registry.get(kind);
        if (!schema) continue;

        const spec = getSpec(manifest);
        if (!spec) continue;

        const resourceName = getResourceName(manifest);

        for (const [field, value] of Object.entries(spec)) {
          const fieldSchema = schema.fields[field];
          if (!fieldSchema) continue; // Unknown fields handled by WGC401

          // Check: resourceRef field expects an object, got a scalar
          if (fieldSchema.ref && typeof value === "string") {
            diagnostics.push({
              checkId: "WGC403",
              severity: "error",
              message: `Resource "${resourceName}" (${kind}): field "${field}" expects a resourceRef object (e.g. { name, kind }), got string "${value}"`,
              entity: resourceName,
              lexicon: "gcp",
            });
            continue;
          }

          // Check: number field got a string that looks numeric
          if (fieldSchema.type === "number" && typeof value === "string") {
            diagnostics.push({
              checkId: "WGC403",
              severity: "error",
              message: `Resource "${resourceName}" (${kind}): field "${field}" expects a number, got string "${value}"`,
              entity: resourceName,
              lexicon: "gcp",
            });
            continue;
          }

          // Check: boolean field got a string
          if (fieldSchema.type === "boolean" && typeof value === "string") {
            diagnostics.push({
              checkId: "WGC403",
              severity: "error",
              message: `Resource "${resourceName}" (${kind}): field "${field}" expects a boolean, got string "${value}"`,
              entity: resourceName,
              lexicon: "gcp",
            });
          }
        }
      }
    }

    return diagnostics;
  },
};
