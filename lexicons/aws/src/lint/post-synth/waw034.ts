/**
 * WAW034: Solr Container Undersized
 *
 * Fargate tasks running a Solr image with less than 2048MB of memory will
 * fail under any real load — the JVM alone needs headroom for the heap plus
 * OS file cache for Lucene MMap. 4096MB is the practical production minimum.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseCFTemplate } from "./cf-refs";

function isSolrImage(image: unknown): boolean {
  return typeof image === "string" && image.toLowerCase().includes("solr");
}

export function checkSolrMemoryMinimum(ctx: PostSynthContext): PostSynthDiagnostic[] {
  const diagnostics: PostSynthDiagnostic[] = [];

  for (const [_lexicon, output] of ctx.outputs) {
    const template = parseCFTemplate(output);
    if (!template?.Resources) continue;

    for (const [logicalId, resource] of Object.entries(template.Resources)) {
      if (resource.Type !== "AWS::ECS::TaskDefinition") continue;

      const props = resource.Properties ?? {};
      if (typeof props.Memory !== "string") continue;
      const taskMemoryMb = parseInt(props.Memory);
      if (!taskMemoryMb) continue;

      const containers: unknown[] = Array.isArray(props.ContainerDefinitions)
        ? props.ContainerDefinitions
        : [];

      const hasSolr = containers.some(
        (c) => typeof c === "object" && c !== null && isSolrImage((c as Record<string, unknown>).Image),
      );

      if (!hasSolr) continue;

      if (taskMemoryMb < 2048) {
        diagnostics.push({
          checkId: "WAW034",
          severity: "warning",
          message: `Solr task "${logicalId}" has only ${taskMemoryMb}MB memory — Solr requires at least 2048MB; 4096MB recommended for production`,
          entity: logicalId,
          lexicon: "aws",
        });
      }
    }
  }

  return diagnostics;
}

export const waw034: PostSynthCheck = {
  id: "WAW034",
  description: "Fargate task running Solr has insufficient memory (< 2048MB)",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return checkSolrMemoryMinimum(ctx);
  },
};
