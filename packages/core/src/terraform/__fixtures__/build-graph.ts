import { buildGraph, collectExpressions, type ExpressionRefs } from "../graph";
import type { Hcl2JsonTree, TfGraph } from "../types";

/**
 * Shortest-hop count from `address` back through inbound edges — how many
 * dependents-of-dependents deep the estate goes behind that node (#2323).
 * Production has no reachability pass yet (that is the spike's sub-issue 3);
 * this is a test-only BFS over the same `TfGraph` shape, so a fixture's depth
 * can be asserted without waiting on that feature. Folds/outputs are not
 * special-cased: an output pseudo-address has no inbound edges by
 * construction (`buildGraph` never lets anything reference an output), so it
 * is always a dead end and never inflates the count.
 */
function inboundDepthOf(graph: TfGraph, address: string): number {
  let frontier = new Set([address]);
  const visited = new Set(frontier);
  let depth = 0;
  for (;;) {
    const next = new Set<string>();
    for (const e of graph.edges) {
      if (frontier.has(e.to) && !visited.has(e.from)) next.add(e.from);
    }
    if (next.size === 0) return depth;
    depth++;
    for (const addr of next) visited.add(addr);
    frontier = next;
  }
}

/**
 * The longest inbound chain anywhere in the graph — the same "depth" column
 * the spike measured (docs/design/carve-dependency-blast-radius-spike.md
 * section 2): 1 hop is a direct dependent, 2 is a dependent of a dependent,
 * and so on. Every shipped fixture tops out at 1; `depth-estate` is built to
 * clear that.
 */
export function maxTransitiveInboundDepth(graph: TfGraph): number {
  let max = 0;
  for (const node of graph.nodes) {
    const depth = inboundDepthOf(graph, node.address);
    if (depth > max) max = depth;
  }
  return max;
}

/**
 * Test-only stand-in for the hcl2json expression AST (`parse.ts`'s
 * `resolveExpressionRefs`). Fixture expressions are simple `${<accessor>}`
 * templates, so each one's accessor list is just its interpolation bodies.
 * Production never takes this path — `parseTerraformDir` resolves every
 * expression through `getReferencesInExpression`.
 */
export function fixtureExprRefs(tree: Hcl2JsonTree): ExpressionRefs {
  const refs = new Map<string, string[]>();
  for (const expr of collectExpressions(tree)) {
    refs.set(
      expr,
      [...expr.matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1].trim()),
    );
  }
  return refs;
}

/** `buildGraph` over a hand-written fixture tree, accessors derived per {@link fixtureExprRefs}. */
export function buildFixtureGraph(tree: Hcl2JsonTree): TfGraph {
  return buildGraph(tree, fixtureExprRefs(tree));
}
