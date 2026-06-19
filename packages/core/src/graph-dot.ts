import type { GraphIR, IRNode, IREdge } from "./graph-ir";

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

  const byLexicon = ir.groups.byLexicon;
  const grouped = new Set<string>();
  if (byLexicon) {
    for (const [lexicon, members] of Object.entries(byLexicon)) {
      lines.push(`  subgraph ${q(`cluster_${lexicon}`)} {`);
      lines.push(`    label=${q(lexicon)};`);
      for (const id of members) {
        const node = ir.nodes.find((n) => n.id === id);
        if (!node) continue;
        grouped.add(id);
        lines.push(`    ${nodeLine(node)}`);
      }
      lines.push("  }");
    }
  }
  for (const node of ir.nodes) {
    if (grouped.has(node.id)) continue;
    lines.push(`  ${nodeLine(node)}`);
  }

  for (const e of ir.edges) lines.push(`  ${edgeLine(e)}`);

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
  const label = [e.viaAttr, e.toAttr].filter(Boolean).join(" → ");
  return label ? `${from} -> ${to} [label=${q(label)}];` : `${from} -> ${to};`;
}

/** Quote a DOT identifier/label. Graphviz accepts any string in double quotes;
 * a real newline becomes the DOT line-break escape. */
function q(s: string): string {
  const esc = s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
  return `"${esc}"`;
}
