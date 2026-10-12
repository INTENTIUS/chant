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

  // Cluster by wave (component graph) when present, else by lexicon (entity
  // graph); nodes outside any group fall through to the top level. Both are
  // sorted, so output is deterministic.
  const clusters = ir.groups.byWave ?? ir.groups.byLexicon;
  const clusterPrefix = ir.groups.byWave ? "wave" : "lex";
  // CI pipelines (#3910) nest inside their lexicon's cluster, one subgraph per
  // workflow or pipeline, so a cross-pipeline edge visibly leaves its box.
  const pipelineOf = new Map<string, string>();
  for (const [name, members] of Object.entries(ir.groups.byPipeline ?? {})) {
    for (const id of members) if (!pipelineOf.has(id)) pipelineOf.set(id, name);
  }
  const grouped = new Set<string>();
  if (clusters) {
    for (const [name, members] of Object.entries(clusters)) {
      lines.push(`  subgraph ${safeId(`${clusterPrefix}_${name}`, ids)}[${quote(name)}]`);
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
        lines.push(`    ${nodeLine(node, ids)}`);
      }
      for (const [pipeline, nodes] of [...nested].sort(([a], [b]) => a.localeCompare(b))) {
        lines.push(`    subgraph ${safeId(`pipe_${name}_${pipeline}`, ids)}[${quote(pipeline)}]`);
        for (const node of nodes) lines.push(`      ${nodeLine(node, ids)}`);
        lines.push("    end");
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

  // A reference to nothing in the graph (#3910) is drawn, not dropped: a
  // dashed edge to a rounded stub named by the string as written.
  const stubs = new Map<string, string>();
  for (const d of ir.dangling ?? []) {
    let stub = stubs.get(d.value);
    if (!stub) {
      stub = safeId(`dangling_${d.value}`, ids);
      stubs.set(d.value, stub);
      lines.push(`  ${stub}([${quote(`${d.value}\n(not declared)`)}])`);
    }
    lines.push(`  ${safeId(d.from, ids)} -.->|${quote(d.kind)}| ${stub}`);
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
  const label = edgeLabel(e);
  // A cross-pipeline edge is dashed, so it reads as leaving its workflow.
  const arrow = e.crossPipeline ? "-.->" : "-->";
  return label ? `${from} ${arrow}|${quote(label)}| ${to}` : `${from} ${arrow} ${to}`;
}

/** A typed reference is labelled by the attribute it flows through; a CI edge
 * (#3910) by its kind, plus the attribute when that says something more
 * (`needs (stage)` for GitLab's stage order). */
export function edgeLabel(e: IREdge): string {
  if (e.kind === "ref" || !e.kind) return [e.viaAttr, e.toAttr].filter(Boolean).join(" → ");
  return e.viaAttr && e.viaAttr !== e.kind ? `${e.kind} (${e.viaAttr})` : e.kind;
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
