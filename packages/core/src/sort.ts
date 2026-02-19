import { BuildError } from "./errors";
import { detectCycles } from "./discovery/cycles";

/**
 * Performs a topological sort on a dependency graph
 * @param dependencies - Record where keys are entity names and values are arrays of their dependencies
 * @returns Array of entity names in topological order (dependencies appear before dependents)
 * @throws {BuildError} If a cycle is detected in the dependency graph
 */
export function topologicalSort(
  dependencies: Record<string, string[]>
): string[] {
  // Check for cycles first
  const cycles = detectCycles(dependencies);
  if (cycles.length > 0) {
    const cycleStr = cycles[0].join(" -> ");
    throw new BuildError(
      cycles[0][0],
      `Circular dependency detected: ${cycleStr}`
    );
  }

  const sorted: string[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  /**
   * DFS helper for topological sort
   * @param node - Current node being visited
   */
  function visit(node: string): void {
    if (visited.has(node)) {
      return;
    }

    visiting.add(node);

    const deps = dependencies[node] || [];
    for (const dep of deps) {
      if (!visited.has(dep)) {
        visit(dep);
      }
    }

    visiting.delete(node);
    visited.add(node);
    sorted.push(node);
  }

  // Visit all nodes
  for (const node of Object.keys(dependencies)) {
    if (!visited.has(node)) {
      visit(node);
    }
  }

  return sorted;
}
