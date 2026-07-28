import { resolve } from "node:path";
import { build } from "../../build";
import { buildGraphIr, buildLiveGraphIr, type GraphIR, type IRNode } from "../../graph-ir";
import { reconstructEdges, mergeCatalogs, type ReferenceCatalog } from "../../graph-refs";
import { observeResources } from "../../lifecycle/observe";
import { discover } from "../../discovery/index";
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
    const stacks = (config.stacks ?? []).map((s) => s.name);
    const { observations, errors } = await observeResources(environment, observing, buildResult, {
      owned: true,
      stacks,
    });
    for (const e of errors) console.error(formatWarning({ message: e }));
    ir = buildLiveGraphIr(observations);
    for (const p of observing) {
      if (!p.enrichLiveAttrs) continue;
      try {
        const enriched = await p.enrichLiveAttrs({ environment, owned: true, stacks });
        ir = { ...ir, nodes: ir.nodes.map((n) => (enriched[n.id] ? { ...n, attrs: { ...n.attrs, ...enriched[n.id] } } : n)) };
      } catch {
        /* enrichment is best-effort; search still works on describe attrs */
      }
    }
    // Reconstruct edges from the observing lexicons' reference catalogs, so
    // ->/<- traversal works over the live estate (same as `graph --live`).
    const catalogs = observing.map((p) => p.referenceCatalog).filter((c): c is ReferenceCatalog => !!c);
    if (catalogs.length > 0) ir = { ...ir, edges: reconstructEdges(ir.nodes, mergeCatalogs(catalogs)).edges };
  } else {
    const discovered = await discover(resolve(args.src ?? config.sourceDir ?? "."));
    ir = buildGraphIr(discovered.entities);
  }

  const nodeById = new Map(ir.nodes.map((n) => [n.id, n]));
  const matches = ir.nodes.filter((n) => terms.every((t) => matchTerm(n, t, ir, nodeById)));
  if (matches.length === 0) {
    console.log("(no matches)");
    return 0;
  }
  for (const n of matches) {
    console.log(formatRow(n, show));
  }
  return 0;
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
  const parts: string[] = [n.id, n.kind ?? ""];
  // Prefer a live physical id; skip source-mode AttrRef placeholders (objects).
  const physical = attrs["physicalId"] ?? attrs["InstanceId"] ?? attrs["Id"];
  if (physical != null && typeof physical !== "object") parts.push(String(physical));
  for (const key of show) {
    const v = attrs[key];
    if (v != null && typeof v !== "object") parts.push(`${key}=${attrString(v)}`);
  }
  return parts.filter(Boolean).join("  ");
}

/** Internals exposed for unit tests. */
export const __searchInternals = { parseQuery, matchTerm, formatRow };
