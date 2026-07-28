import { resolve } from "node:path";
import { build } from "../../build";
import { buildGraphIr, buildLiveGraphIr, sourceOverlayGraphs, type GraphIR, type IRNode } from "../../graph-ir";
import { buildDeclaredPerStack } from "../../graph-declared";
import { discover } from "../../discovery/index";

import { observeResources } from "../../lifecycle/observe";
import { loadChantConfig } from "../../config";
import { loadPlugins, resolveProjectLexicons } from "../plugins";
import { formatError, formatWarning } from "../format";
import type { CommandContext } from "../registry";

/**
 * `chant search <query> [--live --env <name>]` — answer an estate question with
 * a COMPACT result instead of the whole graph. The point (measured on aws-bench,
 * #1139): a small model shouldn't ingest a multi-thousand-token IR dump to answer
 * "which instances are in public subnets" — it should query and get a few rows.
 *
 * Query grammar (space-separated terms, all must match — AND):
 *   bare word            case-insensitive substring over id, kind, and attrs
 *   kind:<substr>        node kind contains <substr> (e.g. kind:EC2::Instance)
 *   tag:<key>=<val>      a Tags entry with Key=key and Value containing val
 *   attr:<name>=<val>    attribute <name> equals/contains <val>
 *   ->kind:X / ->attr:.. this node has an edge TO a node matching the right side
 *   <-kind:X / <-attr:.. this node has an edge FROM a node matching the right side
 *
 * The edge operators are the point of "edge-aware" search (#1139): a small
 * model shouldn't hand-join instance→subnet→public across many results — one
 * query does the traversal. `kind:Instance ->attr:MapPublicIpOnLaunch=true`
 * = instances that reference a public subnet.
 *
 * Output: one line per match — `<id>  <kind>  <key=val ...>` — with only the
 * physical id and any attributes named in `attr:`/`--show`. Tens of tokens, not
 * thousands.
 */
export async function runSearch(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const query = (args.path ?? "").trim();
  if (!query) {
    console.error(formatError({ message: "chant search needs a query: chant search \"<terms>\" [--live --env <name>]" }));
    return 1;
  }
  const terms = parseQuery(query);
  const show = parseShow(args);

  const projectPath = resolve(".");
  const { config } = await loadChantConfig(projectPath);

  let ir: GraphIR;
  if (args.live) {
    const environment = args.env;
    if (!environment) {
      console.error(formatError({ message: "chant search --live needs an environment: --live --env <name>" }));
      return 1;
    }
    if (config.environments && !config.environments.includes(environment)) {
      console.error(formatError({ message: `Unknown environment "${environment}"` }));
      return 1;
    }
    const plugins = ctx.plugins.length > 0 ? ctx.plugins : await loadPlugins(await resolveProjectLexicons(projectPath));
    const buildResult = await build(resolve(args.src ?? config.sourceDir ?? "."), plugins.map((p) => p.serializer));
    if (buildResult.errors.length > 0) {
      console.error(formatError({ message: "Build failed — fix errors before searching live state" }));
      return 1;
    }
    const observing = plugins.filter((p) => p.describeResources);
    const stacks = (config.stacks ?? []).map((s) => ({ name: s.name, region: s.region, src: s.src }));
    const { observations, errors } = await observeResources(environment, observing, buildResult, {
      owned: true,
      stacks,
    });
    for (const e of errors) console.error(formatWarning({ message: e }));
    let live = buildLiveGraphIr(observations);
    for (const p of observing) {
      if (!p.enrichLiveAttrs) continue;
      try {
        const enriched = await p.enrichLiveAttrs({ environment, owned: true, stacks });
        live = { ...live, nodes: live.nodes.map((n) => (enriched[n.id] ? { ...n, attrs: { ...n.attrs, ...enriched[n.id] } } : n)) };
      } catch {
        /* enrichment is best-effort; search still works on describe attrs */
      }
    }
    // Overlay live identity onto the SOURCE graph (same as `graph --overlay`):
    // the declared graph is the canvas — its edges carry the topology so ->/<-
    // resolves, while the live side supplies physical ids.
    //
    // Multi-stack (#1162): build the declared graph PER STACK (scoped to each
    // stack's src, the way it deploys) and stack-qualify node ids + edges as
    // `${stack}::${id}` — matching how observation qualifies. A flat whole-
    // project discovery would disambiguate colliding names by module path
    // (UsEast1Src…), which never matches the observed bare LogicalResourceIds.
    const declared =
      stacks.length > 0
        ? await buildDeclaredPerStack(stacks, projectPath)
        : buildGraphIr((await discover(resolve(args.src ?? config.sourceDir ?? "."))).entities, projectPath);
    ir = sourceOverlayGraphs(declared, live);
  } else {
    const discovered = await discover(resolve(args.src ?? config.sourceDir ?? "."));
    ir = buildGraphIr(discovered.entities);
  }

  const nodeById = new Map(ir.nodes.map((n) => [n.id, n]));
  const matches = ir.nodes.filter((n) => terms.every((t) => matchTerm(n, t, ir, nodeById)));
  if (matches.length === 0) {
    console.log("(no matches)");
    if (args.explain) explain(terms, matches, ir, nodeById, query);
    return 0;
  }
  for (const n of matches) {
    console.log(formatRow(n, show));
  }
  if (args.explain) explain(terms, matches, ir, nodeById, query);
  return 0;
}

