/**
 * WAW015: Circular project references
 *
 * Detects when child projects form circular references through
 * nestedStack() declarations. A → B → A would cause infinite recursion
 * at build time.
 *
 * Note: The core build pipeline also detects this and emits a BuildError,
 * but this lint check provides a clearer diagnostic message.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { isChildProject } from "@intentius/chant/child-project";

export const waw015: PostSynthCheck = {
  id: "WAW015",
  description: "Circular dependency between nested stacks would cause infinite build recursion",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    // Build a dependency graph: stackName → set of child project paths
    const stacks = new Map<string, string>();
    for (const [name, entity] of ctx.entities) {
      if (isChildProject(entity)) {
        stacks.set(name, entity.projectPath);
      }
    }

    if (stacks.size < 2) return diagnostics;

    // Check for cycles by looking at child build results for nested ChildProjectInstances
    const deps = new Map<string, Set<string>>();
    for (const [name] of stacks) {
      deps.set(name, new Set());
    }

    for (const [name, entity] of ctx.entities) {
      if (isChildProject(entity) && entity.buildResult) {
        for (const [, childEntity] of entity.buildResult.entities) {
          if (isChildProject(childEntity)) {
            // Check if the child references any of our known stacks
            for (const [stackName, stackPath] of stacks) {
              if (childEntity.projectPath === stackPath) {
                deps.get(name)!.add(stackName);
              }
            }
          }
        }
      }
    }

    // Detect cycles using DFS
    const visited = new Set<string>();
    const inPath = new Set<string>();

    function dfs(node: string, path: string[]): string[] | null {
      if (inPath.has(node)) {
        const cycleStart = path.indexOf(node);
        return path.slice(cycleStart);
      }
      if (visited.has(node)) return null;

      visited.add(node);
      inPath.add(node);
      path.push(node);

      for (const dep of deps.get(node) ?? []) {
        const cycle = dfs(dep, path);
        if (cycle) return cycle;
      }

      path.pop();
      inPath.delete(node);
      return null;
    }

    const reportedCycles = new Set<string>();
    for (const [name] of stacks) {
      if (!visited.has(name)) {
        const cycle = dfs(name, []);
        if (cycle) {
          const cycleKey = [...cycle].sort().join(",");
          if (!reportedCycles.has(cycleKey)) {
            reportedCycles.add(cycleKey);
            diagnostics.push({
              checkId: "WAW015",
              severity: "error",
              message: `Circular dependency between nested stacks: ${cycle.join(" → ")} → ${cycle[0]}`,
              entity: cycle[0],
              lexicon: "aws",
            });
          }
        }
      }
    }

    return diagnostics;
  },
};
