/**
 * Reads between workspace members, on the composed graph (#5331).
 *
 * A member read sees one member's files, so a Pulumi program's
 * `StackReference` to the stack another member applies cannot be resolved
 * there. The composition can: a lexicon's `workspaceStackReads` is asked with
 * every declared member and answers the reads it finds, and
 * {@link placeStackReads} draws each as an edge from the reader's stack node
 * to the upstream member's stack node, `viaAttr` naming the output read. A
 * stack no member applies is a node with `attrs.external: true`, in the
 * reader's member, and the edge goes to it. The edges have no `grain`,
 * `kind: "ref"` and `origin: "declared"`. Pure.
 */
import type { LexiconStackReads } from "../lexicon";
import type { ComposedEdge, ComposedNode, WorkspaceGraph } from "./compose-graph";

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The id of the node a stack no member applies is drawn as. */
export const externalStackId = (name: string): string => `external:${name}`;

/** Put `answer`'s stack nodes, external nodes and read edges on `graph`. */
export function placeStackReads(graph: WorkspaceGraph, answer: LexiconStackReads): void {
  if (answer.reads.length === 0) return;
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const added: ComposedNode[] = [];
  const add = (n: ComposedNode) => {
    if (nodes.has(n.id)) return;
    nodes.set(n.id, n);
    added.push(n);
  };
  const stackOf = new Map(answer.stacks.map((s) => [s.member, s]));
  const stackId = (member: string): string | undefined => {
    const s = stackOf.get(member);
    if (!s) return undefined;
    add({ id: `${member}/${s.id}`, kind: s.kind, lexicon: answer.lexicon, attrs: s.attrs, member });
    return `${member}/${s.id}`;
  };
  const edges = new Map<string, ComposedEdge>();
  for (const r of answer.reads) {
    const from = stackId(r.reader);
    if (from === undefined) continue;
    let to: string | undefined;
    if (r.upstream !== undefined) to = r.upstream === r.reader ? undefined : stackId(r.upstream);
    else if (r.external !== undefined) {
      to = externalStackId(r.external);
      add({ id: to, kind: stackOf.get(r.reader)!.kind, lexicon: answer.lexicon, attrs: { external: true, stack: r.external }, member: r.reader });
    }
    if (to === undefined) continue;
    edges.set(`${from}\u0000${to}\u0000${r.output ?? ""}`, { from, to, kind: "ref", ...(r.output !== undefined ? { viaAttr: r.output } : {}), origin: "declared", member: r.reader });
  }
  if (edges.size === 0 && added.length === 0) return;
  graph.nodes = [...graph.nodes, ...added].sort((a, b) => byString(a.id, b.id));
  for (const n of added) {
    const m = (graph.groups.byMember[n.member] ??= []);
    m.push(n.id);
    m.sort(byString);
    const l = ((graph.groups.byLexicon ??= {})[n.lexicon] ??= []);
    l.push(n.id);
    l.sort(byString);
  }
  const have = new Set(graph.edges.map((e) => `${e.from}\u0000${e.to}\u0000${e.viaAttr ?? ""}`));
  graph.edges = [...graph.edges, ...[...edges].filter(([k]) => !have.has(k)).map(([, e]) => e)].sort((a, b) =>
    byString(`${a.from}\u0000${a.to}\u0000${a.viaAttr ?? ""}`, `${b.from}\u0000${b.to}\u0000${b.viaAttr ?? ""}`),
  );
}
