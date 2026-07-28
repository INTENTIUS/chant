import { resolve } from "node:path";
import { discover } from "./discovery/index";
import { buildGraphIr, type GraphIR, type IRNode } from "./graph-ir";

/**
 * Build the DECLARED graph for a multi-stack project, scoped per stack (#1162).
 *
 * A whole-project discovery disambiguates colliding logical names by module path
 * (two `server`s become `UsEast1Srcserver` / `UsWest1Srcserver`) — names that
 * never appear in any deployed template, because each stack deploys its OWN
 * scoped source with BARE LogicalResourceIds. Observation therefore keys live
 * nodes by `${stack}::${logicalId}` (bare id). To make the declared side join
 * that live side, build each stack's `src` in isolation and qualify its node ids
 * and edge endpoints the same way. Stacks are merged into one graph.
 *
 * A stack without `src` contributes nothing here — it has no declared source to
 * scope to (its live nodes still show as foreign in the overlay).
 */
export async function buildDeclaredPerStack(
  stacks: Array<{ name: string; src?: string }>,
  projectPath: string,
): Promise<GraphIR> {
  const nodes: IRNode[] = [];
  const edges: GraphIR["edges"] = [];
  for (const st of stacks) {
    if (!st.src) continue;
    const g = buildGraphIr((await discover(resolve(projectPath, st.src))).entities, projectPath);
    const q = (id: string) => `${st.name}::${id}`;
    for (const n of g.nodes) nodes.push({ ...n, id: q(n.id) });
    for (const e of g.edges) edges.push({ ...e, from: q(e.from), to: q(e.to) });
  }
  return { nodes, edges, groups: {} };
}
