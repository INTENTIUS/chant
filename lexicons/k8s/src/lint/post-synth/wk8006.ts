/**
 * WK8006: No :latest or Untagged Images
 *
 * Container images should use explicit version tags for reproducibility.
 * Flags images using the `:latest` tag or no tag at all.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, parseK8sManifests, extractContainers, WORKLOAD_KINDS } from "./k8s-helpers";

export const wk8006: PostSynthCheck = {
  id: "WK8006",
  description: "No :latest or untagged images — container images should use explicit version tags",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      const manifests = parseK8sManifests(yaml);

      for (const manifest of manifests) {
        if (!manifest.kind || !WORKLOAD_KINDS.has(manifest.kind)) continue;

        const containers = extractContainers(manifest);
        const resourceName = manifest.metadata?.name ?? manifest.kind;

        for (const container of containers) {
          const image = container.image;
          if (typeof image !== "string" || image === "") continue;

          // Split off digest (@sha256:...) — those are pinned and fine
          if (image.includes("@")) continue;

          // Extract the tag portion (after the last colon that isn't part of a port)
          // Images can be: name, name:tag, registry:port/name, registry:port/name:tag
          const slashIndex = image.lastIndexOf("/");
          const afterSlash = slashIndex >= 0 ? image.slice(slashIndex + 1) : image;
          const colonIndex = afterSlash.lastIndexOf(":");

          if (colonIndex === -1) {
            // No tag at all
            diagnostics.push({
              checkId: "WK8006",
              severity: "warning",
              message: `Container "${container.name ?? "(unnamed)"}" in ${manifest.kind} "${resourceName}" uses untagged image "${image}" — specify an explicit version tag`,
              entity: resourceName,
              lexicon: "k8s",
            });
          } else {
            const tag = afterSlash.slice(colonIndex + 1);
            if (tag === "latest") {
              diagnostics.push({
                checkId: "WK8006",
                severity: "warning",
                message: `Container "${container.name ?? "(unnamed)"}" in ${manifest.kind} "${resourceName}" uses :latest tag on image "${image}" — use a specific version tag`,
                entity: resourceName,
                lexicon: "k8s",
              });
            }
          }
        }
      }
    }

    return diagnostics;
  },
};
