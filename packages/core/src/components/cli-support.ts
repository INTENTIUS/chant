/**
 * CLI-facing helpers over component discovery (#560, epic #551) — kept
 * separate from ../cli/commands/{list,describe}.ts and
 * ../cli/handlers/graph.ts so those files stay thin dispatchers and the
 * component-specific report shaping lives alongside the rest of the
 * component subsystem, the same way ../op/discover.ts's results are shaped
 * inline by its own CLI callers rather than a `cli` folder inside `op/`.
 *
 * Surfaces components in the three places the issue asks for:
 *  - `chant list --components` — inventory (mirrors `ListEntity`/`listCommand`).
 *  - `chant describe <name> --components` — one component's full JSON contract
 *    projection (mirrors `describeCommand`'s effective-config view).
 *  - `chant graph --components` — dependency order/waves from `dependsOn`
 *    (mirrors `computeStackGraph`/`runStackGraph`, but reuses
 *    `resolveComponentGraph` from ../driver.ts since a component's `dependsOn`
 *    is already a flat name list — no AttrRef-style inference needed).
 *  - `chant build --components --generate gitlab` — generate mode (#563):
 *    synthesize CI YAML from the same discovered declarations instead of
 *    running them, via `generateGitlabPipeline` (../generate-gitlab.ts).
 *  - `chant run --components <name|all>` — interpret mode (#585): dispatch
 *    discovered component(s) through the interpret `driver.ts` on the local
 *    executor, the CLI entrypoint the driver (#556) never had.
 */

import { discoverComponents } from "./discover";
import { projectToJson, type Archetype } from "./component";
import {
  resolveComponentGraph,
  runInterpretDriver,
  runComponentDeploy,
  UnknownDependencyError,
  DependencyCycleError,
  DriverGateUnsupportedError,
  DriverRunFailure,
  type DriverComponent,
  type DriverPhase,
  type DriverRunResult,
} from "./driver";
import { generateGitlabPipeline, type GenerateGitlabOptions } from "./generate-gitlab";
import { buildCapabilityRegistry } from "./capability-plugin-loader";
import type { CapabilityRegistry } from "./capability";

/** One component in `chant list --components` output. */
export interface ListedComponent {
  name: string;
  archetype: Archetype;
  dependsOn: string[];
  hasBuild: boolean;
  phases: string[];
  filePath: string;
}

export interface ListComponentsResult {
  success: boolean;
  components: ListedComponent[];
  errors: string[];
}

