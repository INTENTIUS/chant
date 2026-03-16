/**
 * WK8042: Private Keys in ConfigMap
 *
 * Detects PEM-encoded private keys stored in ConfigMap data values.
 * Private keys should be stored in Secrets, not ConfigMaps, since
 * ConfigMaps are not encrypted at rest by default.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, parseK8sManifests } from "./k8s-helpers";

const PRIVATE_KEY_PATTERN = /-----BEGIN\s+[\w\s]*PRIVATE KEY-----/;

export const wk8042: PostSynthCheck = {
  id: "WK8042",
  description: "Private keys in ConfigMap — private keys should be stored in Secrets, not ConfigMaps",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      const manifests = parseK8sManifests(yaml);

      for (const manifest of manifests) {
        if (manifest.kind !== "ConfigMap") continue;

        const resourceName = manifest.metadata?.name ?? "ConfigMap";
        const data = manifest.data;
        if (typeof data !== "object" || data === null) continue;

        for (const [key, value] of Object.entries(data)) {
          if (typeof value === "string" && PRIVATE_KEY_PATTERN.test(value)) {
            diagnostics.push({
              checkId: "WK8042",
              severity: "error",
              message: `ConfigMap "${resourceName}" contains a private key in data field "${key}" — use a Secret resource instead`,
              entity: resourceName,
              lexicon: "k8s",
            });
          }
        }
      }
    }

    return diagnostics;
  },
};
