import { resolve } from "node:path";
import { discoverOps } from "../../op/discover";
import { discover } from "../../discovery/index";
import { partitionByLexicon, computeStackGraph, build } from "../../build";
import { buildGraphIr, buildLiveGraphIr, type GraphIR } from "../../graph-ir";
import { observeResources } from "../../lifecycle/observe";
import { loadChantConfig } from "../../config";
import { applyDetail, type DetailLevel } from "../../graph-detail";
import { applyLens, parseLens } from "../../graph-lens";
import { toMermaid } from "../../graph-mermaid";
import { toDot } from "../../graph-dot";
import { getLayoutEngine, toLayoutInput, type NodeSize } from "../../graph-layout";
import { lintCommand } from "../commands/lint";
import { readFileSync } from "node:fs";
import { formatError, formatWarning, formatBold } from "../format";
import type { CommandContext } from "../registry";
import { computeComponentGraph } from "../../components/cli-support";

/**
 * `chant graph` — the Op dependency graph by default; `--stacks` renders the
 * cross-stack apply-ordering graph (edges, order, waves) chant computes from
 * cross-lexicon references; `--components` (#560) renders the same
 * order/waves shape for discovered `Component` declarations, from their
 * `dependsOn`; `--format ir|mermaid` emits the lint-gated entity-graph IR (or
 * a Mermaid flowchart of it) for diagrams (#493/#496).
 */
export async function runGraph(ctx: CommandContext): Promise<number> {
  const viewFormats = ["ir", "mermaid", "dot", "layout"] as const;
  const isViewFormat = (viewFormats as readonly string[]).includes(ctx.args.format);
  // `--live` graphs the provisioned (observed) infrastructure, not the declared
  // source (epic #776). It only makes sense as a view format; default to `ir`.
  if (ctx.args.live) {
    return runGraphLive(ctx, isViewFormat ? (ctx.args.format as (typeof viewFormats)[number]) : "ir");
  }
  if (isViewFormat) {
    return runGraphView(ctx, ctx.args.format as (typeof viewFormats)[number]);
  }
  if (ctx.args.components) return runComponentGraph(ctx);
  if (ctx.args.stacks) return runStackGraph(ctx);
  return runOpGraph();
}

/**
 * `chant graph --live --env <name> [--format ir|mermaid|dot|layout]` — the
 * **provisioned** graph (C1 of epic #776). Queries each lexicon's
 * `describeResources()` for the environment (managed-only: `owned`) and projects
 * the observed resources into IR nodes. Nodes only — edges are reconstructed by
 * the reference resolver (#778), containment by #779. No lint gate: this reads
 * the cloud, not source.
 */
async function runGraphLive(
  ctx: CommandContext,
  format: "ir" | "mermaid" | "dot" | "layout",
): Promise<number> {
  const { args, plugins } = ctx;
  const environment = args.env;
  if (!environment) {
    console.error(formatError({ message: "chant graph --live needs an environment: --live --env <name>" }));
    return 1;
  }

  const projectPath = resolve(".");
  const { config } = await loadChantConfig(projectPath);
  if (config.environments && !config.environments.includes(environment)) {
    console.error(formatError({
      message: `Unknown environment "${environment}"`,
      hint: `Defined environments: ${config.environments.join(", ")}`,
    }));
    return 1;
  }

  // Build to get each lexicon's entity names + output (the scope
  // describeResources needs), mirroring `chant lifecycle snapshot`.
  const buildResult = await build(resolve(args.src ?? config.sourceDir ?? "."), plugins.map((p) => p.serializer));
  if (buildResult.errors.length > 0) {
    console.error(formatError({ message: "Build failed — fix errors before graphing live state" }));
    return 1;
  }

  const observing = plugins.filter((p) => p.describeResources);
  if (observing.length === 0) {
    console.error(formatError({ message: "No lexicons implement describeResources — nothing to observe live." }));
    return 1;
  }

  const { observations, errors } = await observeResources(environment, observing, buildResult, { owned: true });
  for (const e of errors) console.error(formatWarning({ message: e }));

  let ir: GraphIR = buildLiveGraphIr(observations);
  if (args.lens) {
    try {
      ir = applyLens(ir, parseLens(args.lens, { up: args.up, down: args.down }));
    } catch (err) {
      console.error(formatError({ message: err instanceof Error ? err.message : String(err) }));
      return 1;
    }
  }
  ir = applyDetail(ir, (args.detail ?? 2) as DetailLevel);
  return emitIr(ir, ctx, format);
}

