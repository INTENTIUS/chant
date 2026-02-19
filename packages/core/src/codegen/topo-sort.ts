/**
 * Generic DFS-based topological sort.
 */

/**
 * Sort nodes in topological order (dependencies first).
 *
 * @param nodes - The items to sort.
 * @param getId - Extract a unique identifier from a node.
 * @param getEdges - Return the IDs of nodes that `node` depends on.
 * @returns Sorted array where dependencies appear before dependents.
 */
export function topoSort<T>(
  nodes: T[],
  getId: (node: T) => string,
  getEdges: (node: T) => string[],
): T[] {
  const result: T[] = [];
  const added = new Set<string>();
  const nodeMap = new Map<string, T>();

  for (const node of nodes) {
    nodeMap.set(getId(node), node);
  }

  function visit(node: T): void {
    const id = getId(node);
    if (added.has(id)) return;

    for (const dep of getEdges(node)) {
      const depNode = nodeMap.get(dep);
      if (depNode && !added.has(dep)) {
        visit(depNode);
      }
    }

    result.push(node);
    added.add(id);
  }

  for (const node of nodes) {
    visit(node);
  }

  return result;
}
