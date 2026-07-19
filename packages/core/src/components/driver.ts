/**
 * Thin interpret driver — Phase 1 (#556), saga rollback hardened in Phase 4
 * (#565, epic #551).
 *
 * One generic orchestrator that runs an arbitrary set of components on the
 * local in-process executor: it orders components by `dependsOn` (reusing the
 * same Kahn-layering approach `computeStackGraph` uses for `chant graph
 * --stacks`, see ../build.ts), then for each component in order runs its
 * `deploy` composition by dispatching every step to the `CapabilityRegistry`
 * by `kind`. It resolves the three wiring reference forms from
 * component.schema.json (`@Phase.field` prior-step references,
 * `@<component>.publish.<field>` cross-component artifact references, and
 * passes through `$env.*`/`stackOutput` values as opaque env config), runs
 * `parallel` phases concurrently, rejects a `gate` locally (matching
 * ../op/local-executor.ts's `LocalGateUnsupportedError`), and on terminal
 * failure unwinds every executed step in reverse via that step's capability
 * `rollback`, then runs `onFailure` phases in reverse order (best-effort),
 * mirroring the Op local executor's saga semantics.
 *
 * A step whose capability declares no `rollback` is never silently passed
 * over during unwind: it gets a `"rollback-opted-out"` record (see
 * `rollbackExecuted`), carrying the step's `noRollback` reason when the
 * composition declared one. This mirrors, at run time, the opt-out the
 * COMP003 lint rule (../lint/rules/comp/comp003-mutating-no-rollback.ts)
 * already requires at author time — the driver reports the same fact the
 * lint rule already made a component author state.
 *
 * This unwind runs entirely in-process: if the process crashes mid-rollback
 * on the local executor, nothing resumes it — there is no persisted run state
 * to resume from. That is the documented Temporal boundary (see
 * docs/components/orchestration.mdx#rollback-comes-free and
 * docs/guide/local-vs-temporal.mdx): the *mechanism* (reverse-order unwind
 * calling each capability's `rollback`) is capability-agnostic and works
 * identically on both executors, but *durable resume of a rollback already in
 * progress* is Temporal-only, the same boundary that already applies to
 * forward `onFailure` compensation on an Op.
 *
 * Contains zero per-component logic: nothing in this module branches on a
 * component or capability `kind`/name. All behavior is either generic
 * (ordering, phase/step dispatch, wiring resolution) or delegated to the
 * `CapabilityRegistry` the caller supplies.
 */

import { topoSort } from "../codegen/topo-sort";
import type { CapabilityRegistry, DeployContext } from "./capability";
import type { RunProgressEvent } from "./run-progress";

export type { RunProgressEvent } from "./run-progress";

// ── Component-shaped input (mirrors component.schema.json / ./component.ts) ──

/** A wiring reference or literal value, as it appears in a step's fields (schema `WiringValue`). */
export type WiringValue =
  | string
  | { stackOutput: { stack: string; name: string } }
  | Record<string, unknown>;

/** A single capability invocation — the leaf unit of a composition (schema `Step`). */
export interface DriverStep {
  kind: string;
  [param: string]: unknown;
}

/** A gate step — pauses for an external signal; unsupported on the local executor (schema `Gate`). */
export interface DriverGate {
  kind: "gate";
  signalName: string;
  timeout?: string;
  description?: string;
}

/** One named phase of a deploy composition (schema `Phase`). A step may itself be a nested `Phase` (fan-out). */
export interface DriverPhase {
  phase: string;
  steps: Array<DriverStep | DriverGate | DriverPhase>;
  parallel?: boolean;
  onFailure?: DriverPhase[];
}

/** The subset of the Component contract the driver needs to run a deploy (schema-shaped; see component.schema.json). */
export interface DriverComponent {
  name: string;
  dependsOn?: string[];
  deploy: DriverPhase[];
  /** Component-level saga compensation, run in reverse order on terminal failure (schema `rollback`). */
  rollback?: DriverPhase[];
}

function isGateStep(step: DriverStep | DriverGate | DriverPhase): step is DriverGate {
  return (step as { kind?: unknown }).kind === "gate";
}

function isPhaseStep(step: DriverStep | DriverGate | DriverPhase): step is DriverPhase {
  return typeof (step as { phase?: unknown }).phase === "string" && Array.isArray((step as DriverPhase).steps);
}

