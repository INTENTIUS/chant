/**
 * WHM406: Chart uses `crds/` directory — warn that Helm never upgrades/deletes CRDs.
 *
 * Suggests using `HelmCRDLifecycle` composite for managed CRD lifecycle.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getChartFiles } from "./helm-helpers";

export const whm406: PostSynthCheck = {
  id: "WHM406",
  description: "CRDs in crds/ directory are never upgraded or deleted by Helm",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const files = getChartFiles(output);

      const hasCrdDir = Object.keys(files).some((f) => f.startsWith("crds/"));
      if (hasCrdDir) {
        diagnostics.push({
          checkId: "WHM406",
          severity: "info",
          message: "Chart uses crds/ directory — Helm installs CRDs but never upgrades or deletes them. Consider using HelmCRDLifecycle composite for managed CRD lifecycle.",
          entity: "crds/",
          lexicon: "helm",
        });
      }
    }

    return diagnostics;
  },
};
