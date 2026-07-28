import { resolve } from "node:path";
import { discoverOps } from "../../op/discover";
import { discover } from "../../discovery/index";
import { partitionByLexicon, computeStackGraph, build } from "../../build";
import { buildGraphIr, buildLiveGraphIr, collectUnobserved, overlayGraphs, sourceOverlayGraphs, type GraphIR } from "../../graph-ir";
import { reconstructEdges, mergeCatalogs, containmentGroups, type ReferenceCatalog, type ContainmentPair } from "../../graph-refs";
import { observeResources } from "../../lifecycle/observe";
import { loadChantConfig } from "../../config";
import { applyDetail, type DetailLevel } from "../../graph-detail";
import { applyLens, parseLens } from "../../graph-lens";
import { toMermaid } from "../../graph-mermaid";
import { toDot } from "../../graph-dot";
import { getLayoutEngine, toLayoutInput, type NodeSize } from "../../graph-layout";
import { lintCommand } from "../commands/lint";
import { loadPlugins, resolveProjectLexicons } from "../plugins";
import { readFileSync } from "node:fs";
import { formatError, formatWarning, formatBold } from "../format";
import type { CommandContext } from "../registry";
import { computeComponentGraph } from "../../components/cli-support";
import { discoverComponents } from "../../components/discover";
import { cfnDeployStacks } from "./components";

/**
 * `chant graph` — the Op dependency graph by default; `--stacks` renders the
 * cross-stack apply-ordering graph (edges, order, waves) chant computes from
 * cross-lexicon references; `--components` (#560) renders the same
 * order/waves shape for discovered `Component` declarations, from their
 * `dependsOn`; `--format ir|mermaid` emits the lint-gated entity-graph IR (or
 * a Mermaid flowchart of it) for diagrams (#493/#496). `--components` with a
 * `--format` projects the component DAG itself into that format (nodes =
 * components, wave groups, `dependsOn` edges) — the graph behold renders.
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
    // `--components` projects the component DAG (nodes = components, wave groups,
    // dependsOn edges) into the same view formats; without it, the entity graph.
    if (ctx.args.components) {
      return runComponentGraphView(ctx, ctx.args.format as (typeof viewFormats)[number]);
    }
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
  const { args } = ctx;
  const environment = args.env;
  if (!environment) {
    console.error(formatError({ message: "chant graph --live needs an environment: --live --env <name>" }));
    return 1;
  }

  const projectPath = resolve(".");
  const { config } = await loadChantConfig(projectPath);
  // `graph` is not `requiresPlugins` (Op/source-graph modes must work without a
  // lexicon), so `ctx.plugins` is empty. The live path needs the project's
  // observation plugins — load them here, mirroring the lifecycle handlers.
  const plugins = ctx.plugins.length > 0 ? ctx.plugins : await loadPlugins(await resolveProjectLexicons(projectPath));
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

  // Multi-stack, per-component projects (loomster/Floci, #57): AWS's
  // single-stack convention (`describeResources` defaults to a stack named
  // after the environment, lexicons/aws/src/plugin.ts) never matches a
  // per-component layout (e.g. `loom-local-a-<component>`), so the plain
  // single call always observes zero nodes. Resolve every discovered
  // component's `cfn-deploy` stack(s) — the same walk `chant components
  // status --live` uses (`cfnDeployStacks`, ./components.ts) — and hand them
  // to `observeResources`, which queries `describeResources` once per stack
  // and unions the results. A project with no components (or whose discovery
  // errors) yields no stacks, so `observeResources` falls back to its
  // original single-stack call — unchanged.
  const componentsDiscovery = await discoverComponents(resolve(args.src ?? config.sourceDir ?? "."), {
    sandbox: args.sandbox,
  });
  const stacks = new Set<string>();
  if (componentsDiscovery.errors.length === 0) {
    for (const { component } of componentsDiscovery.components.values()) {
      for (const stack of cfnDeployStacks(component.deploy)) stacks.add(stack);
    }
  } else {
    console.error(formatWarning({ message: "component discovery failed — observing the single-stack convention instead" }));
  }

  const { observations, errors, warnings } = await observeResources(environment, observing, buildResult, {
    owned: true,
    stacks: [...stacks],
  });
  for (const e of errors) console.error(formatWarning({ message: e }));
  // Unobserved entities (#1089) arrive as warnings — a node missing from the
  // live graph because nobody looked is a different fact from one that isn't
  // deployed, and the diagram alone cannot say which. Capped: an estate with no
  // ownership markers can produce one per declared entity, and a wall of them
  // buries the graph output. The full list is `lifecycle diff --live`.
  const WARN_CAP = 5;
  for (const w of warnings.slice(0, WARN_CAP)) console.error(formatWarning({ message: w }));
  if (warnings.length > WARN_CAP) {
    console.error(formatWarning({
      message: `... and ${warnings.length - WARN_CAP} more entity(ies) not observed — run \`chant lifecycle diff ${environment} --live\` for the full list`,
    }));
  }

  let ir: GraphIR = buildLiveGraphIr(observations);

  // Enrich node attrs from the fuller live config (#784) so references are
  // present for edge reconstruction — describeResources metadata alone is often
  // too thin (e.g. AWS returns stack outputs, not per-resource references).
  for (const p of observing) {
    if (!p.enrichLiveAttrs) continue;
    try {
      const enriched = await p.enrichLiveAttrs({ environment, owned: true });
      ir = {
        ...ir,
        nodes: ir.nodes.map((n) =>
          n.lexicon === p.name && enriched[n.id] ? { ...n, attrs: { ...n.attrs, ...enriched[n.id] } } : n,
        ),
      };
    } catch (err) {
      console.error(formatWarning({ message: `${p.name}: live attr enrichment failed — edges may be sparse (${err instanceof Error ? err.message : String(err)})` }));
    }
  }

  // Reconstruct edges + containment from live references (#778): merge the
  // observing lexicons' reference catalogs and resolve them over the live nodes.
  const catalogs = observing.map((p) => p.referenceCatalog).filter((c): c is ReferenceCatalog => !!c);
  let containment: ContainmentPair[] = [];
  if (catalogs.length > 0) {
    const reconstructed = reconstructEdges(ir.nodes, mergeCatalogs(catalogs));
    ir = { ...ir, edges: reconstructed.edges };
    containment = reconstructed.containment;
  }

  // Drift overlay: classify each resource against declared source (managed /
  // foreign / pending) so a renderer colours the drift. Two anchorings:
  //   - source (default, #821): declared graph is the canvas — keeps its edges,
  //     so cross-substrate topology survives; live status joined per node.
  //   - live (#780): provisioned graph is the canvas — reconstructed live edges.
  if (args.overlay) {
    const declared = await discover(resolve(args.src ?? config.sourceDir ?? "."));
    if (declared.errors.length === 0) {
      const declaredIr = buildGraphIr(declared.entities, projectPath);
      // Declared nodes chant could not read are painted `neutral`, not
      // `accent`/pending (#1089) — a wrong-cluster or unsupported-kind read
      // must not draw the estate as "not deployed yet".
      const overlayOpts = { unobserved: collectUnobserved(observations) };
      ir =
        args.overlayAnchor === "live"
          ? overlayGraphs(ir, declaredIr, overlayOpts)
          : sourceOverlayGraphs(declaredIr, ir, overlayOpts);
    } else {
      console.error(formatWarning({ message: "overlay: source has discovery errors — showing the provisioned graph without the declared overlay" }));
    }
  }

  if (args.lens) {
    try {
      ir = applyLens(ir, parseLens(args.lens, { up: args.up, down: args.down }));
    } catch (err) {
      console.error(formatError({ message: err instanceof Error ? err.message : String(err) }));
      return 1;
    }
  }
  ir = applyDetail(ir, (args.detail ?? 2) as DetailLevel);

  // Containment grouping (#779) → boundary boxes. Built after lens/detail and
  // filtered to surviving nodes, so a lens can't leave dangling group refs.
  if (containment.length > 0) {
    const present = new Set(ir.nodes.map((n) => n.id));
    const byContainer = containmentGroups(containment.filter((c) => present.has(c.child) && present.has(c.parent)));
    if (Object.keys(byContainer).length > 0) {
      ir = { ...ir, groups: { ...ir.groups, byContainer } };
    }
  }

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
  const graph = await computeComponentGraph(projectPath, ctx.args.sandbox);

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
 * `chant graph --components --format ir|mermaid|dot|layout` — the component DAG
 * projected into the renderable IR (nodes = components, `groups.byWave` = the
 * parallel-safe deploy waves, edges = `dependsOn` consumer → producer). This is
 * the graph behold paints: read one way it is the deploy order, read the other
 * the CI pipeline. Distinct from `runGraphView`, which emits the AWS *entity*
 * graph — the component projection has one node per component, not per resource.
 *
 * Lint-gated like the entity view: the DAG stands for deployable source, so we
 * refuse to emit it for source that does not pass lint.
 */
