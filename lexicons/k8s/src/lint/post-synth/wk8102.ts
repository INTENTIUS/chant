/**
 * WK8102: Resources Should Have Metadata Labels
 *
 * All Kubernetes resources should have metadata.labels for organizational
 * purposes. Labels enable filtering, selection, and operational tooling.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, parseK8sManifests } from "./k8s-helpers";

export const wk8102: PostSynthCheck = {
  id: "WK8102",
  description: "Resources should have metadata labels — labels enable filtering and operational tooling",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      const manifests = parseK8sManifests(yaml);

      for (const manifest of manifests) {
        if (!manifest.kind || !manifest.metadata) continue;

        const resourceName = manifest.metadata.name ?? manifest.kind;
        const labels = manifest.metadata.labels;

        if (!labels || typeof labels !== "object" || Object.keys(labels).length === 0) {
          diagnostics.push({
            checkId: "WK8102",
            severity: "warning",
            message: `${manifest.kind} "${resourceName}" has no metadata.labels — add labels for organizational purposes`,
            entity: resourceName,
            lexicon: "k8s",
          });
        }
      }
    }

    return diagnostics;
  },
};
