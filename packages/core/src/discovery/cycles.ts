/**
 * Cycle detection using DFS with three-color marking (white/gray/black).
 *
 * Accepts either `Map<string, Set<string>>` or `Record<string, string[]>` as input.
 * Returns deduplicated cycles, each represented as an array of node IDs.
 */

type GraphInput = Map<string, Set<string>> | Record<string, string[]>;

/**
 * Normalize graph input to Map<string, Set<string>>.
 */
function normalizeGraph(graph: GraphInput): Map<string, Set<string>> {
  if (graph instanceof Map) return graph;
  const result = new Map<string, Set<string>>();
  for (const [node, neighbors] of Object.entries(graph)) {
    result.set(node, new Set(neighbors));
  }
  return result;
}

/**
 * Detects cycles in a directed graph using DFS with three-color marking.
 *
 * @param graph - Adjacency list: node → neighbors. Accepts Map<string, Set<string>>
 *   or Record<string, string[]>.
 * @returns Array of deduplicated cycles. Each cycle is a node ID array
 *   (e.g. ["A", "B", "C"]). Self-loops return ["A"].
 */
export function detectCycles(graph: GraphInput): string[][] {
  const g = normalizeGraph(graph);

  const WHITE = 0; // Not visited
  const GRAY = 1;  // In current DFS path
  const BLACK = 2; // Fully explored

  const color = new Map<string, number>();
  const parent = new Map<string, string>();
  const cycles: string[][] = [];
  const reportedCycles = new Set<string>();

  for (const node of g.keys()) {
    color.set(node, WHITE);
  }

  function dfs(node: string): void {
    color.set(node, GRAY);

    const neighbors = g.get(node) ?? new Set();
    for (const neighbor of neighbors) {
      const c = color.get(neighbor);
      if (c === undefined || c === WHITE) {
        if (c === undefined) {
          // Node referenced but not defined as a key — treat as fully explored
          continue;
        }
        parent.set(neighbor, node);
        dfs(neighbor);
      } else if (c === GRAY) {
        // Found a cycle — reconstruct it
        const cycle: string[] = [neighbor];
        let current = node;
        while (current !== neighbor) {
          cycle.push(current);
          current = parent.get(current)!;
        }
        cycle.push(neighbor);
        cycle.reverse();

        // Normalize to avoid duplicate cycle reports
        const key = normalizeCycleKey(cycle);
        if (!reportedCycles.has(key)) {
          reportedCycles.add(key);
          // Strip the trailing repeated node for a clean cycle representation
          cycles.push(cycle.slice(0, -1));
        }
      }
    }

    color.set(node, BLACK);
  }

  for (const node of g.keys()) {
    if (color.get(node) === WHITE) {
      dfs(node);
    }
  }

  return cycles;
}

/**
 * Normalize a cycle for deduplication.
 * Rotate to start with the lexicographically smallest node.
 */
export function normalizeCycleKey(cycle: string[]): string {
  // Remove the repeated last element for rotation
  const nodes = cycle.slice(0, -1);
  let minIdx = 0;
  for (let i = 1; i < nodes.length; i++) {
    if (nodes[i] < nodes[minIdx]) {
      minIdx = i;
    }
  }
  const rotated = [...nodes.slice(minIdx), ...nodes.slice(0, minIdx)];
  return rotated.join(",");
}