/** Discover components under `path` and shape them for `chant list --components`. */
export async function listComponents(path: string): Promise<ListComponentsResult> {
  const result = await discoverComponents(path);
  if (result.errors.length > 0) {
    return { success: false, components: [], errors: result.errors.map((e) => e.message) };
  }

  const components: ListedComponent[] = [...result.components.values()]
    .map(({ component, filePath }) => {
      const projected = projectToJson(component) as { archetype: Archetype };
      return {
        name: component.name,
        archetype: projected.archetype,
        dependsOn: component.dependsOn,
        hasBuild: component.build !== undefined,
        phases: component.deploy.map((p) => p.phase),
        filePath,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return { success: true, components, errors: [] };
}

/** One component's full JSON contract projection, for `chant describe <name> --components`. */
export interface DescribedComponent {
  name: string;
  filePath: string;
  /** The component's JSON contract projection (validates against component.schema.json). */
  json: unknown;
}

export interface DescribeComponentResult {
  success: boolean;
  component: string;
  described?: DescribedComponent;
  output: string;
}

/** Find and project one named component, for `chant describe <name> --components`. */
export async function describeComponent(path: string, name: string): Promise<DescribeComponentResult> {
  const result = await discoverComponents(path);
  if (result.errors.length > 0) {
    return { success: false, component: name, output: result.errors.map((e) => e.message).join("\n") };
  }

  const found = result.components.get(name);
  if (!found) {
    const known = [...result.components.keys()].sort().join(", ");
    return {
      success: false,
      component: name,
      output: `No component "${name}" found.\nKnown components: ${known || "(none)"}`,
    };
  }

  const json = projectToJson(found.component);
  return {
    success: true,
    component: name,
    described: { name, filePath: found.filePath, json },
    output: "",
  };
}

/** Dependency order/waves for `chant graph --components`, from every discovered component's `dependsOn`. */
export interface ComponentGraphResult {
  success: boolean;
  order: string[];
  waves: string[][];
  edges: Array<{ from: string; to: string }>;
  error?: string;
}

/** Compute the components' dependency graph under `path`, for `chant graph --components`. */
export async function computeComponentGraph(path: string): Promise<ComponentGraphResult> {
  const result = await discoverComponents(path);
  if (result.errors.length > 0) {
    return { success: false, order: [], waves: [], edges: [], error: result.errors.map((e) => e.message).join("\n") };
  }

  const driverComponents: DriverComponent[] = [...result.components.values()].map(({ component }) => ({
    name: component.name,
    dependsOn: component.dependsOn,
    deploy: component.deploy,
  }));

  try {
    const { order, waves } = resolveComponentGraph(driverComponents);
    const edges: Array<{ from: string; to: string }> = [];
    for (const c of driverComponents) {
      for (const dep of c.dependsOn ?? []) edges.push({ from: c.name, to: dep });
    }
    return { success: true, order, waves, edges };
  } catch (err) {
    if (err instanceof UnknownDependencyError || err instanceof DependencyCycleError) {
      return { success: false, order: [], waves: [], edges: [], error: err.message };
    }
    throw err;
  }
}

/** Supported generate-mode target lexicons. GitLab is the only implemented target for v1 (#563) — one lexicon is enough per the epic's phasing. */
export type GenerateLexicon = "gitlab";

/** Result of `chant build --components --generate <lexicon>`. */
export interface GenerateComponentsResult {
  success: boolean;
  /** The synthesized CI YAML, when `success` is true. */
  yaml?: string;
  /** Wave-ordered stage names (GitLab: one `stages:` entry per wave). */
  stages?: string[];
  /** Every generated job, for a machine-readable view (`--format json`). */
  jobs?: Array<{ jobName: string; component: string; stage: string; needs: string[] }>;
  error?: string;
}

/**
 * Generate mode (#563): discover every `Component` under `path` and
 * synthesize a thin CI pipeline for `lexicon` that triggers each component's
 * own composition in dependency order/waves — the same `resolveComponentGraph`
 * order `chant graph --components`/the interpret driver use. No deploy logic
 * is inlined into the generated YAML; a cross-cutting change goes through
 * `options` (see `generateGitlabPipeline`'s docstring), never per component.
 */
export async function generateComponentsPipeline(
  path: string,
  lexicon: GenerateLexicon,
  options?: GenerateGitlabOptions,
): Promise<GenerateComponentsResult> {
  const result = await discoverComponents(path);
  if (result.errors.length > 0) {
    return { success: false, error: result.errors.map((e) => e.message).join("\n") };
  }

  const driverComponents: DriverComponent[] = [...result.components.values()].map(({ component }) => ({
    name: component.name,
    dependsOn: component.dependsOn,
    deploy: component.deploy,
  }));

  try {
    switch (lexicon) {
      case "gitlab": {
        const { yaml, stages, jobs } = generateGitlabPipeline(driverComponents, options);
        return { success: true, yaml, stages, jobs };
      }
      default: {
        const exhaustive: never = lexicon;
        return { success: false, error: `Unsupported generate-mode lexicon "${exhaustive as string}". Supported: gitlab.` };
      }
    }
  } catch (err) {
    if (err instanceof UnknownDependencyError || err instanceof DependencyCycleError) {
      return { success: false, error: err.message };
    }
    throw err;
  }
}

// ── Interpret mode: `chant run --components <name|all>` (#585) ──────────────

/** Convert a discovered `Component` to the driver's leaner `DriverComponent` shape (name/dependsOn/deploy/rollback — the only fields the driver reads). */
function toDriverComponent(component: { name: string; dependsOn: string[]; deploy: DriverPhase[]; rollback?: DriverPhase[] }): DriverComponent {
  return {
    name: component.name,
    dependsOn: component.dependsOn,
    deploy: component.deploy,
    ...(component.rollback ? { rollback: component.rollback } : {}),
  };
}

/**
 * Find the first `gate` step anywhere in a component's `deploy`/`rollback`
 * composition (including nested fan-out phases), mirroring
 * `../op/local-executor.ts`'s `findGate`. Used as a pre-flight check so
 * `chant run --components` fails before any step runs — matching
 * `runOpLocal`'s behavior for Ops — rather than only failing mid-run when the
 * driver itself reaches the gated phase (`DriverGateUnsupportedError`).
 */
export function findComponentGate(component: DriverComponent): { signalName: string } | undefined {
  const search = (phases: DriverPhase[] | undefined): { signalName: string } | undefined => {
    for (const phaseDef of phases ?? []) {
      for (const entry of phaseDef.steps) {
        if ((entry as { kind?: unknown }).kind === "gate") {
          return entry as unknown as { signalName: string };
        }
        if (typeof (entry as DriverPhase).phase === "string" && Array.isArray((entry as DriverPhase).steps)) {
          const nested = search([entry as DriverPhase]);
          if (nested) return nested;
        }
      }
      const fromOnFailure = search(phaseDef.onFailure);
      if (fromOnFailure) return fromOnFailure;
    }
    return undefined;
  };
  return search(component.deploy) ?? search(component.rollback);
}

/** Options for `runComponents` (backs `chant run --components <name|all> [--env <env>]`). */
export interface RunComponentsOptions {
  /** Target environment name, threaded into every capability's `DeployContext.env` (default: "local"). */
  env?: string;
  /** Additional capability plugin package names to load on top of the built-in starter set (see `buildCapabilityRegistry`). */
  capabilityPlugins?: string[];
  /**
   * Pre-built registry to dispatch through, bypassing `buildCapabilityRegistry`
   * entirely. Real callers (the CLI handler) should leave this unset; it exists
   * so tests can inject a registry wired to a `MockCloudExecutor` (mirroring
   * `../components/pilots/pilots-e2e.test.ts`'s `buildRegistry`) instead of the
   * default starter set, whose non-pilot verbs are still typed stubs that throw
   * `CapabilityNotImplementedError` (see `./verbs/stub.ts`).
   */
  registry?: CapabilityRegistry;
}

/** Result of `chant run --components <name|all>`. */
export interface RunComponentsResult {
  success: boolean;
  /** The driver's run result, when the run reached the driver (even on a failed component). */
  run?: DriverRunResult;
  /** Component names actually dispatched to the driver, in run order. */
  selected: string[];
  error?: string;
  /** Set when a selected component (or one of its `deploy`/`rollback` phases) contains a `gate` the local executor cannot run. */
  gateUnsupported?: { component: string; signalName: string };
}

/**
 * Run one named component, or every discovered component (`selector ===
 * "all"`), through the interpret driver (`../components/driver.ts`) on the
 * local in-process executor — the CLI entrypoint the driver never had (#585,
 * follow-up to #556). Discovers the full component set first, then either:
 *  - `selector === "all"`: resolves the whole set's dependency order/waves
 *    and dispatches every component through `runInterpretDriver`, matching
 *    what the generated orchestrator Op will eventually do — the same
 *    order `chant graph --components` reports.
 *  - a single name: dispatches just that component via `runComponentDeploy`,
 *    without requiring the rest of its `dependsOn` graph to be present in
 *    this invocation. This mirrors generate mode's per-job invocation model
 *    (`generate-gitlab.ts`) — each CI job triggers exactly one component, and
 *    cross-job/cross-wave ordering is the CI DAG's (`needs:`) job, not this
 *    command's; requiring the full graph here would make `chant run
 *    --components <name>` fail for any component whose `dependsOn` names
 *    infra outside the discovered set (e.g. a shared stack, per the
 *    `search-service` pilot), which is exactly the common case.
 *
 * Pre-flights every selected component for a `gate` step and fails before any
 * step runs (`gateUnsupported`), matching `runOpLocal`'s pre-flight
 * `findGate` check for Ops — gated components need a durable (Temporal)
 * backend, which is out of scope here (issue #585 scopes Temporal-backed
 * component execution to what already exists for Ops; the epic tracks
 * graduating a gated component to `--temporal` separately).
 */
export async function runComponents(
  path: string,
  selector: string,
  options: RunComponentsOptions = {},
): Promise<RunComponentsResult> {
  const result = await discoverComponents(path);
  if (result.errors.length > 0) {
    return { success: false, selected: [], error: result.errors.map((e) => e.message).join("\n") };
  }

  const all = [...result.components.values()].map(({ component }) => toDriverComponent(component));

  let targets: DriverComponent[];
  if (selector === "all") {
    targets = all;
  } else {
    const found = all.find((c) => c.name === selector);
    if (!found) {
      const known = all.map((c) => c.name).sort().join(", ");
      return {
        success: false,
        selected: [],
        error: `Component "${selector}" not found.${known ? ` Known components: ${known}` : " No components discovered."}`,
      };
    }
    targets = [found];
  }

  for (const component of targets) {
    const gate = findComponentGate(component);
    if (gate) {
      return {
        success: false,
        selected: targets.map((c) => c.name),
        gateUnsupported: { component: component.name, signalName: gate.signalName },
      };
    }
  }

  const registry: CapabilityRegistry =
    options.registry ?? (await buildCapabilityRegistry({ plugins: options.capabilityPlugins }));
  const env = options.env ?? "local";
  const selected = targets.map((c) => c.name);

  try {
    if (selector === "all") {
      const run = await runInterpretDriver(targets, registry, { env });
      return { success: true, run, selected };
    }

    // Single-component invocation: run just this component, bypassing
    // whole-graph `dependsOn` resolution (see docstring above).
    const componentResult = await runComponentDeploy(targets[0], { env, component: targets[0].name }, registry, {});
    const run: DriverRunResult = {
      order: selected,
      waves: [selected],
      results: [componentResult],
      ok: componentResult.ok,
      failedComponent: componentResult.ok ? undefined : componentResult.component,
    };
    return { success: componentResult.ok, run, selected };
  } catch (err) {
    if (err instanceof DriverRunFailure) {
      return { success: false, run: err.result, selected, error: err.message };
    }
    if (err instanceof DriverGateUnsupportedError) {
      return {
        success: false,
        selected,
        gateUnsupported: { component: err.component, signalName: err.signalName },
      };
    }
    if (err instanceof UnknownDependencyError || err instanceof DependencyCycleError) {
      return { success: false, selected, error: err.message };
    }
    throw err;
  }
}