// ── Errors ────────────────────────────────────────────────────────────────

/** Thrown when a component's composition contains a `gate` — gates need a durable runtime, matching chant's Op local executor. */
export class DriverGateUnsupportedError extends Error {
  constructor(
    public readonly component: string,
    public readonly signalName: string,
  ) {
    super(
      `component "${component}": gate "${signalName}" is not supported on the local executor — ` +
        `gates need a durable runtime. Re-run with a durable (Temporal) backend.`,
    );
    this.name = "DriverGateUnsupportedError";
  }
}

/** Thrown when a dependency cycle is found among `dependsOn` edges. */
export class DependencyCycleError extends Error {
  constructor(public readonly cycle: string[]) {
    super(`dependency cycle among components: ${cycle.join(" -> ")}`);
    this.name = "DependencyCycleError";
  }
}

/** Thrown when a component's `dependsOn` names a component not present in the run set. */
export class UnknownDependencyError extends Error {
  constructor(
    public readonly component: string,
    public readonly dependency: string,
  ) {
    super(`component "${component}" depends on unknown component "${dependency}"`);
    this.name = "UnknownDependencyError";
  }
}

/** Thrown on terminal run failure; carries the partial run result for rendering/inspection. */
export class DriverRunFailure extends Error {
  constructor(public readonly result: DriverRunResult) {
    super(`interpret run failed at component "${result.failedComponent ?? "unknown"}"`);
    this.name = "DriverRunFailure";
  }
}

// ── Records ───────────────────────────────────────────────────────────────

export interface DriverStepRecord {
  component: string;
  phase: string;
  kind: string;
  status: "ok" | "fail" | "skipped" | "rolled-back" | "rollback-opted-out";
  durationMs: number;
  output?: unknown;
  error?: string;
}

export interface DriverComponentResult {
  component: string;
  ok: boolean;
  records: DriverStepRecord[];
}

export interface DriverRunResult {
  /** Component order actually attempted, in run order. */
  order: string[];
  /** Parallel-safe waves the order was derived from (see resolveComponentGraph). */
  waves: string[][];
  results: DriverComponentResult[];
  ok: boolean;
  /** Name of the component that terminated the run, if any. */
  failedComponent?: string;
  /**
   * The accumulated cross-component/cross-stack outputs after the run — each
   * component's `publish` output and, for an applied stack, its `cfn-deploy`
   * outputs, keyed by component name. Seeded from `options.componentOutputs`
   * and grown as components complete. The CLI's `--dump-outputs` serializes
   * this so a later, separate run (a downstream CI job) can `--seed-outputs`
   * it and resolve `stackOutput()`/`@<name>.publish.*` references to a
   * component that ran in an earlier job.
   */
  componentOutputs: Record<string, Record<string, unknown>>;
}

// ── Graph: order + parallel-safe waves from `dependsOn` ──────────────────────

export interface ComponentGraph {
  /** Flat topological order — every dependency before its dependents. */
  order: string[];
  /** Waves: components in the same wave share no dependency and may run concurrently. */
  waves: string[][];
}

/**
 * Resolve run order and parallel-safe waves from each component's `dependsOn`.
 * Reuses the generic `topoSort` (../codegen/topo-sort.ts) for the flat order,
 * and the same Kahn-layering approach `computeStackGraph` uses for `chant
 * graph --stacks` (../build.ts) to additionally group independent components
 * into waves. This is a plain string-graph algorithm — no lexicon/AttrRef
 * machinery — since a component's `dependsOn` is already a flat name list.
 */
export function resolveComponentGraph(components: DriverComponent[]): ComponentGraph {
  const byName = new Map(components.map((c) => [c.name, c]));
  for (const c of components) {
    for (const dep of c.dependsOn ?? []) {
      if (!byName.has(dep)) throw new UnknownDependencyError(c.name, dep);
    }
  }

  // Kahn layering (mirrors computeStackGraph's wave computation in ../build.ts):
  // a component is ready once every dependency it names has already been placed.
  // Computed first because it doubles as cycle detection: `topoSort` below is a
  // plain DFS with no cycle guard, so it must only run once a cycle is ruled out.
  const deps = new Map<string, Set<string>>();
  for (const c of components) deps.set(c.name, new Set(c.dependsOn ?? []));

  const remaining = new Set(deps.keys());
  const waves: string[][] = [];
  while (remaining.size > 0) {
    const wave = [...remaining]
      .filter((n) => [...deps.get(n)!].every((d) => !remaining.has(d)))
      .sort();
    if (wave.length === 0) {
      throw new DependencyCycleError([...remaining].sort());
    }
    for (const n of wave) remaining.delete(n);
    waves.push(wave);
  }

  const order = topoSort(
    components,
    (c) => c.name,
    (c) => c.dependsOn ?? [],
  ).map((c) => c.name);

  return { order, waves };
}