/**
 * `chant graph --components` (#560) — dependency order/waves for discovered
 * `Component` declarations, mirroring `runStackGraph`'s presentation
 * (waves top-to-bottom, consumer → producer edges) but sourced from
 * `computeComponentGraph` (../../components/cli-support.ts), which resolves
 * order purely from each component's flat `dependsOn` list — no AttrRef-style
 * cross-lexicon inference needed, since a component's dependency is always
 * an explicit name.
 */
async function runComponentGraph(ctx: CommandContext): Promise<number> {
  const projectPath = resolve(ctx.args.path === "." ? "." : ctx.args.path);
  const graph = await computeComponentGraph(projectPath);

  if (!graph.success) {
    console.error(formatError({ message: graph.error ?? "Failed to compute component graph" }));
    return 1;
  }

  if (ctx.args.json) {
    console.log(JSON.stringify(graph, null, 2));
    return 0;
  }

  if (graph.order.length === 0) {
    console.log("No components found");
    return 0;
  }

  console.log(formatBold("Deploy order (waves apply top-to-bottom; a wave's components are parallel-safe):"));
  graph.waves.forEach((wave, i) => console.log(`  ${i + 1}. ${wave.join(", ")}`));

  if (graph.edges.length > 0) {
    console.log(formatBold("\nDependencies (consumer → producer):"));
    for (const { from, to } of graph.edges) console.log(`  ${from} → ${to}`);
  } else {
    console.log("\nNo cross-component dependencies — all components are independent.");
  }

  return 0;
}

/**
 * `chant graph --format ir|mermaid|dot|layout` — build the graph IR (honouring
 * `--detail`) and emit it as JSON, a Mermaid flowchart, Graphviz DOT, or node
 * positions from a layout engine. `layout` takes optional painter-measured
 * `--node-sizes` so spacing fits real node footprints, and defaults to the dagre
 * engine (no native dependency); `--layout-engine graphviz` opts into `dot`.
 * Lint-gated: the IR represents valid infra, so we refuse to emit for source that
 * does not pass lint. Non-zero on discovery errors or a layout-engine failure.
 */
async function runGraphView(
  ctx: CommandContext,
  format: "ir" | "mermaid" | "dot" | "layout",
): Promise<number> {
  const projectPath = resolve(ctx.args.path === "." ? "." : ctx.args.path);

  const level = ctx.args.detail ?? 2;
  if (![0, 1, 2, 3].includes(level)) {
    console.error(formatError({ message: `Invalid --detail ${level}. Expected 0, 1, 2, or 3.` }));
    return 1;
  }

  // Gate: only emit for lint-clean source.
  const lint = await lintCommand({ path: ctx.args.path, format: "stylish" });
  if (!lint.success) {
    console.error(
      formatError({
        message:
          "Refusing to emit graph: source has lint errors. Run `chant lint` and fix them first.",
      }),
    );
    return 1;
  }

  const result = await discover(projectPath);
  if (result.errors.length > 0) {
    for (const e of result.errors) console.error(formatError({ message: e.message }));
    return 1;
  }

  // Build the base IR, focus with a lens (declarable-level, most precise), then
  // apply the detail tier — so e.g. blast:<resource> works before any collapse.
  let ir: GraphIR = buildGraphIr(result.entities, projectPath);
  if (ctx.args.lens) {
    try {
      ir = applyLens(ir, parseLens(ctx.args.lens, { up: ctx.args.up, down: ctx.args.down }));
    } catch (err) {
      console.error(formatError({ message: err instanceof Error ? err.message : String(err) }));
      return 1;
    }
  }
  ir = applyDetail(ir, level as DetailLevel);
  return emitIr(ir, ctx, format);
}

