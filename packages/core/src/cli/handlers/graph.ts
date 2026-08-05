import { resolve } from "node:path";
import { discoverOps } from "../../op/discover";
import { discover } from "../../discovery/index";
import { partitionByLexicon, computeStackGraph, build } from "../../build";
import { buildGraphIr, buildLiveGraphIr, collectUnobserved, overlayGraphs, sourceOverlayGraphs, type GraphIR, type IRPipeline, type LiveObservation } from "../../graph-ir";
import { buildDeclaredPerStack } from "../../graph-declared";
import { reconstructEdges, mergeCatalogs, containmentGroups, type ReferenceCatalog, type ContainmentPair } from "../../graph-refs";
import { observeResources } from "../../lifecycle/observe";
import { replaySnapshots, hasSnapshot } from "../../lifecycle/replay";
import { loadChantConfig, environmentNames, loadChantConfigUpward, type ChantConfig } from "../../config";
import { applyLiveEndpoint } from "../../live-endpoint";
import { applyDetail, detailInertNotice, type DetailLevel } from "../../graph-detail";
import { applyLens, parseLens } from "../../graph-lens";
import { toMermaid } from "../../graph-mermaid";
import { toDot } from "../../graph-dot";
import { getLayoutEngine, toLayoutInput, type NodeSize } from "../../graph-layout";
import { lintCommand } from "../commands/lint";
import { loadPlugins, resolveProjectLexicons } from "../plugins";
import { readFileSync } from "node:fs";
import { formatError, formatWarning, formatBold } from "../format";
import type { CommandContext } from "../registry";
import { computeComponentGraph, generateComponentsPipeline } from "../../components/cli-support";
import { resolveCliBuildParams, parseParamFlags } from "../build-params-cli";
import type { BuildParamProvenance } from "../../provenance";
import { discoverComponents } from "../../components/discover";
import { cfnDeployStacks } from "./components";


/**
 * Resolve this invocation's declared build-time parameters, the same way
 * `chant build` does, so `discover()` sees the values the source will read.
 *
 * Without this `chant graph` discovered source with `params.*` empty, so every
 * declaration conditioned on a parameter took its default — a project whose
 * tier is a `buildParams` entry graphed as one tier whatever `--param tier=`
 * or the declared `env:` mapping said, while `chant build` on the same source
 * and the same environment emitted a different resource set. Two commands
 * disagreeing about what the source says.
 *
 * Returns `undefined` when resolution failed, having printed why — the caller
 * should stop rather than graph something that will not build.
 */