// ── Wiring resolution ─────────────────────────────────────────────────────

const PRIOR_STEP_REF = /^@([A-Za-z0-9_ ]+)\.([A-Za-z0-9_.]+)$/;
const COMPONENT_ARTIFACT_REF = /^@([a-z0-9]+(?:-[a-z0-9]+)*)\.publish\.(uri|digest|key)$/;

/** Dot-path lookup, matching ../op/local-executor.ts's resolvePath. */
function resolvePath(value: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>((acc, key) => (acc == null ? acc : (acc as Record<string, unknown>)[key]), value);
}

/**
 * Resolve one wiring value against already-produced outputs. Three reference
 * forms, all resolved here rather than by any component-specific code:
 *  - `@Phase.field` — a prior step's output within the same component, keyed
 *    by phase name (`phaseOutputs`).
 *  - `@<component>.publish.uri|digest|key` — another component's published
 *    artifact output (`componentOutputs`), per composition-and-wiring.mdx.
 *  - `{ stackOutput: { stack, name } }` — a cross-stack output; Phase 1 has no
 *    cross-stack apply-order integration (out of scope per #556), so this
 *    resolves via the same `componentOutputs` map keyed by `stack`/`name`,
 *    letting tests and callers seed cross-stack values the same way as
 *    artifact outputs. `$env.*` and plain literals pass through unchanged —
 *    env resolution is the caller's `DeployContext.vars`, not the driver's.
 */
export function resolveWiring(
  value: WiringValue,
  phaseOutputs: Record<string, Record<string, unknown>>,
  componentOutputs: Record<string, Record<string, unknown>>,
): unknown {
  if (typeof value === "string") {
    const priorStep = value.match(PRIOR_STEP_REF);
    if (priorStep) {
      const [, phaseName, field] = priorStep;
      return resolvePath(phaseOutputs[phaseName], field);
    }
    const artifactRef = value.match(COMPONENT_ARTIFACT_REF);
    if (artifactRef) {
      const [, componentName, field] = artifactRef;
      return resolvePath(componentOutputs[componentName]?.publish, field);
    }
    return value; // literal, or `$env.*` — left for the caller to resolve via DeployContext.
  }
  if (value && typeof value === "object" && "stackOutput" in value) {
    const { stack, name } = (value as { stackOutput: { stack: string; name: string } }).stackOutput;
    return resolvePath(componentOutputs[stack], name);
  }
  return value;
}

/**
 * Deep-walk an object, resolving every string/stackOutput wiring value found.
 * Arrays and nested objects are walked too.
 *
 * Exported (not just used internally) so the durable Temporal path
 * (`@intentius/chant-lexicon-temporal`'s component workflow codegen, see
 * epic #551 #589) can resolve a step's wiring the same way inside a Temporal
 * *activity* — the workflow itself only accumulates `phaseOutputs`/
 * `componentOutputs` and passes them through; resolution logic stays in one
 * place so local and durable execution can never silently diverge.
 */
export function resolveStepInput(
  input: Record<string, unknown>,
  phaseOutputs: Record<string, Record<string, unknown>>,
  componentOutputs: Record<string, Record<string, unknown>>,
): Record<string, unknown> {
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return resolveWiring(value, phaseOutputs, componentOutputs);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      if ("stackOutput" in value) return resolveWiring(value as WiringValue, phaseOutputs, componentOutputs);
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = walk(v);
      return out;
    }
    return value;
  };
  return walk(input) as Record<string, unknown>;
}

// ── Step + phase execution ───────────────────────────────────────────────

