/**
 * GHA019: Circular Needs Chain
 *
 * DFS-based cycle detection on the job `needs:` dependency graph.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, buildNeedsGraph } from "./yaml-helpers";

export function checkCircularNeeds(ctx: PostSynthContext): PostSynthDiagnostic[] {
  const diagnostics: PostSynthDiagnostic[] = [];

  for (const [, output] of ctx.outputs) {
    const yaml = getPrimaryOutput(output);
    const graph = buildNeedsGraph(yaml);

    const visited = new Set<string>();
    const inStack = new Set<string>();
    const reportedInCycle = new Set<string>();

    function dfs(node: string, path: string[]): void {
      if (inStack.has(node)) {
        const cycleStart = path.indexOf(node);
        const cycle = path.slice(cycleStart);
        cycle.push(node);

        const cycleKey = [...cycle].sort().join(",");
        if (!reportedInCycle.has(cycleKey)) {
          reportedInCycle.add(cycleKey);
          diagnostics.push({
            checkId: "GHA019",
            severity: "error",
            message: `Circular needs: chain detected: ${cycle.join(" → ")}`,
            entity: node,
            lexicon: "github",
          });
        }
        return;
      }

      if (visited.has(node)) return;

      visited.add(node);
      inStack.add(node);

      for (const neighbor of graph.get(node) ?? []) {
        if (graph.has(neighbor)) {
          dfs(neighbor, [...path, node]);
        }
      }

      inStack.delete(node);
    }

    for (const jobName of graph.keys()) {
      if (!visited.has(jobName)) {
        dfs(jobName, []);
      }
    }
  }

  return diagnostics;
}

export const gha019: PostSynthCheck = {
  id: "GHA019",
  description: "Circular needs: chain — cycle in job dependency graph",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return checkCircularNeeds(ctx);
  },
};