async function runComponentGraphView(
  ctx: CommandContext,
  format: "ir" | "mermaid" | "dot" | "layout",
): Promise<number> {
  const projectPath = resolve(ctx.args.path === "." ? "." : ctx.args.path);

  const lint = await lintCommand({ path: ctx.args.path, format: "stylish", sandbox: ctx.args.sandbox });
  if (!lint.success) {
    console.error(
      formatError({
        message: "Refusing to emit graph: source has lint errors. Run `chant lint` and fix them first.",
      }),
    );
    return 1;
  }

  const graph = await computeComponentGraph(projectPath, ctx.args.sandbox);
  if (!graph.success) {
    console.error(formatError({ message: graph.error ?? "Failed to compute component graph" }));
    return 1;
  }

  // One node per component; wave index carried on the node so a renderer that
  // ignores groups can still lane by it. `dependsOn` is a plain name edge —
  // `kind: "ref"` matches the entity graph's edge vocabulary the emitters read.
  const waveOf = new Map<string, number>();
  graph.waves.forEach((wave, i) => wave.forEach((name) => waveOf.set(name, i + 1)));

  const ir: GraphIR = {
    nodes: graph.order.map((name) => ({
      id: name,
      kind: "Component",
      lexicon: "chant",
      attrs: { wave: waveOf.get(name) ?? null },
      // Deep-link the node to its `*.component.ts` (behold's inspect panel).
      ...(graph.files?.[name] ? { sourceLoc: { file: graph.files[name] } } : {}),
    })),
    edges: graph.edges.map(({ from, to }) => ({ from, to, kind: "ref" as const })),
    groups: {
      byWave: Object.fromEntries(graph.waves.map((wave, i) => [`wave-${i + 1}`, [...wave]])),
    },
  };

  return emitIr(ir, ctx, format);
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
  const lint = await lintCommand({ path: ctx.args.path, format: "stylish", sandbox: ctx.args.sandbox });
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
