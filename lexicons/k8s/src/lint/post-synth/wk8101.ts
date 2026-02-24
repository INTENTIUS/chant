/**
 * WK8101: Deployment Selector Must Match Template Labels
 *
 * A Deployment's spec.selector.matchLabels must be a subset of
 * spec.template.metadata.labels. If they don't match, the Deployment
 * controller cannot find the Pods it creates, causing a runtime failure.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, parseK8sManifests } from "./k8s-helpers";

export const wk8101: PostSynthCheck = {
  id: "WK8101",
  description: "Deployment selector must match template labels — mismatched selectors cause runtime failures",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      const manifests = parseK8sManifests(yaml);

      for (const manifest of manifests) {
        if (manifest.kind !== "Deployment") continue;

        const resourceName = manifest.metadata?.name ?? "Deployment";
        const spec = manifest.spec;
        if (!spec) continue;

        const selector = spec.selector as Record<string, unknown> | undefined;
        const matchLabels = selector?.matchLabels as Record<string, string> | undefined;
        if (!matchLabels || typeof matchLabels !== "object") continue;

        const template = spec.template as Record<string, unknown> | undefined;
        const templateMetadata = template?.metadata as Record<string, unknown> | undefined;
        const templateLabels = templateMetadata?.labels as Record<string, string> | undefined;

        if (!templateLabels || typeof templateLabels !== "object") {
          diagnostics.push({
            checkId: "WK8101",
            severity: "error",
            message: `Deployment "${resourceName}" has spec.selector.matchLabels but no spec.template.metadata.labels`,
            entity: resourceName,
            lexicon: "k8s",
          });
          continue;
        }

        for (const [key, value] of Object.entries(matchLabels)) {
          if (templateLabels[key] !== value) {
            diagnostics.push({
              checkId: "WK8101",
              severity: "error",
              message: `Deployment "${resourceName}" selector label "${key}=${value}" does not match template label "${key}=${templateLabels[key] ?? '(missing)'}"`,
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
