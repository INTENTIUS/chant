import { resolve } from "node:path";
import { discover } from "./discovery/index";
import type { Declarable } from "./declarable";
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
 * Each stack's exports and imports come along with their `node` qualified the
 * same way (#4202), so a workspace viewer can still match an import in another
 * member to an export here once an environment is picked.
 *
 * A stack without `src` contributes nothing here — it has no declared source to
 * scope to (its live nodes still show as foreign in the overlay).
 *
 * `withEdges` adds what the lexicons' `graphEdges` hooks resolve to each
 * stack's graph before its ids are qualified (#4232).
 */
export async function buildDeclaredPerStack(
  stacks: Array<{ name: string; src?: string }>,
  projectPath: string,
  withEdges?: (ir: GraphIR, entities: Map<string, Declarable>) => GraphIR,
): Promise<GraphIR> {
  const nodes: IRNode[] = [];
  const edges: GraphIR["edges"] = [];
  const exports: NonNullable<GraphIR["exports"]> = [];
  const imports: NonNullable<GraphIR["imports"]> = [];
  // Which nodes belong to which stack (#1433). This is not derived or guessed:
  // the stack is declared in config and every node here is being renamed with
  // its name on the line below. The membership was always known and thrown
  // away, which left `byStack` — the axis consumers draw boundary boxes from —
  // empty for the one project shape that genuinely has side-by-side stacks.
  const byStack: Record<string, string[]> = {};
  for (const st of stacks) {
    if (!st.src) continue;
    const { entities } = await discover(resolve(projectPath, st.src));
    const built = buildGraphIr(entities, projectPath);
    const g = withEdges ? withEdges(built, entities) : built;
    const q = (id: string) => `${st.name}::${id}`;
    for (const n of g.nodes) {
      const id = q(n.id);
      nodes.push({ ...n, id });
      (byStack[st.name] ??= []).push(id);
    }
    for (const e of g.edges) edges.push({ ...e, from: q(e.from), to: q(e.to) });
    for (const e of g.exports ?? []) exports.push({ ...e, ...(e.node ? { node: q(e.node) } : {}) });
    for (const i of g.imports ?? []) imports.push({ ...i, node: q(i.node) });
  }
  for (const ids of Object.values(byStack)) ids.sort();
  const groups: GraphIR["groups"] = Object.keys(byStack).length ? { byStack } : {};
  return { nodes, edges, groups, ...(exports.length ? { exports } : {}), ...(imports.length ? { imports } : {}) };
}