/** A step executed and its resolved input, kept so saga rollback can call the same capability's `rollback` with the same input. */
interface ExecutedStep {
  step: DriverStep;
  resolvedInput: Record<string, unknown>;
  phaseName: string;
}

class StepFailure extends Error {
  constructor(
    public readonly records: DriverStepRecord[],
    public readonly executed: ExecutedStep[],
  ) {
    super("step failed");
    this.name = "StepFailure";
  }
}

/** Run a single capability step. Never throws for a capability-run failure; returns a fail record instead. */
async function runCapabilityStep(
  step: DriverStep,
  phaseName: string,
  ctx: DeployContext,
  registry: CapabilityRegistry,
  phaseOutputs: Record<string, Record<string, unknown>>,
  componentOutputs: Record<string, Record<string, unknown>>,
): Promise<{ record: DriverStepRecord; resolvedInput: Record<string, unknown>; output?: unknown }> {
  const { kind, ...rest } = step;
  const resolvedInput = resolveStepInput(rest, phaseOutputs, componentOutputs);
  const start = Date.now();
  try {
    const capability = registry.resolve(kind);
    const output = await capability.run(ctx, resolvedInput as never);
    return {
      record: {
        component: ctx.component,
        phase: phaseName,
        kind,
        status: "ok",
        durationMs: Date.now() - start,
        output,
      },
      resolvedInput,
      output,
    };
  } catch (err) {
    return {
      record: {
        component: ctx.component,
        phase: phaseName,
        kind,
        status: "fail",
        durationMs: Date.now() - start,
        error: errMessage(err),
      },
      resolvedInput,
    };
  }
}

/**
 * Run a phase's steps. A step may be a `Gate` (rejected — local executor has
 * no durable wait) or a nested `Phase` (a fan-out unit; recursed into,
 * inheriting `parallel` from its own definition, not its parent's). Steps run
 * sequentially unless `phase.parallel` is set, in which case they run via
 * `Promise.all`, matching ../op/local-executor.ts's phase semantics.
 *
 * `onProgress`, when supplied, is called with a `phase-start` event before any
 * step runs, a `step` event around each capability invocation (`"running"`
 * then `"ok"`/`"failed"`), and a `phase-done` event once the phase settles —
 * purely additive observation, never consulted for control flow. Recursion
 * into a nested fan-out phase passes the same callback through, so a nested
 * phase's events use its own name. Left `undefined` by every caller that
 * doesn't opt into `--progress-json` (see ./run-progress.ts), in which case
 * every `onProgress?.(...)` call below is a no-op and behavior is unchanged.
 */