/**
 * `--explain` footer (#1139): a compact, model-DERIVED summary that gives a
 * small model a reason to trust the result instead of re-deriving it with a
 * lossy CLI sweep. It reports the universe count ("4 of 6 Instances") — chant's
 * structural edge, since the typed graph knows the denominator a live sweep
 * doesn't — and, for the near-miss set, WHY each was excluded (which query term
 * it fails). Everything here is a property of the query over the graph, not of
 * any expected answer, so it stays a fair, question-agnostic capability.
 */
function explain(terms: Term[], matches: IRNode[], ir: GraphIR, byId: Map<string, IRNode>, query: string): void {
  const kinds = new Set(matches.map((n) => n.kind).filter((k): k is string => !!k));
  const universe = kinds.size > 0 ? ir.nodes.filter((n) => n.kind && kinds.has(n.kind)) : ir.nodes;
  const matched = new Set(matches.map((n) => n.id));
  const excluded = universe.filter((n) => !matched.has(n.id));
  const kindLabel = kinds.size > 0 ? [...kinds].join("/") : "nodes";
  console.log(`— ${matches.length} of ${universe.length} ${kindLabel} matched  (query: ${query})`);
  const shown = excluded.slice(0, 8);
  for (const n of shown) {
    const failing = terms.find((t) => !matchTerm(n, t, ir, byId));
    const id = n.id.includes("::") ? n.id.slice(n.id.lastIndexOf("::") + 2) : n.id;
    console.log(`  · excluded ${id} — fails ${failing ? describeTerm(failing) : "(query)"}`);
  }
  if (excluded.length > shown.length) console.log(`  · …and ${excluded.length - shown.length} more excluded`);
}

function describeTerm(t: Term): string {
  const leaf = (x: Term): string =>
    x.kind === "kind" ? `kind:${x.a}` : x.kind === "attr" ? `attr:${x.a}${x.b !== undefined ? "=" + x.b : ""}`
      : x.kind === "tag" ? `tag:${x.a}${x.b !== undefined ? "=" + x.b : ""}` : `"${x.a}"`;
  if (t.kind === "edge" && t.sub) return `${t.dir === "out" ? "→" : "←"}${leaf(t.sub)} (no such edge)`;
  return leaf(t);
}

interface Term {
  kind: "word" | "kind" | "tag" | "attr" | "edge";
  a: string;
  b?: string;
  /** For edge terms: the direction and the sub-predicate matched at the far end. */
  dir?: "out" | "in";
  sub?: Term;
}

