/**
 * WAW033: Solr Heap Exceeds 50% of Container Memory
 *
 * When SOLR_HEAP is set on a Fargate task running a Solr image, validates that
 * the heap does not exceed 50% of the task's allocated memory. Exceeding this
 * leaves insufficient headroom for the OS file cache that Lucene MMap relies on,
 * causing the OOM killer to terminate the container.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseCFTemplate } from "./cf-refs";

/** Parse heap strings like "4g", "2048m", "2048" → megabytes */
function parseHeapMb(value: string): number | null {
  const lower = value.trim().toLowerCase();
  const gMatch = lower.match(/^(\d+(?:\.\d+)?)g$/);
  if (gMatch) return Math.round(parseFloat(gMatch[1]) * 1024);
  const mMatch = lower.match(/^(\d+(?:\.\d+)?)m?$/);
  if (mMatch) return Math.round(parseFloat(mMatch[1]));
  return null;
}

function isSolrImage(image: unknown): boolean {
  return typeof image === "string" && image.toLowerCase().includes("solr");
}

export function checkSolrHeapRatio(ctx: PostSynthContext): PostSynthDiagnostic[] {
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

      for (const container of containers) {
        if (typeof container !== "object" || container === null) continue;
        const c = container as Record<string, unknown>;

        if (!isSolrImage(c.Image)) continue;

        const envVars: unknown[] = Array.isArray(c.Environment) ? c.Environment : [];
        const heapEntry = envVars.find(
          (e): e is Record<string, unknown> =>
            typeof e === "object" && e !== null && (e as Record<string, unknown>).Name === "SOLR_HEAP",
        );

        if (!heapEntry) continue; // WAW034 covers missing heap

        const heapMb = parseHeapMb(String(heapEntry.Value ?? ""));
        if (heapMb === null) continue;

        if (heapMb > taskMemoryMb * 0.5) {
          diagnostics.push({
            checkId: "WAW033",
            severity: "error",
            message: `Solr container "${c.Name ?? "app"}" SOLR_HEAP (${heapMb}MB) exceeds 50% of task memory (${taskMemoryMb}MB) — risk of OOM kill; set SOLR_HEAP <= ${Math.floor(taskMemoryMb * 0.45)}m`,
            entity: logicalId,
            lexicon: "aws",
          });
        }
      }
    }
  }

  return diagnostics;
}

export const waw033: PostSynthCheck = {
  id: "WAW033",
  description: "Solr SOLR_HEAP exceeds 50% of Fargate task memory",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return checkSolrHeapRatio(ctx);
  },
};
