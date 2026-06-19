import type { GraphIR, IRNode, IREdge } from "./graph-ir";

/**
 * Render the graph IR as a Mermaid `flowchart`. Mermaid is the zero-install
 * default — it renders in GitHub, docs, and browsers with no native dependency,
 * so `chant graph --format mermaid` gives a diagram out of the box without the
 * standalone painter. Lower fidelity than a custom painter, but portable.
 *
 * Consumes whatever IR it is given, so it honours `--detail` and `--lens` for
 * free (those are IR → IR transforms). See issue #496 / epic #492.
 *
 * Known limits: Mermaid owns layout, so there is little control over node
 * placement, and very large graphs get hard to read — that is the trade-off for
 * zero-install portability. Reach for the graphviz/custom-painter path (#497,
 * pinhole) when fidelity matters.
 */
export function toMermaid(ir: GraphIR): string {
  const ids = new Map<string, string>(); // logical name -> mermaid-safe id
  for (const n of ir.nodes) safeId(n.id, ids);

  const lines: string[] = ["flowchart TD"];

  // Cluster by lexicon when grouping is available; nodes outside any group fall
  // through to the top level. byLexicon is sorted, so output is deterministic.
  const byLexicon = ir.groups.byLexicon;
  const grouped = new Set<string>();
  if (byLexicon) {
    for (const [lexicon, members] of Object.entries(byLexicon)) {
      lines.push(`  subgraph ${safeId(`lex_${lexicon}`, ids)}[${quote(lexicon)}]`);
      for (const id of members) {
        const node = ir.nodes.find((n) => n.id === id);
        if (!node) continue;
        grouped.add(id);
        lines.push(`    ${nodeLine(node, ids)}`);
      }
      lines.push("  end");
    }
  }
  for (const node of ir.nodes) {
    if (grouped.has(node.id)) continue;
    lines.push(`  ${nodeLine(node, ids)}`);
  }

  for (const e of ir.edges) {
    lines.push(`  ${edgeLine(e, ids)}`);
  }

  return lines.join("\n") + "\n";
}

function nodeLine(node: IRNode, ids: Map<string, string>): string {
  const id = safeId(node.id, ids);
  const parts = [node.id];
  if (node.kind && node.kind !== node.id) parts.push(node.kind);
  return `${id}[${quote(parts.join("\n"))}]`;
}

function edgeLine(e: IREdge, ids: Map<string, string>): string {
  const from = safeId(e.from, ids);
  const to = safeId(e.to, ids);
  const label = [e.viaAttr, e.toAttr].filter(Boolean).join(" → ");
  return label ? `${from} -->|${quote(label)}| ${to}` : `${from} --> ${to}`;
}

/** Map an arbitrary logical name to a stable, unique Mermaid-safe node id. */
function safeId(raw: string, ids: Map<string, string>): string {
  const existing = ids.get(raw);
  if (existing) return existing;
  let base = raw.replace(/[^A-Za-z0-9_]/g, "_");
  if (base === "" || /^[0-9]/.test(base)) base = `n_${base}`;
  const taken = new Set(ids.values());
  let candidate = base;
  let i = 1;
  while (taken.has(candidate)) candidate = `${base}_${i++}`;
  ids.set(raw, candidate);
  return candidate;
}

/** Quote a Mermaid label, escaping markup and turning newlines into <br/>. */
function quote(text: string): string {
  const esc = (s: string): string =>
    s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const body = text.split("\n").map(esc).join("<br/>");
  return `"${body}"`;
}
