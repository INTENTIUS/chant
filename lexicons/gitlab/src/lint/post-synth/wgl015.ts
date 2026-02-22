/**
 * WGL015: Circular `needs:` Chain
 *
 * DFS-based cycle detection on the `needs:` dependency graph.
 * If A needs B and B needs A, GitLab rejects the pipeline.
 *
 * Reports one diagnostic per cycle found, listing the full chain.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, extractJobs } from "./yaml-helpers";

export function checkCircularNeeds(ctx: PostSynthContext): PostSynthDiagnostic[] {
  const diagnostics: PostSynthDiagnostic[] = [];

  for (const [, output] of ctx.outputs) {
    const yaml = getPrimaryOutput(output);
    const jobs = extractJobs(yaml);

    // Build adjacency list from needs
    const graph = new Map<string, string[]>();
    for (const [jobName, job] of jobs) {
      graph.set(jobName, job.needs ?? []);
    }

    // DFS cycle detection
    const visited = new Set<string>();
    const inStack = new Set<string>();
    const reportedInCycle = new Set<string>();

    function dfs(node: string, path: string[]): void {
      if (inStack.has(node)) {
        // Found a cycle — extract the cycle portion
        const cycleStart = path.indexOf(node);
        const cycle = path.slice(cycleStart);
        cycle.push(node);

        // Only report if we haven't already reported a cycle containing these nodes
        const cycleKey = [...cycle].sort().join(",");
        if (!reportedInCycle.has(cycleKey)) {
          reportedInCycle.add(cycleKey);
          diagnostics.push({
            checkId: "WGL015",
            severity: "error",
            message: `Circular needs: chain detected: ${cycle.join(" → ")}`,
            entity: node,
            lexicon: "gitlab",
          });
        }
        return;
      }

      if (visited.has(node)) return;

      visited.add(node);
      inStack.add(node);

      for (const neighbor of graph.get(node) ?? []) {
        // Only follow edges to known jobs
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

export const wgl015: PostSynthCheck = {
  id: "WGL015",
  description: "Circular needs: chain — cycle in job dependency graph",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return checkCircularNeeds(ctx);
  },
};