async function runPhase(
  phaseDef: DriverPhase,
  ctx: DeployContext,
  registry: CapabilityRegistry,
  phaseOutputs: Record<string, Record<string, unknown>>,
  componentOutputs: Record<string, Record<string, unknown>>,
  onProgress?: (event: RunProgressEvent) => void,
): Promise<{ records: DriverStepRecord[]; executed: ExecutedStep[] }> {
  const gate = phaseDef.steps.find(isGateStep);
  if (gate) throw new DriverGateUnsupportedError(ctx.component, gate.signalName);

  const entries = phaseDef.steps.filter((s): s is DriverStep | DriverPhase => !isGateStep(s));

  const runEntry = async (
    entry: DriverStep | DriverPhase,
  ): Promise<{ records: DriverStepRecord[]; executed: ExecutedStep[]; failed: boolean }> => {
    if (isPhaseStep(entry)) {
      try {
        const nested = await runPhase(entry, ctx, registry, phaseOutputs, componentOutputs, onProgress);
        return { ...nested, failed: false };
      } catch (err) {
        if (err instanceof StepFailure) return { records: err.records, executed: err.executed, failed: true };
        throw err;
      }
    }
    onProgress?.({ type: "step", component: ctx.component, phase: phaseDef.phase, step: entry.kind, status: "running" });
    const { record, resolvedInput, output } = await runCapabilityStep(
      entry,
      phaseDef.phase,
      ctx,
      registry,
      phaseOutputs,
      componentOutputs,
    );
    onProgress?.({
      type: "step",
      component: ctx.component,
      phase: phaseDef.phase,
      step: entry.kind,
      status: record.status === "ok" ? "ok" : "failed",
      ...(record.error !== undefined ? { error: record.error } : {}),
    });
    if (record.status === "ok") {
      phaseOutputs[phaseDef.phase] = { ...(phaseOutputs[phaseDef.phase] ?? {}), ...(output as object) };
    }
    return {
      records: [record],
      executed: record.status === "ok" ? [{ step: entry, resolvedInput, phaseName: phaseDef.phase }] : [],
      failed: record.status === "fail",
    };
  };

  const runEntries = async (): Promise<{ records: DriverStepRecord[]; executed: ExecutedStep[] }> => {
    if (phaseDef.parallel) {
      const results = await Promise.all(entries.map(runEntry));
      const records = results.flatMap((r) => r.records);
      const executed = results.flatMap((r) => r.executed);
      if (results.some((r) => r.failed)) throw new StepFailure(records, executed);
      return { records, executed };
    }

    const records: DriverStepRecord[] = [];
    const executed: ExecutedStep[] = [];
    for (let i = 0; i < entries.length; i++) {
      const result = await runEntry(entries[i]);
      records.push(...result.records);
      executed.push(...result.executed);
      if (result.failed) {
        for (const skipped of entries.slice(i + 1)) {
          const skippedKind = isPhaseStep(skipped) ? skipped.phase : (skipped as DriverStep).kind;
          records.push({
            component: ctx.component,
            phase: phaseDef.phase,
            kind: skippedKind,
            status: "skipped",
            durationMs: 0,
          });
        }
        throw new StepFailure(records, executed);
      }
    }
    return { records, executed };
  };

  onProgress?.({ type: "phase-start", component: ctx.component, phase: phaseDef.phase });
  try {
    const result = await runEntries();
    onProgress?.({ type: "phase-done", component: ctx.component, phase: phaseDef.phase, status: "ok" });
    return result;
  } catch (err) {
    if (err instanceof StepFailure) {
      onProgress?.({ type: "phase-done", component: ctx.component, phase: phaseDef.phase, status: "failed" });
    }
    throw err;
  }
}

/**
 * Roll back every executed step in reverse order via its capability's
 * `rollback`, if declared. Best-effort: a rollback failure is recorded but
 * does not stop the unwind.
 *
 * A step whose capability declares no `rollback` is not silently passed over:
 * it gets its own `"rollback-opted-out"` record, carrying the step's
 * `noRollback` reason when the composition declared one (the same opt-out
 * property COMP003 lint requires at author time — see
 * ../lint/rules/comp/comp003-mutating-no-rollback.ts) or a generic fallback
 * message otherwise. This is decided purely by whether `capability.rollback`
 * exists — never by the step's `kind` or the component's name — so it stays
 * capability-agnostic like the rest of this module.
 */
async function rollbackExecuted(
  executed: ExecutedStep[],
  ctx: DeployContext,
  registry: CapabilityRegistry,
): Promise<DriverStepRecord[]> {
  const records: DriverStepRecord[] = [];
  for (const { step, resolvedInput, phaseName } of [...executed].reverse()) {
    const start = Date.now();
    try {
      const capability = registry.resolve(step.kind);
      if (!capability.rollback) {
        const reason = typeof step.noRollback === "string" ? step.noRollback : undefined;
        records.push({
          component: ctx.component,
          phase: phaseName,
          kind: step.kind,
          status: "rollback-opted-out",
          durationMs: Date.now() - start,
          error: reason ?? `capability "${step.kind}" declares no rollback and the step has no "noRollback" reason`,
        });
        continue;
      }
      await capability.rollback(ctx, resolvedInput as never);
      records.push({
        component: ctx.component,
        phase: phaseName,
        kind: step.kind,
        status: "rolled-back",
        durationMs: Date.now() - start,
      });
    } catch (err) {
      records.push({
        component: ctx.component,
        phase: phaseName,
        kind: step.kind,
        status: "fail",
        durationMs: Date.now() - start,
        error: errMessage(err),
      });
    }
  }
  return records;
}

// ── Per-component deploy ─────────────────────────────────────────────────