async function graphBuildParams(
  ctx: CommandContext,
  projectPath: string,
): Promise<BuildParamProvenance[] | undefined> {
  const { config } = await loadChantConfigUpward(projectPath).catch(() => ({ config: {} as ChantConfig }));
  const resolution = resolveCliBuildParams(config.buildParams, {
    cli: parseParamFlags(ctx.args.param),
    paramsFile: ctx.args.paramsFile,
  });
  if (!resolution.success) {
    for (const message of resolution.errors) console.error(message);
    return undefined;
  }
  return resolution.provenance;
}

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
  // `--projection <lexicon>` (#989) only means anything for the component
  // graph's IR — it adds the CI/pipeline shape to `GraphIR.pipeline`, a field
  // the other view formats' emitters (mermaid/dot/layout) don't read, and the
  // plain (non-`--format`) `--components` text/`--json` modes don't build an
  // IR at all. Reject every other combination up front rather than silently
  // ignoring the flag.
  if (ctx.args.projection && !(ctx.args.components && ctx.args.format === "ir")) {
    console.error(formatError({
      message: "--projection needs --components --format ir — the CI/pipeline projection extends the component-graph IR, the only mode that carries it.",
    }));
    return 1;
  }
  // `--at` graphs a recorded observation instead of reading the estate (#1279).
  // Two different observations with no rule for which wins, so not both.
  if (ctx.args.at && ctx.args.live) {
    console.error(formatError({
      message: "chant graph takes --live or --at, not both",
      hint: "--live reads the estate now; --at graphs a recorded snapshot",
    }));
    return 1;
  }
  // `--live` graphs the provisioned (observed) infrastructure, not the declared
  // source (epic #776). It only makes sense as a view format; default to `ir`.
  if (ctx.args.live || ctx.args.at) {
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
  const declaredEnvNames = environmentNames(config.environments);
  if (declaredEnvNames && !declaredEnvNames.includes(environment)) {
    console.error(formatError({
      message: `Unknown environment "${environment}"`,
      hint: `Defined environments: ${declaredEnvNames.join(", ")}`,
    }));
    return 1;
  }

  // Build to get each lexicon's entity names + output (the scope
  // describeResources needs), mirroring `chant lifecycle snapshot`.
  //
  // With the same build params the source graph resolves (#1483). Without
  // them this build ran on defaults while the declared overlay below ran on
  // the caller's, so a project whose parameters choose *which resources
  // exist* — a tier, a size, a profile — observed one estate and compared it
  // against another. Every resource the real parameter declares read as
  // absent and every resource the default declares read as pending, which is
  // a confidently wrong overlay rather than an empty one.
  const liveBuildParams = await graphBuildParams(ctx, projectPath);
  if (!liveBuildParams) return 1;
  const buildResult = await build(
    resolve(args.src ?? config.sourceDir ?? "."),
    plugins.map((p) => p.serializer),
    undefined,
    { buildParams: liveBuildParams },
  );
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
  const stacks: Array<{ name: string; region?: string; src?: string }> = [];
  const seenStacks = new Set<string>();
  if (componentsDiscovery.errors.length === 0) {
    for (const { component } of componentsDiscovery.components.values()) {
      for (const stack of cfnDeployStacks(component.deploy)) {
        if (!seenStacks.has(stack)) { seenStacks.add(stack); stacks.push({ name: stack }); }
      }
    }
  } else {
      console.error(formatWarning({ message: "component discovery failed — observing the single-stack convention instead" }));
    }
    // ChantConfig.stacks (with optional per-stack region) — multi-region estates.
    for (const declared of config.stacks ?? []) {
      if (!seenStacks.has(declared.name)) { seenStacks.add(declared.name); stacks.push({ name: declared.name, region: declared.region, src: declared.src }); }
    }

    // #1166 — an environment can declare its own endpoint (a local emulator like
    // Floci), so this read is self-sufficient even when the ambient shell never
    // exported e.g. AWS_ENDPOINT_URL. Ambient always wins when it's already set.
    // Scoped to just this describe/enrich pass — restored in `finally` so it
    // never leaks into a later invocation in the same process.
    const endpointResult = applyLiveEndpoint(config.environments, environment, observing);
    if (endpointResult.notice) console.error(formatWarning({ message: endpointResult.notice }));

    let ir: GraphIR;
    let observations: LiveObservation[];
    // A replay is a graph of what was recorded, so it must not reach the provider
    // at all — not for observation and not for enrichment. Anything that quietly
    // called out would make `--at` a live read with an older label on it.
    const replaying = !!args.at && !args.live;
    try {
      if (replaying) {
        const scoped = new Set(stacks.filter((st) => st.src).map((st) => st.name));
        const replay = await replaySnapshots(environment, String(args.at), scoped);
        if ("error" in replay) {
          console.error(formatError({ message: replay.error, ...(replay.hint ? { hint: replay.hint } : {}) }));
          return 1;
        }
        observations = replay.observations;
        console.error(formatWarning({
          message: `graphing snapshot ${replay.commit.slice(0, 7)} taken ${replay.timestamp} — the estate was not read`,
        }));
      } else {
      const observeResult = await observeResources(environment, observing, buildResult, {
        owned: true,
        stacks: [...stacks],
      });
      observations = observeResult.observations;
      const { errors, warnings } = observeResult;
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
    }

    // Both paths land here: a replay rejoins the live pipeline at exactly this
    // point, which is what makes every fold and overlay below shared.
    ir = buildLiveGraphIr(observations);

    // The estate was asked for and nothing came back. Say that once, and say
    // that a recording exists — the per-entity warnings above describe the same
    // failure N times without ever naming the thing that would answer. Agents
    // denied the network read the empty graph as an empty estate and spent
    // their turns retrying `--live`.
    if (!replaying && ir.nodes.length === 0 && (await hasSnapshot(environment))) {
      console.error(formatWarning({
        message: `could not read the estate for "${environment}" — a snapshot of it is recorded; graph that instead with --at latest`,
      }));
    }

    // Enrich node attrs from the fuller live config (#784) so references are
    // present for edge reconstruction — describeResources metadata alone is often
    // too thin (e.g. AWS returns stack outputs, not per-resource references).
    // Live-only: enrichment is a provider call, so a replay must skip it.
    for (const p of replaying ? [] : observing) {
      if (!p.enrichLiveAttrs) continue;
      try {
        const enriched = await p.enrichLiveAttrs({ environment, owned: true, stacks });
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
  } finally {
    endpointResult.restore();
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
    // Declared nodes chant could not read are painted `neutral`, not
    // `accent`/pending (#1089) — a wrong-cluster or unsupported-kind read must
    // not draw the estate as "not deployed yet".
    const overlayOpts = { unobserved: collectUnobserved(observations) };
    // Multi-stack (#1162): the live `ir` keys nodes by `${stack}::${logicalId}`,
    // so the declared canvas must qualify identically — build each stack's src
    // scoped rather than a flat whole-project discovery (whose disambiguated
    // names never match the observed bare ids). Fall back to the flat build when
    // no stack carries a `src`.
    const scopedStacks = stacks.filter((s) => s.src);
    if (scopedStacks.length > 0) {
      const declaredIr = await buildDeclaredPerStack(scopedStacks, projectPath);
      ir =
        args.overlayAnchor === "live"
          ? overlayGraphs(ir, declaredIr, overlayOpts)
          : sourceOverlayGraphs(declaredIr, ir, overlayOpts);
    } else {
      const declaredParams = await graphBuildParams(ctx, projectPath);
      const declared = await discover(resolve(args.src ?? config.sourceDir ?? "."), {
        ...(declaredParams ? { buildParams: declaredParams } : {}),
      });
      if (declared.errors.length === 0) {
        const declaredIr = buildGraphIr(declared.entities, projectPath);
        ir =
          args.overlayAnchor === "live"
            ? overlayGraphs(ir, declaredIr, overlayOpts)
            : sourceOverlayGraphs(declaredIr, ir, overlayOpts);
      } else {
        console.error(formatWarning({ message: "overlay: source has discovery errors — showing the provisioned graph without the declared overlay" }));
      }
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
  {
    const base = ir;
    ir = applyDetail(ir, (args.detail ?? 2) as DetailLevel);
    // #1489 — a --detail 3 that changed nothing says so instead of silently
    // emitting the same bytes as --detail 2.
    if (args.detail === 3) {
      const notice = detailInertNotice(base, ir);
      if (notice) console.error(formatWarning({ message: notice }));
    }
  }

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
 * `--projection <lexicon>` (#989, `--format ir` only — validated in `runGraph`)
 * adds the **CI/pipeline projection** alongside this component graph:
 * `ir.pipeline` carries the stages/jobs/`needs` `<lexicon>`'s
 * `generateComponentPipeline` synthesizes for `chant build --components
 * --generate <lexicon>` (`generateComponentsPipeline`, ../../components/cli-support.ts)
 * — reused wholesale, not re-derived, so a consumer (e.g. behold, epic #492/
 * INTENTIUS/behold#54) gets the pipeline shape as first-class IR nodes/edges
 * instead of re-deriving it from `dependsOn` or parsing generated CI YAML.
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

  let ir: GraphIR = {
    nodes: graph.order.map((name) => ({
      id: name,
      kind: "Component",
      lexicon: "chant",
      // `liveNames` (#1491): the resources this component owns — declared, or
      // the contract's `[name]` identity fallback — so a consumer can join
      // the component DAG to the resource graph instead of guessing at kinds.
      attrs: { wave: waveOf.get(name) ?? null, liveNames: graph.liveNames?.[name] ?? [name] },
      // Deep-link the node to its `*.component.ts` (behold's inspect panel).
      ...(graph.files?.[name] ? { sourceLoc: { file: graph.files[name] } } : {}),
    })),
    edges: graph.edges.map(({ from, to }) => ({ from, to, kind: "ref" as const })),
    groups: {
      byWave: Object.fromEntries(graph.waves.map((wave, i) => [`wave-${i + 1}`, [...wave]])),
    },
  };

  if (ctx.args.projection) {
    const pipeline = await buildPipelineProjection(projectPath, ctx.args.projection, ctx.args.sandbox);
    if (!pipeline.success) {
      console.error(formatError({ message: pipeline.error ?? `Failed to generate ${ctx.args.projection} pipeline projection` }));
      return 1;
    }
    ir = { ...ir, pipeline: pipeline.pipeline };
  }

  return emitIr(ir, ctx, format);
}

/**
 * Reshape `generateComponentsPipeline`'s result (../../components/cli-support.ts
 * — the exact function `chant build --components --generate <lexicon>` calls)
 * into the IR's `IRPipeline` vocabulary (#989): one `IRPipelineNode` per
 * generated CI job, one `IRPipelineEdge` per `needs:` dependency (consumer job
 * → producer job, mirroring the component edges' consumer → producer
 * direction). Every shape decision — job naming, one stage per wave,
 * dependency resolution — stays owned by `lexicon`'s `generateComponentPipeline`;
 * this only relabels its `{ stages, jobs }` output as IR nodes/edges, it never
 * re-derives the graph.
 */
async function buildPipelineProjection(
  projectPath: string,
  lexicon: string,
  sandbox?: boolean,
): Promise<{ success: true; pipeline: IRPipeline } | { success: false; error?: string }> {
  const result = await generateComponentsPipeline(projectPath, lexicon, undefined, sandbox);
  if (!result.success) return { success: false, error: result.error };

  const jobs = result.jobs ?? [];
  return {
    success: true,
    pipeline: {
      provider: lexicon,
      stages: result.stages ?? [],
      nodes: jobs.map((j) => ({ id: j.jobName, kind: "CIJob" as const, component: j.component, stage: j.stage })),
      edges: jobs.flatMap((j) => j.needs.map((dep) => ({ from: j.jobName, to: dep, kind: "needs" as const }))),
    },
  };
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

  const buildParams = await graphBuildParams(ctx, projectPath);
  if (!buildParams) return 1;

  const result = await discover(projectPath, { buildParams });
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
  {
    const base = ir;
    ir = applyDetail(ir, level as DetailLevel);
    // #1489 — same say-so as the live path: an inert --detail 3 names itself.
    if (level === 3) {
      const notice = detailInertNotice(base, ir);
      if (notice) console.error(formatWarning({ message: notice }));
    }
  }
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
  const buildParams = await graphBuildParams(ctx, projectPath);
  if (!buildParams) return 1;
  const result = await discover(projectPath, { buildParams });
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
