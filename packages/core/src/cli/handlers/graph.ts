import { resolve } from "node:path";
import { discoverOps } from "../../op/discover";
import { discover } from "../../discovery/index";
import { partitionByLexicon, computeStackGraph } from "../../build";
import { buildGraphIr } from "../../graph-ir";
import { lintCommand } from "../commands/lint";
import { formatError, formatWarning, formatBold } from "../format";
import type { CommandContext } from "../registry";

/**
 * `chant graph` — the Op dependency graph by default; `--stacks` renders the
 * cross-stack apply-ordering graph (edges, order, waves) chant computes from
 * cross-lexicon references; `--format ir` emits the full entity-graph IR
 * (lint-gated) for diagram painters and the agentic diagrammer (#493).
 */
export async function runGraph(ctx: CommandContext): Promise<number> {
  if (ctx.args.format === "ir") return runGraphIr(ctx);
  if (ctx.args.stacks) return runStackGraph(ctx);
  return runOpGraph();
}

/**
 * `chant graph --format ir` — emit the graph IR as JSON. Lint-gated: the IR is a
 * representation of valid infra, so we refuse to emit it for source that does
 * not pass lint (EVL + lexicon rules). Non-zero exit on discovery errors.
 */
async function runGraphIr(ctx: CommandContext): Promise<number> {
  const projectPath = resolve(ctx.args.path === "." ? "." : ctx.args.path);

  // Gate: only emit an IR for lint-clean source.
  const lint = await lintCommand({ path: ctx.args.path, format: "stylish" });
  if (!lint.success) {
    console.error(
      formatError({
        message:
          "Refusing to emit graph IR: source has lint errors. Run `chant lint` and fix them first.",
      }),
    );
    return 1;
  }

  const result = await discover(projectPath);
  if (result.errors.length > 0) {
    for (const e of result.errors) console.error(formatError({ message: e.message }));
    return 1;
  }

  const ir = buildGraphIr(result.entities, projectPath);
  console.log(JSON.stringify(ir, null, 2));
  return 0;
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
