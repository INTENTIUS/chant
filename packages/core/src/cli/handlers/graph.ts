import { resolve } from "node:path";
import { discoverOps } from "../../op/discover";
import { discover } from "../../discovery/index";
import { partitionByLexicon, computeStackGraph } from "../../build";
import { buildGraphIr, type GraphIR } from "../../graph-ir";
import { applyDetail, type DetailLevel } from "../../graph-detail";
import { applyLens, parseLens } from "../../graph-lens";
import { toMermaid } from "../../graph-mermaid";
import { toDot } from "../../graph-dot";
import { GraphvizLayout } from "../../graph-layout";
import { lintCommand } from "../commands/lint";
import { formatError, formatWarning, formatBold } from "../format";
import type { CommandContext } from "../registry";

/**
 * `chant graph` — the Op dependency graph by default; `--stacks` renders the
 * cross-stack apply-ordering graph (edges, order, waves) chant computes from
 * cross-lexicon references; `--format ir|mermaid` emits the lint-gated
 * entity-graph IR (or a Mermaid flowchart of it) for diagrams (#493/#496).
 */
export async function runGraph(ctx: CommandContext): Promise<number> {
  const viewFormats = ["ir", "mermaid", "dot", "layout"] as const;
  if ((viewFormats as readonly string[]).includes(ctx.args.format)) {
    return runGraphView(ctx, ctx.args.format as (typeof viewFormats)[number]);
  }
  if (ctx.args.stacks) return runStackGraph(ctx);
  return runOpGraph();
}

/**
 * `chant graph --format ir|mermaid|dot|layout` — build the graph IR (honouring
 * `--detail`) and emit it as JSON, a Mermaid flowchart, Graphviz DOT, or node
 * positions from a layout engine. Lint-gated: the IR represents valid infra, so
 * we refuse to emit for source that does not pass lint. Non-zero on discovery
 * errors, or on a missing `dot` for `--format layout`.
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

  switch (format) {
    case "mermaid":
      console.log(toMermaid(ir));
      return 0;
    case "dot":
      console.log(toDot(ir));
      return 0;
    case "layout":
      try {
        const layout = await new GraphvizLayout().layout(toDot(ir));
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