/** Emit a built IR in the requested view format — shared by the source
 * (`runGraphView`) and live (`runGraphLive`) paths. */
async function emitIr(
  ir: GraphIR,
  ctx: CommandContext,
  format: "ir" | "mermaid" | "dot" | "layout",
): Promise<number> {
  switch (format) {
    case "mermaid":
      console.log(toMermaid(ir));
      return 0;
    case "dot":
      console.log(toDot(ir));
      return 0;
    case "layout":
      try {
        const sizes = readNodeSizes(ctx.args.nodeSizes);
        const engine = getLayoutEngine(ctx.args.layoutEngine);
        const layout = await engine.layout(toLayoutInput(ir, sizes));
        console.log(JSON.stringify(layout, null, 2));
        return 0;
      } catch (err) {
        console.error(formatError({ message: err instanceof Error ? err.message : String(err) }));
        return 1;
      }
    case "ir":
    default:
      console.log(JSON.stringify(ir, null, 2));
      return 0;
  }
}

/**
 * Resolve the `--node-sizes` value into a `{ id: {w, h} }` map. The spec is one
 * of: inline JSON, `-` (read JSON from stdin, to dodge arg-length limits), or
 * `@path` (read from a file). Empty/absent → no sizes (engine uses defaults).
 * Throws on malformed JSON so a typo fails loudly rather than mis-laying out.
 */
function readNodeSizes(spec?: string): Record<string, NodeSize> {
  if (!spec) return {};
  let raw: string;
  if (spec === "-") raw = readFileSync(0, "utf8");
  else if (spec.startsWith("@")) raw = readFileSync(spec.slice(1), "utf8");
  else raw = spec;
  raw = raw.trim();
  if (!raw) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`--node-sizes is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("--node-sizes must be a JSON object mapping node id → {w, h}");
  }
  const out: Record<string, NodeSize> = {};
  for (const [id, val] of Object.entries(parsed as Record<string, unknown>)) {
    const v = val as { w?: unknown; h?: unknown };
    if (typeof v?.w === "number" && typeof v?.h === "number" && v.w > 0 && v.h > 0) {
      out[id] = { w: v.w, h: v.h };
    }
  }
  return out;
}

async function runOpGraph(): Promise<number> {
  const { ops, errors } = await discoverOps();
  for (const err of errors) console.error(formatError({ message: err }));

  if (ops.size === 0) {
    console.log("No Ops found");
    return 0;
  }

  let hasEdges = false;
  for (const [name, { config }] of ops) {
    for (const dep of config.depends ?? []) {
      console.log(`${dep} → ${name}`);
      hasEdges = true;
    }
  }
  if (!hasEdges) console.log("No Op dependencies");
  return 0;
}

async function runStackGraph(ctx: CommandContext): Promise<number> {
  const projectPath = resolve(ctx.args.path === "." ? "." : ctx.args.path);
  const result = await discover(projectPath);
  if (result.errors.length > 0) {
    for (const e of result.errors) console.error(formatError({ message: e.message }));
    return 1;
  }

  const lexicons = [...partitionByLexicon(result.entities).keys()];
  const graph = computeStackGraph(result.entities, lexicons);

  if (ctx.args.json) {
    console.log(JSON.stringify(graph, null, 2));
    return graph.cycles.length > 0 ? 1 : 0;
  }

  if (graph.nodes.length === 0) {
    console.log("No stacks found");
    return 0;
  }

  console.log(formatBold("Apply order (waves apply top-to-bottom; a wave's stacks are parallel-safe):"));
  graph.waves.forEach((wave, i) => console.log(`  ${i + 1}. ${wave.join(", ")}`));

  if (graph.edges.length > 0) {
    console.log(formatBold("\nDependencies (consumer → producer):"));
    for (const { from, to } of graph.edges) console.log(`  ${from} → ${to}`);
  } else {
    console.log("\nNo cross-stack dependencies — all stacks are independent.");
  }

  if (graph.cycles.length > 0) {
    for (const cycle of graph.cycles) {
      console.error(formatWarning({ message: `Dependency cycle among stacks: ${cycle.join(" ↔ ")}` }));
    }
    return 1;
  }
  return 0;
}