/**
 * Run one component's `deploy` composition. On terminal failure: unwind every
 * executed step in reverse via its capability's `rollback` (saga
 * compensation), then run the component's declared `rollback` phases in
 * reverse order (best-effort), matching ../op/local-executor.ts's `onFailure`
 * handling. Cross-component artifact outputs this component published (if
 * any) are recorded into `componentOutputs` under its own name so downstream
 * components can reference `@<name>.publish.*`.
 *
 * `onProgress`, when supplied, is forwarded to every `runPhase` call (both the
 * forward `deploy` phases and, on failure, the component's own authored
 * `rollback` phases) so a `--progress-json` consumer sees `phase-start`/
 * `step`/`phase-done` events for whichever phases actually ran. The saga
 * unwind step-by-step compensation (`rollbackExecuted` below) is not part of
 * the `RunProgressEvent` contract and stays silent — it isn't a `deploy`
 * phase, and its record statuses (`rolled-back`/`rollback-opted-out`) don't
 * map onto the `step` event's `running`/`ok`/`failed` shape.
 */
export async function runComponentDeploy(
  component: DriverComponent,
  ctx: DeployContext,
  registry: CapabilityRegistry,
  componentOutputs: Record<string, Record<string, unknown>>,
  onProgress?: (event: RunProgressEvent) => void,
): Promise<DriverComponentResult> {
  const phaseOutputs: Record<string, Record<string, unknown>> = {};
  const records: DriverStepRecord[] = [];
  const allExecuted: ExecutedStep[] = [];

  try {
    for (const phaseDef of component.deploy) {
      const result = await runPhase(phaseDef, ctx, registry, phaseOutputs, componentOutputs, onProgress);
      records.push(...result.records);
      allExecuted.push(...result.executed);
    }
  } catch (err) {
    if (err instanceof StepFailure) {
      records.push(...err.records);
      allExecuted.push(...err.executed);
    } else {
      throw err;
    }

    records.push(...(await rollbackExecuted(allExecuted, ctx, registry)));

    for (const phaseDef of [...(component.rollback ?? [])].reverse()) {
      try {
        const result = await runPhase(phaseDef, ctx, registry, phaseOutputs, componentOutputs, onProgress);
        records.push(...result.records);
      } catch (compErr) {
        if (compErr instanceof StepFailure) records.push(...compErr.records);
        else throw compErr;
      }
    }

    return { component: component.name, ok: false, records };
  }

  // Publish-family outputs (publish-image / publish-artifact / load-image-on-host all
  // return at least one of uri/digest/key — see ../verbs/publish.ts) become this
  // component's `@<name>.publish.*` for downstream cross-component references.
  const publishOutput = findPublishOutput(phaseOutputs);
  if (publishOutput) {
    componentOutputs[component.name] = { ...componentOutputs[component.name], publish: publishOutput };
  }

  // Stack outputs from an apply step (cfn-deploy returns `CfnDeployOutput.outputs`)
  // become resolvable by downstream components' `stackOutput(<name>, ...)`
  // references — the cross-stack apply-order integration deferred in #556.
  // Merged at the top level of this component's entry (peer to `publish`, which
  // is namespaced under its own key), so `resolveWiring`'s stackOutput branch —
  // `resolvePath(componentOutputs[stack], name)` — finds each output by name.
  // Keyed by the component's own name, which by convention is the stack name a
  // `stackOutput` reference targets (see the pilots and composition-and-wiring.mdx).
  const stackOutputs = findStackOutputs(phaseOutputs);
  if (stackOutputs) {
    componentOutputs[component.name] = { ...componentOutputs[component.name], ...stackOutputs };
  }

  return { component: component.name, ok: true, records };
}

/**
 * Find the output of the last step that looks like a publish result (carries
 * `uri`, `digest`, or `key`) across every phase this component ran, so the
 * driver can populate `@<component>.publish.*` for a downstream consumer.
 * Generic by shape, not by capability `kind` — any capability whose output
 * carries one of these fields is eligible, keeping the driver free of
 * per-capability branching.
 */
function findPublishOutput(
  phaseOutputs: Record<string, Record<string, unknown>>,
): Record<string, unknown> | undefined {
  let found: Record<string, unknown> | undefined;
  for (const output of Object.values(phaseOutputs)) {
    if (output && ("uri" in output || "digest" in output || "key" in output)) {
      found = { ...found, ...output };
    }
  }
  return found;
}

/**
 * Find the stack `outputs` map produced by an apply-style step (cfn-deploy
 * returns `CfnDeployOutput.outputs`) across every phase this component ran, so
 * a deployed stack's outputs can seed downstream `stackOutput()` resolution.
 * Generic by shape — any output carrying an `outputs` record is eligible —
 * keeping the driver free of per-capability branching, the same way
 * `findPublishOutput` is.
 */