function parseLeaf(tok: string): Term {
  const m = /^(kind|tag|attr):(.*)$/i.exec(tok);
  if (m) {
    const key = m[1].toLowerCase() as Term["kind"];
    const rest = m[2];
    const eq = rest.indexOf("=");
    if (eq >= 0) return { kind: key, a: rest.slice(0, eq), b: rest.slice(eq + 1) };
    return { kind: key, a: rest };
  }
  return { kind: "word", a: tok };
}

function parseQuery(query: string): Term[] {
  // Split on whitespace but keep quoted phrases together.
  const tokens = query.match(/"[^"]*"|\S+/g) ?? [];
  return tokens.map((raw) => {
    const tok = raw.replace(/^"|"$/g, "");
    if (tok.startsWith("->")) return { kind: "edge", a: "", dir: "out", sub: parseLeaf(tok.slice(2)) };
    if (tok.startsWith("<-")) return { kind: "edge", a: "", dir: "in", sub: parseLeaf(tok.slice(2)) };
    return parseLeaf(tok);
  });
}

function parseShow(args: { show?: string }): string[] {
  return args.show ? args.show.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

function attrString(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "object") {
    // AttrRef placeholder ({$ref}) or nested — stringify shallowly.
    return JSON.stringify(v);
  }
  return String(v);
}

function matchTerm(n: IRNode, t: Term, ir?: GraphIR, byId?: Map<string, IRNode>): boolean {
  const attrs = n.attrs ?? {};
  if (t.kind === "edge") {
    if (!ir || !byId || !t.sub) return false;
    // A node matches if it has an edge (out or in) to a node satisfying `sub`.
    const edges = ir.edges ?? [];
    const neighbors = edges
      .filter((e) => (t.dir === "out" ? e.from === n.id : e.to === n.id))
      .map((e) => byId.get(t.dir === "out" ? e.to : e.from))
      .filter((x): x is IRNode => !!x);
    return neighbors.some((m) => matchTerm(m, t.sub!, ir, byId));
  }
  if (t.kind === "kind") return (n.kind ?? "").toLowerCase().includes(t.a.toLowerCase());
  if (t.kind === "attr") {
    const val = attrString((attrs as Record<string, unknown>)[t.a]);
    return t.b === undefined ? t.a in attrs : val.toLowerCase().includes(t.b.toLowerCase());
  }
  if (t.kind === "tag") {
    const tags = (attrs as Record<string, unknown>)["Tags"];
    if (!Array.isArray(tags)) return false;
    return tags.some((tag) => {
      const key = attrString((tag as Record<string, unknown>)?.Key);
      const val = attrString((tag as Record<string, unknown>)?.Value);
      return key.toLowerCase() === t.a.toLowerCase() && (t.b === undefined || val.toLowerCase().includes(t.b.toLowerCase()));
    });
  }
  // bare word: substring over id, kind, and all attr values
  const hay = [n.id, n.kind, ...Object.values(attrs).map(attrString)].join(" ").toLowerCase();
  return hay.includes(t.a.toLowerCase());
}

function formatRow(n: IRNode, show: string[]): string {
  const attrs = (n.attrs ?? {}) as Record<string, unknown>;
  // Display the bare logical id, not the `${stack}::` qualification (#1162).
  const displayId = n.id.includes("::") ? n.id.slice(n.id.lastIndexOf("::") + 2) : n.id;
  const parts: string[] = [displayId, n.kind ?? ""];
  // Prefer the node-level live physicalId (set by the overlay), then attrs;
  // skip source-mode AttrRef placeholders (objects).
  const physical = (n as { physicalId?: unknown }).physicalId ?? attrs["physicalId"] ?? attrs["InstanceId"] ?? attrs["Id"];
  if (physical != null && typeof physical !== "object") parts.push(String(physical));
  for (const key of show) {
    const v = attrs[key];
    if (v != null && typeof v !== "object") parts.push(`${key}=${attrString(v)}`);
  }
  return parts.filter(Boolean).join("  ");
}

/** Internals exposed for unit tests. */
export const __searchInternals = { parseQuery, matchTerm, formatRow, explain, describeTerm };
