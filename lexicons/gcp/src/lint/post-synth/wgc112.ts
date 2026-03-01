/**
 * WGC112: Missing or invalid apiVersion
 *
 * Every Config Connector resource must have an apiVersion matching
 * `<service>.cnrm.cloud.google.com/v<version>`.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseGcpManifests, getResourceName } from "./gcp-helpers";

const VALID_API_VERSION = /^[a-z]+\.cnrm\.cloud\.google\.com\/v\d+(?:alpha\d+|beta\d+)?$/;

export const wgc112: PostSynthCheck = {
  id: "WGC112",
  description: "Config Connector resource has missing or invalid apiVersion",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [_lexicon, output] of ctx.outputs) {
      if (typeof output !== "string") continue;

      const manifests = parseGcpManifests(output);

      for (const manifest of manifests) {
        // Only check resources that look like Config Connector (have a kind)
        if (!manifest.kind) continue;

        const resourceName = getResourceName(manifest);

        if (!manifest.apiVersion) {
          diagnostics.push({
            checkId: "WGC112",
            severity: "error",
            message: `Resource "${resourceName}" (kind: ${manifest.kind}) is missing apiVersion`,
            entity: resourceName,
            lexicon: "gcp",
          });
          continue;
        }

        if (!VALID_API_VERSION.test(manifest.apiVersion)) {
          diagnostics.push({
            checkId: "WGC112",
            severity: "error",
            message: `Resource "${resourceName}" has invalid apiVersion "${manifest.apiVersion}" — expected format: <service>.cnrm.cloud.google.com/v<version>`,
            entity: resourceName,
            lexicon: "gcp",
          });
        }
      }
    }

    return diagnostics;
  },
};
