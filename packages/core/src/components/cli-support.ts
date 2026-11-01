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

import { UnknownCanaryError } from "../gated-waves";
import { lexiconModulePath, lexiconNames, importLexiconPackage } from "../lexicon-module";
import { discoverComponents } from "./discover";
import type { BuildParamProvenance } from "../provenance";
import { inferArchetype, projectToJson, type Archetype, type ComponentEnvironmentDeclaration } from "./component";
import {
  deployContext,
  resolveComponentGraph,
  runInterpretDriver,
  runComponentDeploy,
  UnknownDependencyError,
  DependencyCycleError,
  DriverRunFailure,
  type DriverComponent,
  type DriverGate,
  type DriverPhase,
  type DriverRunResult,
  type InterpretGroups,
} from "./driver";
import type { PendingGateRecord } from "../lifecycle/gate-ledger";
import type { GateDigestMismatch, GateLedgerPort } from "../op/gate";
import { gateName } from "../op/gate-name";
import { isLexiconPlugin, type LexiconPlugin, type ComponentPipelineOptions } from "../lexicon";
import type { RunProgressEvent } from "./run-progress";
import { joinRunEventSinks, progressSinkOf, type RunEventSink } from "../run-event-stream";
import { dirname, relative } from "node:path";
import { existsSync, statSync } from "node:fs";
import { getHeadCommit } from "../lifecycle/git";
import { buildCapabilityRegistry } from "./capability-plugin-loader";
import type { CapabilityRegistry } from "./capability";
import type { DeployAdoption } from "./adoption";
import type { LockGrain } from "../lifecycle/lock-rows";
import type { RowLeasePort } from "./row-lease";
import type { FanOutPlan } from "./fan-out";
import { componentSetFanOut, formRunGroups, planAndRunComponentGroup } from "./groups";
import { applyConfigDefaults } from "./config-defaults";
import { withDeclaredReads } from "./declared-reads";
import { loadChantConfig, type ChantConfig } from "../config";

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
export async function listComponents(path: string, sandbox?: boolean): Promise<ListComponentsResult> {
  const result = await discoverComponents(path, { sandbox });
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
export async function describeComponent(path: string, name: string, sandbox?: boolean): Promise<DescribeComponentResult> {
  const result = await discoverComponents(path, { sandbox });
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
  /** Component name → its declaring `*.component.ts` file (relative to `path`),
   * so a renderer can deep-link a component node to source (`chant graph
   * --components --format ir` sets `sourceLoc` from this). */
  files?: Record<string, string>;
  /** Component name → the live resource names it owns (#1491): the declared
   * `liveNames`, or `[name]` when undeclared — the identity-join fallback the
   * `Component` contract already specifies. This is what lets a consumer join
   * the component DAG to the resource graph without guessing at kinds. */
  liveNames?: Record<string, string[]>;
  /** Component name → the composite kind name(s) its resources come from (#1492),
   * present only for components that declared `composites` explicitly. Unlike
   * `liveNames`, there is no identity fallback — a component's own name is not
   * a composite kind — so an undeclared component is left out of this map
   * entirely rather than defaulting to a guess; a consumer with no entry here
   * keeps applying its own naming-convention default. */
  composites?: Record<string, string[]>;
  /** Component name → its archetype, declared or inferred from the composition
   * (`inferArchetype`), so a reader can label a component without its source
   * (#2662). */
  archetypes?: Record<string, Archetype>;
  /** Component name → the environments it declares (#3153), present only for components that declared them. */
  environments?: Record<string, ComponentEnvironmentDeclaration[]>;
  error?: string;
}

/** Compute the components' dependency graph under `path`, for `chant graph --components`. */
export async function computeComponentGraph(
  path: string,
  sandbox?: boolean,
  buildParams?: BuildParamProvenance[],
): Promise<ComponentGraphResult> {
  // #1490 — without this the component graph is always the DEFAULT-parameter
  // graph. `discoverComponents` has honoured `buildParams` since #1108; every
  // caller simply stopped short of passing them, so `--param backups=omit`
  // dropped the CronJob from `chant build` and left the component that
  // describes it in `chant graph --components`. Two commands disagreeing about
  // what the source says, which is the thing #1064 and #1108 each fixed one
  // layer of.
  const result = await discoverComponents(path, { sandbox, buildParams });
  if (result.errors.length > 0) {
    return { success: false, order: [], waves: [], edges: [], error: result.errors.map((e) => e.message).join("\n") };
  }

  const driverComponents: DriverComponent[] = [...result.components.values()].map(({ component }) => ({
    name: component.name,
    dependsOn: component.dependsOn,
    deploy: component.deploy,
  }));

  // component name → its declaring file, relative to `path`, for node deep-links.
  const files: Record<string, string> = {};
  // component name → owned live resource names (#1491), declared or the
  // contract's identity fallback.
  const liveNames: Record<string, string[]> = {};
  // component name → declared composite kind(s) (#1492), only for components
  // that declared them — no identity fallback (see ComponentGraphResult doc).
  const composites: Record<string, string[]> = {};
  const archetypes: Record<string, Archetype> = {};
  const environments: Record<string, ComponentEnvironmentDeclaration[]> = {};
  for (const [name, discovered] of result.components) {
    const declaredEnvironments = discovered.component.environments;
    if (declaredEnvironments && declaredEnvironments.length > 0) environments[name] = declaredEnvironments.map((e) => ({ ...e }));
    archetypes[name] = discovered.component.archetype ?? inferArchetype(discovered.component);
    files[name] = relative(path, discovered.filePath);
    const declared = discovered.component.liveNames;
    liveNames[name] = declared && declared.length > 0 ? [...declared] : [name];
    const declaredComposites = discovered.component.composites;
    if (declaredComposites && declaredComposites.length > 0) composites[name] = [...declaredComposites];
  }

  try {
    const { order, waves } = resolveComponentGraph(driverComponents);
    const edges: Array<{ from: string; to: string }> = [];
    for (const c of driverComponents) {
      for (const dep of c.dependsOn ?? []) edges.push({ from: c.name, to: dep });
    }
    return { success: true, order, waves, edges, files, liveNames, composites, archetypes, environments };
  } catch (err) {
    if (err instanceof UnknownDependencyError || err instanceof DependencyCycleError) {
      return { success: false, order: [], waves: [], edges: [], error: err.message };
    }
    throw err;
  }
}

/** A generate-mode target lexicon name — any lexicon whose plugin implements `generateComponentPipeline` (gitlab, github, and forgejo today). */
export type GenerateLexicon = string;

/**
 * The components an "all" run takes, in `discovered` order (chant #1522). A
 * seam-gated component (`enabled: false`, computed from this run's own
 * params) sits out: the run deploys the estate the parameters describe, not
 * the units the seams turned off. A disabled dependency is satisfied
 * vacuously, since ordering is dependsOn's only meaning, so it is also
 * stripped from the survivors' dependsOn rather than failing wave resolution
 * as an unknown name. `chant run --components all`, a component list's
 * dependency closure (#3950) and the generated pipelines (#3951) all select
 * through this.
 */
export function withoutDisabled<T extends { name: string; dependsOn?: string[] }>(
  discovered: ReadonlyArray<{ name: string; enabled?: boolean }>,
  components: T[],
): T[] {
  const disabled = new Set(discovered.filter((c) => c.enabled === false).map((c) => c.name));
  if (disabled.size === 0) return components;
  return components
    .filter((c) => !disabled.has(c.name))
    .map((c) => (c.dependsOn?.some((d) => disabled.has(d)) ? { ...c, dependsOn: c.dependsOn.filter((d) => !disabled.has(d)) } : c));
}

/** Result of `chant build --components --generate <lexicon>`. */
export interface GenerateComponentsResult {
  success: boolean;
  /** The synthesized CI YAML, when `success` is true. */
  yaml?: string;
  /** Wave-ordered stage names (one entry per wave). */
  stages?: string[];
  /** Every generated job, for a machine-readable view (`--format json`). */
  jobs?: Array<{ jobName: string; component: string; stage: string; needs: string[] }>;
  /** The environment the pipeline deploys — the generator's own resolution (`ComponentPipelineResult.env`, #2046). */
  env?: string;
  error?: string;
  /** This invocation's resolved build-time parameters (chant #1108) — the generate-mode counterpart of `../cli/commands/build.ts`'s `BuildResult.buildParams`. Empty when the project declares/supplies none. */
  buildParams?: BuildParamProvenance[];
}

/**
 * Load a lexicon's plugin (`@intentius/chant-lexicon-<name>`) to reach its
 * `generateComponentPipeline`. Tolerant: returns null when the package can't be
 * resolved. Mirrors the lexicon-borne loading the capability + upstream-pin
 * seams use, kept here so `components` doesn't depend on the `cli` plugin loader.
 */
async function loadLexiconPlugin(name: string): Promise<LexiconPlugin | null> {
  let mod: Record<string, unknown>;
  try {
    mod = (await importLexiconPackage(lexiconModulePath(name) ?? `@intentius/chant-lexicon-${name}`)) as Record<string, unknown>;
  } catch {
    return null;
  }
  for (const value of Object.values(mod)) {
    if (isLexiconPlugin(value)) return value;
  }
  return null;
}

/**
 * Generate mode (#563): discover every `Component` under `path` and
 * synthesize a thin CI pipeline for `lexicon` that triggers each component's
 * own composition in dependency order/waves — the same `resolveComponentGraph`
 * order `chant graph --components`/the interpret driver use. No deploy logic
 * is inlined into the generated YAML; a cross-cutting change goes through
 * `options`, never per component. The CI-specific synthesis is contributed by
 * the target lexicon's `generateComponentPipeline` (#688); core owns only the
 * generic discovery + graph.
 */
export async function generateComponentsPipeline(
  path: string,
  lexicon: GenerateLexicon,
  options?: ComponentPipelineOptions,
  sandbox?: boolean,
  /**
   * chant #1108 — this invocation's resolved build-time parameter values
   * (../cli/handlers/build.ts resolves them, the same sequence `chant build`
   * runs, BEFORE calling this function), forwarded into discovery so a
   * `params.<name>` reference inside a discovered `*.component.ts` file
   * resolves instead of reading `{}`. See `discoverComponents`'s
   * `buildParams` option (./discover.ts) for the full doc.
   */
  buildParams?: BuildParamProvenance[],
): Promise<GenerateComponentsResult> {
  const plugin = await loadLexiconPlugin(lexicon);
  if (!plugin?.generateComponentPipeline) {
    return {
      success: false,
      error: `Lexicon "${lexicon}" does not support generate mode (no generateComponentPipeline). GitLab, GitHub, and Forgejo are supported today.`,
    };
  }

  const result = await discoverComponents(path, { sandbox, buildParams });
  if (result.errors.length > 0) {
    return { success: false, error: result.errors.map((e) => e.message).join("\n") };
  }

  // #3951: the pipeline holds the jobs `chant run --components all` would
  // run, so a disabled component has no job and no other job needs it.
  const discovered = [...result.components.values()].map(({ component }) => component);
  const driverComponents = withoutDisabled(
    discovered,
    discovered.map((component) => ({ name: component.name, dependsOn: component.dependsOn, deploy: component.deploy })),
  );

  try {
    const { yaml, stages, jobs, env } = plugin.generateComponentPipeline(driverComponents, options);
    return { success: true, yaml, stages, jobs, ...(env ? { env } : {}), buildParams };
  } catch (err) {
    if (err instanceof UnknownDependencyError || err instanceof DependencyCycleError || err instanceof UnknownCanaryError) {
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
 * composition (including nested fan-out phases).
 *
 * A declaration-time question, not a pre-flight refusal: since #2119 the
 * driver decides a gate against the ledger when it reaches one, so nothing
 * needs to know up front that a component has one.
 *
 * The name comes back on `gate` whichever key the component spelled it with,
 * so a caller never has to know about the deprecated `signalName` (#2202).
 */
export function findComponentGate(component: DriverComponent): { gate: string } | undefined {
  const search = (phases: DriverPhase[] | undefined): { gate: string } | undefined => {
    for (const phaseDef of phases ?? []) {
      for (const entry of phaseDef.steps) {
        if ((entry as { kind?: unknown }).kind === "gate") {
          return { gate: gateName(entry as DriverGate) };
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
  /** `ci.lockGrain` as declared (#4594), for every step's `DeployContext.lockGrain`. Absent: each step takes its lexicon's default. */
  lockGrain?: LockGrain;
  /** The run's row lease (#4594): a step or group on the resource grain leases its rows through it before it applies. Absent: no lease. */
  rowLease?: RowLeasePort;
  /**
   * The addresses each component's steps narrow to (#4300), by component
   * (`--target <component>:<address>`). A name the run does not run refuses
   * the run before anything starts.
   */
  targets?: Readonly<Record<string, readonly string[]>>;
  /**
   * `--adopt <adoption-file>` (#4537): adopt the file's resources into the
   * one component this run names, through its deploy step's
   * `DeployContext.adoption`. Refused with `all` or a list.
   */
  adoption?: DeployAdoption;
  /**
   * chant #1051 — opt-in: discover `*.component.ts` files in a sandboxed
   * child process (`chant run --components <name|all> --sandbox`) instead of
   * in the CLI's own process. See `discoverComponents`'s `sandbox` option
   * (../discover.ts).
   */
  sandbox?: boolean;
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
  /**
   * Pre-loaded project config to resolve `sbom`/`signing`/`vulnPolicy`
   * defaults from (#629), bypassing `loadChantConfig` entirely. Real callers
   * (the CLI handler) should leave this unset — `runComponents` loads
   * `chant.config.ts`/`chant.config.json` from `path` itself; this exists so
   * tests can inject a config object directly, the same escape hatch
   * `registry` above provides for the capability registry.
   */
  config?: ChantConfig;
  /**
   * Cross-component/cross-stack outputs to seed the run with — keyed by
   * component name, the same shape `DriverRunResult.componentOutputs` produces.
   * The CLI populates this from `--seed-outputs` files (an upstream CI job's
   * dumped outputs), so a single-component run in a downstream job can resolve
   * `stackOutput()`/`@<name>.publish.*` references to a component that already
   * ran elsewhere. Merged with, and overridden by, outputs this run produces.
   */
  componentOutputs?: Record<string, Record<string, unknown>>;
  /**
   * Opt-in structured progress observer (`chant run --components <name|all>
   * --progress-json`, see ./run-progress.ts). Threaded straight through to
   * `runInterpretDriver` for `"all"` and a list; for a single-component
   * selector (which bypasses `runInterpretDriver` — see the docstring above),
   * this function emits the same `run-start`/`wave-start`/`component-start`/
   * …/`run-done` envelope itself, treating the one component as a run with a
   * single wave, so `--progress-json` produces a well-formed event stream
   * regardless of selector. Left `undefined` by every caller that didn't pass
   * `--progress-json`, in which case nothing changes.
   */
  onProgress?: (event: RunProgressEvent) => void;
  /**
   * Where the run's events go (#4041, `--events-json`): run-event bodies,
   * with the same single-wave framing for a single component as `onProgress`.
   */
  onRunEvent?: RunEventSink;
  /**
   * chant #1108 — this run's resolved build-time parameter values, resolved
   * the exact same way `chant build` resolves them
   * (../cli/build-params-cli.ts's `resolveCliBuildParams`, driven by
   * `--param`/`--params-file`/a declared `env` mapping/`chant.config.ts`'s
   * `buildParams` defaults). The CLI handler (../cli/handlers/run.ts)
   * resolves + logs these BEFORE calling `runComponents`, the same
   * sequencing `chant build` uses — this function only forwards the
   * already-resolved values into discovery (`resolveComponentTargets` below,
   * then `discoverComponents`); it does not resolve them itself, so
   * `runComponents` stays free of CLI-flag-parsing/formatting concerns.
   * Default: none — `params.*` stays `{}`, matching every caller (including
   * every test in `cli-support.test.ts`) that doesn't supply this.
   */
  buildParams?: BuildParamProvenance[];
  /** Where a `gate` step's facts are read and written (#2119). Defaults to the `chant/lifecycle` orphan branch; a test passes `memoryGateLedgerPort()` from `../op/gate.ts`. */
  gates?: GateLedgerPort;
  /**
   * Called once for a list selector (`a,b,c`, #3950) with the resolved run
   * order, waves and the dependencies the list pulled in, after selection and
   * before the first component runs. The CLI prints it.
   */
  onPlan?: (plan: ComponentRunPlan) => void;
  /**
   * The commit the run deploys, for the workloads' `vcs.ref.head.revision`
   * (#3061). Default: `git rev-parse HEAD` in the project, or nothing outside
   * a checkout. `null` passes none.
   */
  revision?: string | null;
  /**
   * Rewrites the selected compositions before anything runs, or refuses the
   * run (#4694): `chant run --components --release` takes out the build steps
   * of a component the release recorded an artifact for and hands its
   * `release-image` steps the image (./release-run.ts). Called once, with the
   * components in run order, after their config defaults are applied.
   */
  prepare?: (components: DriverComponent[]) => Promise<{ components: DriverComponent[] } | { error: string }>;
}

/** The resolved order of a list run (#3950), reported through `RunComponentsOptions.onPlan`. */
export interface ComponentRunPlan {
  order: string[];
  waves: string[][];
  /** Dependencies the list did not name but the run includes. */
  added: string[];
}

/** Result of `chant run --components <name|all|a,b,c>`. */
export interface RunComponentsResult {
  success: boolean;
  /** The driver's run result, when the run reached the driver (even on a failed component). */
  run?: DriverRunResult;
  /** Component names actually dispatched to the driver, in run order. */
  selected: string[];
  /** The components dispatched, as they ran (#4274): what a component's deploy-input digest is taken over. */
  components?: DriverComponent[];
  error?: string;
  /** Set when the run stopped at a `gate` nobody has approved (#2119): the component it stopped at and the pending fact recorded for it. */
  gated?: {
    component: string;
    gate: PendingGateRecord;
    /** Whether this run's own append reached the remote (#2310); absent when the pending fact was already standing. */
    pushed?: boolean;
    pushWarning?: string;
    /** Set when an approval stands for this gate, but for another plan or none (#2574). */
    mismatch?: GateDigestMismatch;
  };
  /** This run's resolved build-time parameters (chant #1108) — the component-driver counterpart of `../cli/commands/build.ts`'s `BuildResult.buildParams`. Present only once the run actually reached dispatch (mirrors `BuildResult.buildParams`, which is likewise absent on an early-error return). */
  buildParams?: BuildParamProvenance[];
  /** The grouped fan-out the run applied (ws-107, #4465), when a group formed or a component fell back from one. */
  grouped?: FanOutPlan;
}

/**
 * Run one named component, or every discovered component (`selector ===
 * "all"`), through the interpret driver (`../components/driver.ts`) on the
 * local in-process executor — the CLI entrypoint the driver never had (#585,
 * follow-up to #556). Discovers the full component set first, then either:
 *  - `selector === "all"`: resolves the whole set's dependency order/waves
 *    and dispatches every component through `runInterpretDriver`, in the same
 *    order `chant graph --components` reports.
 *  - a list (`a,b,c`, #3950): the named components plus everything they
 *    depend on, through the same `runInterpretDriver` path as `"all"`, so the
 *    subset runs in the order `"all"` would give it, in one process. The
 *    resolved order goes to `onPlan` before the first component starts.
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
 * A `gate` no longer refuses the run up front (#2119). The driver decides each
 * one against the gate ledger as it reaches it; a gate nobody has approved
 * stops the run there with `gated` set, which the CLI turns into exit code 3
 * and the `chant approve` line.
 */
/** Result of resolving a `<name|all|a,b,c>` selector against discovered components. */
export interface ResolvedComponentTargets {
  success: boolean;
  targets: DriverComponent[];
  /** For a list selector (#3950): the dependencies the closure added that the list did not name, in discovery order. */
  added?: string[];
  /**
   * For a list selector: the names the list gave, and every enabled component
   * the closure was taken over (#4516). `runComponents` takes the closure again
   * once the declared reads are written in, so a listed importer pulls in the
   * component whose export it reads.
   */
  list?: { named: string[]; enabled: DriverComponent[] };
  /** Component name to the environments it declares (#3153), for the components that declare any (#4330). */
  sites?: Record<string, ComponentEnvironmentDeclaration[]>;
  error?: string;
}

/** Whether `selector` is a comma-separated component list (#3950), as opposed to `all` or one name. */
export function isComponentList(selector: string): boolean {
  return selector.includes(",");
}

/**
 * Discover every component under `path` and resolve `selector` (`"all"`, a
 * single component name, or a comma-separated list, #3950) to the
 * `DriverComponent`(s) to run, with no gate check and no dispatch — just discovery + selection, factored out of
 * `runComponents` so another entrypoint can reuse the exact same selection
 * semantics without inheriting the run itself.
 */
export async function resolveComponentTargets(
  path: string,
  selector: string,
  sandbox?: boolean,
  /** chant #1108 — this invocation's resolved build-time parameter values, forwarded into `discoverComponents` so a `params.<name>` reference inside a discovered `*.component.ts` file resolves instead of reading `{}`. See `discoverComponents`'s `buildParams` option (./discover.ts). */
  buildParams?: BuildParamProvenance[],
): Promise<ResolvedComponentTargets> {
  const result = await discoverComponents(path, { sandbox, buildParams });
  if (result.errors.length > 0) {
    return { success: false, targets: [], error: result.errors.map((e) => e.message).join("\n") };
  }

  const discovered = [...result.components.values()].map(({ component }) => component);
  const all = discovered.map((component) => toDriverComponent(component));

  if (isComponentList(selector)) return resolveComponentList(selector, discovered, all);

  if (selector === "all") {
    const sites = Object.fromEntries(discovered.filter((c) => c.environments && c.environments.length > 0).map((c) => [c.name, c.environments!.map((e) => ({ ...e }))]));
    return { success: true, targets: withoutDisabled(discovered, all), ...(Object.keys(sites).length > 0 ? { sites } : {}) };
  }

  const found = all.find((c) => c.name === selector);
  const disabledByName = discovered.find((c) => c.name === selector && c.enabled === false);
  if (disabledByName) {
    // An explicit ask for a unit the parameters excluded is a mistake to
    // surface, not to skip silently.
    return {
      success: false,
      targets: [],
      error: `Component "${selector}" is disabled under this run's parameters (enabled: false) — enable the seam it is gated on, or run without naming it.`,
    };
  }
  if (!found) {
    const known = all.map((c) => c.name).sort().join(", ");
    return {
      success: false,
      targets: [],
      error: `Component "${selector}" not found.${known ? ` Known components: ${known}` : " No components discovered."}`,
    };
  }
  return { success: true, targets: [found] };
}

/**
 * A list selector (`a,b,c`, #3950): the named components plus every component
 * they depend on, transitively, so the list runs as one dependency-ordered
 * set. Refused before anything runs when a name is unknown, disabled, or `all`
 * (which already means every component). Dependencies are followed through
 * `withoutDisabled`, the selection `"all"` uses, so a disabled *dependency*
 * is dropped and stripped from dependsOn exactly as `"all"` drops it. A
 * dependsOn name that matches no discovered component is left in place, so
 * wave resolution reports it as `"all"` would.
 */
function resolveComponentList(
  selector: string,
  discovered: ReadonlyArray<{ name: string; enabled?: boolean }>,
  all: DriverComponent[],
): ResolvedComponentTargets {
  const names = [...new Set(selector.split(",").map((n) => n.trim()).filter((n) => n.length > 0))];
  if (names.length === 0) {
    return { success: false, targets: [], error: `Component list "${selector}" names no components.` };
  }
  if (names.includes("all")) {
    return { success: false, targets: [], error: `"all" cannot be part of a component list; pass --components all on its own, or name the components.` };
  }
  // An explicit ask for a unit the parameters excluded is a mistake to
  // surface, not to skip silently, as it is for a single name.
  const off = names.filter((n) => discovered.some((c) => c.name === n && c.enabled === false));
  if (off.length > 0) {
    const one = off.length === 1;
    return {
      success: false,
      targets: [],
      error: `${one ? "Component" : "Components"} ${off.map((n) => `"${n}"`).join(", ")} ${one ? "is" : "are"} disabled under this run's parameters (enabled: false). Enable the seam ${one ? "it is" : "they are"} gated on, or leave ${one ? "it" : "them"} out of the list.`,
    };
  }
  const unknown = names.filter((n) => !all.some((c) => c.name === n));
  if (unknown.length > 0) {
    const known = all.map((c) => c.name).sort().join(", ");
    return {
      success: false,
      targets: [],
      error: `${unknown.length === 1 ? "Component" : "Components"} ${unknown.map((n) => `"${n}"`).join(", ")} not found.${known ? ` Known components: ${known}` : " No components discovered."}`,
    };
  }

  const enabled = withoutDisabled(discovered, all);
  return { success: true, ...dependencyClosure(names, enabled), list: { named: names, enabled } };
}

/**
 * `names` and every component of `enabled` they depend on, transitively, in
 * `enabled`'s order, and which of those the names did not give (#3950).
 */
export function dependencyClosure(names: readonly string[], enabled: readonly DriverComponent[]): { targets: DriverComponent[]; added: string[] } {
  const byName = new Map(enabled.map((c) => [c.name, c]));
  const included = new Set<string>();
  const visit = (name: string): void => {
    const component = byName.get(name);
    if (!component || included.has(name)) return;
    included.add(name);
    for (const dep of component.dependsOn ?? []) visit(dep);
  };
  for (const name of names) visit(name);

  const targets = enabled.filter((c) => included.has(c.name));
  const named = new Set(names);
  return { targets, added: targets.map((c) => c.name).filter((n) => !named.has(n)) };
}

export async function runComponents(
  path: string,
  selector: string,
  options: RunComponentsOptions = {},
): Promise<RunComponentsResult> {
  const resolved = await resolveComponentTargets(path, selector, options.sandbox, options.buildParams);
  if (!resolved.success) {
    return { success: false, selected: [], error: resolved.error };
  }

  // (#629) Resolve `chant.config.ts`'s `sbom`/`signing`/`vulnPolicy` sections
  // and fill their defaults into every recognized step (`generate-sbom`,
  // `sign`/`attest-provenance`, `verify`, `vuln-gate`) that didn't already
  // specify the value itself, BEFORE dispatching to the driver — the driver
  // itself stays capability-agnostic and never reads project config (see
  // ./config-defaults.ts's module doc). Loaded up front here (rather than just
  // before `applyConfigDefaults`) so the same config drives which capability
  // plugins the registry loads: a component's cloud leaves (e.g. `cfn-deploy`)
  // are contributed by the project's active lexicons (`config.lexicons`), not
  // baked into core — see ./capability-plugin-loader.ts.
  const { config } = options.config ? { config: options.config } : await loadChantConfig(path);
  const registry: CapabilityRegistry =
    options.registry ??
    (await buildCapabilityRegistry({
      plugins: options.capabilityPlugins ?? config.capabilities,
      lexicons: lexiconNames(config.lexicons),
    }));
  const env = options.env ?? "local";
  // #4516: the reads a capability finds in its steps' files (a template's
  // Fn::ImportValue) order a set run as `deriveFanOut` orders a fan-out, so an
  // importer runs after the component whose export it reads. A list takes its
  // closure again with them written in, so a listed importer pulls in its
  // exporter. A single name runs on its own, against seeded outputs.
  let resolvedTargets: DriverComponent[];
  let added = resolved.added ?? [];
  if (resolved.list) {
    const enabled = await withDeclaredReads(resolved.list.enabled.map((component) => applyConfigDefaults(component, config)), registry, path);
    ({ targets: resolvedTargets, added } = dependencyClosure(resolved.list.named, enabled));
  } else {
    const defaulted = resolved.targets.map((component) => applyConfigDefaults(component, config));
    resolvedTargets = selector === "all" ? await withDeclaredReads(defaulted, registry, path) : defaulted;
  }
  if (options.prepare) {
    const prepared = await options.prepare(resolvedTargets);
    if ("error" in prepared) return { success: false, selected: [], error: prepared.error };
    resolvedTargets = prepared.components;
  }
  const selected = resolvedTargets.map((c) => c.name);
  const narrowed = options.targets ?? {};
  const outside = Object.keys(narrowed).filter((name) => !selected.includes(name));
  if (outside.length > 0) {
    return { success: false, selected: [], error: `--target names ${outside.join(", ")}, which this run does not run` };
  }
  const targeted = {
    ...(Object.keys(narrowed).length > 0 ? { targets: narrowed } : {}),
    // #4594: the grain and the lease reach every step through its DeployContext.
    ...(options.lockGrain ? { lockGrain: options.lockGrain } : {}),
    ...(options.rowLease ? { rowLease: options.rowLease } : {}),
  };
  if (options.adoption && (selector === "all" || isComponentList(selector))) {
    return { success: false, selected: [], error: `--adopt adopts into one component's stack; name one component, not ${selector === "all" ? "all" : "a list"}` };
  }
  // Cross-component/cross-stack outputs to resolve references against. Seeded
  // from a caller (a downstream CI job passing an upstream job's dumped
  // outputs via `--seed-outputs`); grows as this run's components complete.
  const seedOutputs = options.componentOutputs ?? {};
  const emit = joinRunEventSinks(options.onRunEvent, progressSinkOf(options.onProgress));

  const gates = options.gates;
  // #3061: the commit this run deploys, for the workloads' vcs.ref.head.revision. The digest comes
  // from the run's own publish step. Best effort: outside a git checkout nothing is passed.
  const revision =
    options.revision !== undefined
      ? options.revision ?? undefined
      : await getHeadCommit({ cwd: existsSync(path) && statSync(path).isDirectory() ? path : dirname(path) }).catch(() => undefined);
  const releaseIdentity = () => (revision ? { revision } : {});

  try {
    if (selector === "all" || isComponentList(selector)) {
      // ws-107 (#4465): the components a capability takes as one plan in their
      // wave and apply as one group, by the rule the pull-request run uses.
      // A cycle or unknown dependency throws here the error the driver would:
      // `componentSetFanOut` drops a dependency outside the set, so the full
      // graph is resolved first.
      resolveComponentGraph(resolvedTargets);
      const grouped = await formRunGroups({ components: resolvedTargets, plan: componentSetFanOut(resolvedTargets), registry, env });
      if (isComponentList(selector) && options.onPlan) {
        // Resolved here, before dispatch, so the order is printed before any
        // component runs.
        options.onPlan({ order: grouped.order, waves: grouped.waves.filter((w) => w.length > 0), added });
      }
      const byName = new Map(resolvedTargets.map((c) => [c.name, c]));
      const groups: InterpretGroups | undefined = grouped.groups?.length
        ? {
            waves: grouped.waves,
            groups: grouped.groups,
            run: (group, componentOutputs) =>
              planAndRunComponentGroup({
                group,
                components: byName,
                registry,
                env,
                ctxOf: (name) => deployContext({ env, releaseIdentity, ...targeted }, name),
                componentOutputs,
              }),
          }
        : undefined;
      const run = await runInterpretDriver(resolvedTargets, registry, {
        env,
        releaseIdentity,
        ...(groups ? { groups } : {}),
        ...targeted,
        componentOutputs: seedOutputs,
        ...(emit ? { onRunEvent: emit } : {}),
        ...(gates ? { gates } : {}),
      });
      return {
        success: run.status === "ok",
        run,
        selected,
        components: resolvedTargets,
        buildParams: options.buildParams,
        ...(grouped.groups?.length || grouped.fallbacks?.length ? { grouped } : {}),
        ...(run.status === "gated" && run.gate
          ? {
              gated: {
                component: run.gatedComponent ?? selected[0],
                gate: run.gate,
                ...(run.gatePushed !== undefined ? { pushed: run.gatePushed } : {}),
                ...(run.gatePushWarning ? { pushWarning: run.gatePushWarning } : {}),
                ...(run.gateMismatch ? { mismatch: run.gateMismatch } : {}),
              },
            }
          : {}),
      };
    }

    // Single-component invocation: run just this component, bypassing
    // whole-graph `dependsOn` resolution (see docstring above). The seeded
    // outputs stand in for the dependency components that ran in earlier jobs,
    // so a single-component run still resolves their `stackOutput()`/publish
    // references. `runComponentDeploy` mutates this map with this component's
    // own outputs, which `run.componentOutputs` then exposes for `--dump-outputs`.
    //
    // There's no `runInterpretDriver` call here to thread progress through
    // (that's the whole point of the single-component bypass), so the
    // run-start/wave-start/component-start/…/run-done envelope is emitted by
    // hand, treating this one component as a single-wave run — the same shape
    // `run.waves`/`run.order` below already give it.
    const componentOutputs = { ...seedOutputs };
    const componentName = resolvedTargets[0].name;
    emit?.({ type: "run-start", waves: [selected] });
    emit?.({ type: "wave-start", wave: 1, components: selected });
    emit?.({ type: "component-start", wave: 1, component: componentName });
    const componentResult = await runComponentDeploy(
      resolvedTargets[0],
      { ...deployContext({ env, releaseIdentity, ...targeted }, componentName), ...(options.adoption ? { adoption: options.adoption } : {}) },
      registry,
      componentOutputs,
      undefined,
      gates ? { port: gates } : undefined,
      emit,
    );
    const status = componentResult.status === "fail" ? "failed" : componentResult.status;
    emit?.({ type: "component-settle", wave: 1, component: componentName, status });
    emit?.({ type: "wave-settle", wave: 1, status });
    emit?.({ type: "run-settle", status, durationMs: null });
    const run: DriverRunResult = {
      order: selected,
      waves: [selected],
      results: [componentResult],
      ok: componentResult.ok,
      status: componentResult.status,
      failedComponent: componentResult.status === "fail" ? componentResult.component : undefined,
      ...(componentResult.status === "gated"
        ? {
            gatedComponent: componentResult.component,
            gate: componentResult.gate,
            ...(componentResult.gatePushed !== undefined ? { gatePushed: componentResult.gatePushed } : {}),
            ...(componentResult.gatePushWarning ? { gatePushWarning: componentResult.gatePushWarning } : {}),
            ...(componentResult.gateMismatch ? { gateMismatch: componentResult.gateMismatch } : {}),
          }
        : {}),
      componentOutputs,
    };
    return {
      success: componentResult.ok,
      run,
      selected,
      components: resolvedTargets,
      buildParams: options.buildParams,
      ...(componentResult.status === "gated" && componentResult.gate
        ? {
            gated: {
              component: componentResult.component,
              gate: componentResult.gate,
              ...(componentResult.gatePushed !== undefined ? { pushed: componentResult.gatePushed } : {}),
              ...(componentResult.gatePushWarning ? { pushWarning: componentResult.gatePushWarning } : {}),
              ...(componentResult.gateMismatch ? { mismatch: componentResult.gateMismatch } : {}),
            },
          }
        : {}),
    };
  } catch (err) {
    if (err instanceof DriverRunFailure) {
      return { success: false, run: err.result, selected, error: err.message };
    }
    if (err instanceof UnknownDependencyError || err instanceof DependencyCycleError) {
      return { success: false, selected, error: err.message };
    }
    throw err;
  }
}
