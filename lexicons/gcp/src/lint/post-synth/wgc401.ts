/**
 * WGC401: Unknown spec field
 *
 * Flags fields in a Config Connector resource spec that are not defined
 * in the CRD schema. Includes "did you mean?" suggestion via Levenshtein.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseGcpManifests, isConfigConnectorResource, getResourceName, getSpec } from "./gcp-helpers";
import { getSchemaRegistry, suggestField } from "./schema-registry";

export const wgc401: PostSynthCheck = {
  id: "WGC401",
  description: "Config Connector resource spec contains unknown field",

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
        if (!schema) continue; // No schema available for this kind

        const spec = getSpec(manifest);
        if (!spec) continue;

        const knownFields = Object.keys(schema.fields);
        const resourceName = getResourceName(manifest);

        for (const field of Object.keys(spec)) {
          if (field in schema.fields) continue;

          const suggestion = suggestField(field, knownFields);
          const hint = suggestion ? ` — did you mean "${suggestion}"?` : "";

          diagnostics.push({
            checkId: "WGC401",
            severity: "error",
            message: `Resource "${resourceName}" (${kind}): unknown spec field "${field}"${hint}`,
            entity: resourceName,
            lexicon: "gcp",
          });
        }
      }
    }

    return diagnostics;
  },
};