function findStackOutputs(
  phaseOutputs: Record<string, Record<string, unknown>>,
): Record<string, unknown> | undefined {
  let found: Record<string, unknown> | undefined;
  for (const output of Object.values(phaseOutputs)) {
    const outputs = output?.outputs;
    if (outputs && typeof outputs === "object" && !Array.isArray(outputs)) {
      found = { ...found, ...(outputs as Record<string, unknown>) };
    }
  }
  return found;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── Public API: the interpret driver ─────────────────────────────────────

export interface InterpretRunOptions {
  /** Target environment name, threaded into every capability's `DeployContext`. */
  env: string;
  /** Environment config resolved ahead of the run (registry URLs, cluster names, ...) — passed through as `DeployContext.vars`. */
  vars?: Record<string, unknown>;
  /** Pre-seeded cross-component/cross-stack outputs (e.g. from a prior run, or a caller resolving `stackOutput` externally). Merged with outputs this run produces. */
  componentOutputs?: Record<string, Record<string, unknown>>;
  /**
   * Opt-in structured progress observer (`chant run --components all
   * --progress-json`, see ./run-progress.ts). Called with `run-start`/
   * `wave-start`/`component-start`/…/`run-done` events as the run executes;
   * never consulted for control flow, so leaving it `undefined` (the default
   * for every caller that didn't pass `--progress-json`) makes every
   * `onProgress?.(...)` call below a no-op and this function's behavior is
   * byte-for-byte the same as before this option existed.
   */
  onProgress?: (event: RunProgressEvent) => void;
}

/**
 * Run a set of components to completion on the local in-process executor:
 * resolve dependency order and parallel-safe waves from `dependsOn`, then run
 * each wave's components (independent components within a wave run
 * concurrently; components across waves run in wave order), dispatching
 * every step to `registry` by `kind`. Stops the whole run at the first failed
 * component (after that component's own saga rollback completes), returning
 * a result with `ok: false`; throws `DriverRunFailure` carrying that result
 * so callers can choose to inspect or propagate it.
 *
 * Zero per-component logic: this function and everything it calls dispatches
 * purely on the generic `Component`/`Phase`/`Step` shapes and the registry —
 * no branch anywhere names a specific component or capability.
 */
export async function runInterpretDriver(
  components: DriverComponent[],
  registry: CapabilityRegistry,
  options: InterpretRunOptions,
): Promise<DriverRunResult> {
  const { order, waves } = resolveComponentGraph(components);
  const byName = new Map(components.map((c) => [c.name, c]));
  const componentOutputs: Record<string, Record<string, unknown>> = { ...(options.componentOutputs ?? {}) };
  const { onProgress } = options;

  onProgress?.({ type: "run-start", waves });

  const results: DriverComponentResult[] = [];
  let failedComponent: string | undefined;

  waveLoop: for (const [waveIndex, wave] of waves.entries()) {
    const waveNum = waveIndex + 1;
    onProgress?.({ type: "wave-start", wave: waveNum, components: wave });
    const waveComponents = wave.map((name) => byName.get(name)!);
    const waveResults = await Promise.all(
      waveComponents.map(async (component) => {
        onProgress?.({ type: "component-start", wave: waveNum, component: component.name });
        const result = await runComponentDeploy(
          component,
          { env: options.env, component: component.name, vars: options.vars },
          registry,
          componentOutputs,
          onProgress,
        );
        onProgress?.({ type: "component-done", wave: waveNum, component: component.name, status: result.ok ? "ok" : "failed" });
        return result;
      }),
    );
    results.push(...waveResults);
    const failed = waveResults.find((r) => !r.ok);
    onProgress?.({ type: "wave-done", wave: waveNum, status: failed ? "failed" : "ok" });
    if (failed) {
      failedComponent = failed.component;
      break waveLoop;
    }
  }

  const ok = failedComponent === undefined;
  onProgress?.({ type: "run-done", status: ok ? "ok" : "failed" });
  const result: DriverRunResult = { order, waves, results, ok, failedComponent, componentOutputs };
  if (!ok) throw new DriverRunFailure(result);
  return result;
}
