/**
 * WGC402: Missing required spec field
 *
 * Flags Config Connector resources that are missing required fields
 * according to their CRD schema.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseGcpManifests, isConfigConnectorResource, getResourceName, getSpec } from "./gcp-helpers";
import { getSchemaRegistry } from "./schema-registry";

export const wgc402: PostSynthCheck = {
  id: "WGC402",
  description: "Config Connector resource is missing a required spec field",

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
        const specKeys = new Set(spec ? Object.keys(spec) : []);
        const resourceName = getResourceName(manifest);

        for (const requiredField of schema.required) {
          if (!specKeys.has(requiredField)) {
            diagnostics.push({
              checkId: "WGC402",
              severity: "error",
              message: `Resource "${resourceName}" (${kind}): missing required field "${requiredField}"`,
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
