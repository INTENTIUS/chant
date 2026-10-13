import type { GraphIR, IRNode, IREdge } from "./graph-ir";
import { edgeLabel } from "./graph-mermaid";

/**
 * Render the graph IR as Graphviz DOT. Pure text — no `dot` needed to produce
 * it. Two consumers: render directly with `dot -Tsvg` (mingrammer-style), or
 * feed it to a layout engine for node positions that a custom painter draws
 * (the rackattack pattern; see {@link toLayout}). See issue #497 / epic #492.
 *
 * Consumes whatever IR it is given, so `--detail` (and future `--lens`) flow
 * through for free.
 */
export function toDot(ir: GraphIR): string {
  const lines: string[] = ["digraph chant {", "  rankdir=TB;", '  node [shape=box];'];

  // Cluster by wave (component graph) when present, else by lexicon (entity graph).
  const clusters = ir.groups.byWave ?? ir.groups.byLexicon;
  // CI pipelines (#3910) nest as clusters inside their lexicon's cluster.
  const pipelineOf = new Map<string, string>();
  for (const [name, members] of Object.entries(ir.groups.byPipeline ?? {})) {
    for (const id of members) if (!pipelineOf.has(id)) pipelineOf.set(id, name);
  }
  const grouped = new Set<string>();
  if (clusters) {
    for (const [name, members] of Object.entries(clusters)) {
      lines.push(`  subgraph ${q(`cluster_${name}`)} {`);
      lines.push(`    label=${q(name)};`);
      const nested = new Map<string, IRNode[]>();
      for (const id of members) {
        const node = ir.nodes.find((n) => n.id === id);
        if (!node) continue;
        grouped.add(id);
        const pipeline = pipelineOf.get(id);
        if (pipeline !== undefined) {
          const arr = nested.get(pipeline) ?? [];
          arr.push(node);
          nested.set(pipeline, arr);
          continue;
        }
        lines.push(`    ${nodeLine(node)}`);
      }
      for (const [pipeline, nodes] of [...nested].sort(([a], [b]) => a.localeCompare(b))) {
        lines.push(`    subgraph ${q(`cluster_${name}_pipeline_${pipeline}`)} {`);
        lines.push(`      label=${q(pipeline)};`);
        for (const node of nodes) lines.push(`      ${nodeLine(node)}`);
        lines.push("    }");
      }
      lines.push("  }");
    }
  }
  for (const node of ir.nodes) {
    if (grouped.has(node.id)) continue;
    lines.push(`  ${nodeLine(node)}`);
  }

  for (const e of ir.edges) lines.push(`  ${edgeLine(e)}`);

  // Unresolved references (#3910): a dashed edge to a dashed stub node.
  const stubs = new Set<string>();
  for (const d of ir.dangling ?? []) {
    const stub = `dangling:${d.value}`;
    if (!stubs.has(stub)) {
      stubs.add(stub);
      lines.push(`  ${q(stub)} [label=${q(`${d.value}\n(not declared)`)}, shape=box, style="rounded,dashed"];`);
    }
    lines.push(`  ${q(d.from)} -> ${q(stub)} [label=${q(d.kind)}, style=dashed];`);
  }

  lines.push("}");
  return lines.join("\n") + "\n";
}

function nodeLine(node: IRNode): string {
  const label = node.kind && node.kind !== node.id ? `${node.id}\n${node.kind}` : node.id;
  return `${q(node.id)} [label=${q(label)}];`;
}

function edgeLine(e: IREdge): string {
  const from = q(e.from);
  const to = q(e.to);
  const label = edgeLabel(e);
  const attrs = [label ? `label=${q(label)}` : "", e.crossPipeline ? "style=dashed" : ""].filter(Boolean);
  return attrs.length ? `${from} -> ${to} [${attrs.join(", ")}];` : `${from} -> ${to};`;
}

/** Quote a DOT identifier/label. Graphviz accepts any string in double quotes;
 * a real newline becomes the DOT line-break escape. */
function q(s: string): string {
  const esc = s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
  return `"${esc}"`;
}
