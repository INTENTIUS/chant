/**
 * WK8102: Resources Should Have Metadata Labels
 *
 * All Kubernetes resources should have metadata.labels for organizational
 * purposes. Labels enable filtering, selection, and operational tooling.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { describeNonStringName, docsToManifests, nameOf } from "./k8s-helpers";

export const wk8102: PostSynthCheck = {
  id: "WK8102",
  description: "Resources should have metadata labels — labels enable filtering and operational tooling",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const manifest of docsToManifests(ctx)) {
      if (!manifest.kind || !manifest.metadata) continue;

      const resourceName = nameOf(manifest, manifest.kind);
      const labels = manifest.metadata.labels;

      if (!labels || typeof labels !== "object" || Object.keys(labels).length === 0) {
        const notString = describeNonStringName(manifest);
        const message = notString
          ? `${manifest.kind} has no metadata.labels, and its metadata.name is ${notString}, not a string. This is most likely a template that is filled in before it is applied; audit the rendered manifest instead`
          : `${manifest.kind} "${resourceName}" has no metadata.labels — add labels for organizational purposes`;
        diagnostics.push({
          checkId: "WK8102",
          severity: "warning",
          message,
          entity: resourceName,
          lexicon: "k8s",
        });
      }
    }

    return diagnostics;
  },
};
