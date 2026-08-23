/**
 * Component → Temporal workflow/worker/activities codegen (#589, epic #551
 * §5/§8 "Durable Workflows").
 *
 * Mirrors `../op/serializer.ts` (the `Temporal::Op` codegen) as closely as a
 * structurally different input allows, and is the durable counterpart to the
 * local interpret driver (`@intentius/chant/components`'s `driver.ts`):
 *
 *   - phases            -> workflow phases, in declared order
 *   - capability steps  -> activity calls dispatched by `kind` through the
 *                          SAME `CapabilityRegistry` the local driver uses
 *   - `gate`            -> a durable wait-for-signal (identical codegen shape
 *                          to an Op gate: `defineSignal`/`setHandler`/`condition`)
 *   - `onFailure`        -> saga compensation: executed steps are unwound in
 *                          reverse via each capability's `rollback` (mirroring
 *                          `driver.ts`'s `rollbackExecuted`), then the
 *                          component's own `onFailure`/`rollback` phases run in
 *                          reverse, best-effort, before re-throwing — matching
 *                          `runComponentDeploy`'s local semantics exactly.
 *
 * Unlike an Op (whose `ActivityStep.args` are static JSON baked at codegen
 * time), a component step's fields may contain wiring references
 * (`@Phase.field`, `@<component>.publish.*`) that only resolve once prior
 * steps have run. `serializeOps`'s static-args model has no way to express
 * "this arg is last step's return value," so the generated workflow here
 * threads `phaseOutputs`/`componentOutputs` as plain workflow-local state
 * (exactly what `driver.ts` does in-process) and passes them into two generic
 * activities — `runCapabilityStep` / `rollbackCapabilityStep`
 * (./activities.ts) — which resolve wiring via the exact same
 * `resolveStepInput` the local executor calls, so local and durable runs can
 * never silently diverge on wiring semantics. The accumulation side is shared
 * the same way (#700): after the deploy phases, a third activity
 * (`accumulateComponentOutputs`) folds the component's publish/stack outputs
 * into `componentOutputs` through core's `accumulateComponentOutputs`, and the
 * workflow accepts an optional `{ componentOutputs }` seed so a parent
 * orchestration can thread the map from one component workflow to the next.
 *
 * The target `env` (and any `vars`) is resolved by the CLI at the moment it
 * compiles the component (`chant run --components <name> --temporal --env
 * <env>`; see ../../../packages/core/src/cli/handlers/run.ts's
 * `runComponentTemporal`) and baked into the generated workflow as a literal
 * — there is no other point in time this codegen runs at, so this mirrors how
 * `runComponents`' local path resolves `env` once per invocation
 * (../../../packages/core/src/components/cli-support.ts).
 *
 * For a component named "search-service" this emits, under
 * dist/components/search-service/:
 *   workflow.ts   — the Temporal workflow function
 *   activities.ts — re-exports the two generic dispatch activities
 *   worker.ts     — bootstrap worker that reads chant.config.ts
 */

import type { DriverComponent, DriverPhase, DriverStep, DriverGate } from "@intentius/chant/components";
import { kebabToCamel, signalVarName, safeIdentifier, generateWorkerBootstrap } from "../codegen-shared";

// ── Name helpers ──────────────────────────────────────────────────────────────

/**
 * `component.name` is schema-constrained to kebab-case but may still start
 * with a digit (`^[a-z0-9]+(-[a-z0-9]+)*$` allows e.g. "3d-viewer"), which
 * `kebabToCamel` alone would turn into an invalid leading-digit identifier
 * (`3dViewerComponentWorkflow`) — `safeIdentifier` guards against that.
 */
function workflowFnName(componentName: string): string {
  return safeIdentifier(kebabToCamel(componentName) + "ComponentWorkflow");
}

/**
 * `Gate.signalName` has no format restriction in the schema (just
 * `minLength: 1`), so it may contain characters `signalVarName` alone would
 * pass through unescaped into a `const` declaration — `safeIdentifier` guards
 * against that (see its own docstring for why this can't just be a schema
 * fix: legacy/hand-authored JSON components are schema-valid input this
 * codegen must still handle).
 */
function gateSignalVarName(signalName: string): string {
  return safeIdentifier(signalVarName(signalName));
}

// ── Type helpers ──────────────────────────────────────────────────────────────

function isGateStep(s: DriverStep | DriverGate | DriverPhase): s is DriverGate {
  return (s as { kind?: unknown }).kind === "gate";
}

function isPhaseStep(s: DriverStep | DriverGate | DriverPhase): s is DriverPhase {
  return typeof (s as DriverPhase).phase === "string" && Array.isArray((s as DriverPhase).steps);
}

// ── Workflow code generation ──────────────────────────────────────────────────

/** Every gate anywhere in the component (deploy + rollback), including nested fan-out phases — mirrors `findComponentGate` (../../packages/core/src/components/cli-support.ts) but collects ALL gates (for signal declarations) rather than the first. */
function collectGates(phases: DriverPhase[]): DriverGate[] {
  const out: DriverGate[] = [];
  const walk = (ps: DriverPhase[]) => {
    for (const p of ps) {
      for (const s of p.steps) {
        if (isGateStep(s)) out.push(s);
        else if (isPhaseStep(s)) walk([s]);
      }
      if (p.onFailure) walk(p.onFailure);
    }
  };
  walk(phases);
  return out;
}

/** Options controlling the target environment baked into the generated workflow. */
export interface SerializeComponentOptions {
  /** Target environment name, threaded into every capability's `DeployContext.env` (default: "local" — matches `runComponents`' default). */
  env?: string;
  /** Arbitrary environment config resolved by the caller (registry URLs, cluster names, ...), threaded into every capability's `DeployContext.vars`. */
  vars?: Record<string, unknown>;
}

function generateWorkflow(component: DriverComponent, options: SerializeComponentOptions): string {
  const fnName = workflowFnName(component.name);
  const allGates = [...collectGates(component.deploy), ...collectGates(component.rollback ?? [])];
  const env = options.env ?? "local";
  const varsLiteral = JSON.stringify(options.vars ?? {});

  const lines: string[] = [
    "// Generated by chant — do not edit directly.",
    `// Source: component "${component.name}" (#589 durable component codegen)`,
    "import { proxyActivities, condition, defineSignal, setHandler, upsertSearchAttributes } from '@temporalio/workflow';",
    "import type * as activities from './activities';",
    "",
    "const { runCapabilityStep, rollbackCapabilityStep, accumulateComponentOutputs } = proxyActivities<typeof activities>({",
    "  startToCloseTimeout: '20m',",
    "  retry: { maximumAttempts: 3, initialInterval: '5s', backoffCoefficient: 2 },",
    "});",
    "",
    `// Target environment resolved at compile time (chant run --components ${JSON.stringify(component.name)} --temporal --env <env>).`,
    `const __env = ${JSON.stringify(env)};`,
    `const __vars: Record<string, unknown> = ${varsLiteral};`,
    "",
    "// The workflow's final phaseOutputs/componentOutputs, returned so the CLI can",
    "// read the run's published digest via handle.result() post-completion (#597) —",
    "// see packages/core/src/components/auto-release.ts.",
    "interface ComponentWorkflowResult {",
    "  phaseOutputs: Record<string, Record<string, unknown>>;",
    "  componentOutputs: Record<string, Record<string, unknown>>;",
    "}",
    "",
    "// Optional workflow input: a parent orchestration (or a CLI --seed-outputs",
    "// equivalent) seeds componentOutputs with upstream components' accumulated",
    "// outputs — the durable twin of InterpretRunOptions.componentOutputs (#700).",
    "interface ComponentWorkflowInput {",
    "  componentOutputs?: Record<string, Record<string, unknown>>;",
    "}",
    "",
  ];

  if (allGates.length > 0) {
    for (const gateStep of allGates) {
      // Approver identity rides in the signal payload so it lands in the
      // Temporal workflow history — mirrors ../op/serializer.ts's Op gate.
      lines.push(`const ${gateSignalVarName(gateStep.signalName)} = defineSignal<[{ approver?: string }?]>(${JSON.stringify(gateStep.signalName)});`);
    }
    lines.push("");
  }

  lines.push(`export async function ${fnName}(input?: ComponentWorkflowInput): Promise<ComponentWorkflowResult> {`);
  lines.push(`  upsertSearchAttributes({ ComponentName: [${JSON.stringify(component.name)}] });`);
  lines.push("");
  lines.push("  // phaseOutputs/componentOutputs mirror the local interpret driver's wiring");
  lines.push("  // state (packages/core/src/components/driver.ts) — accumulated here as plain");
  lines.push("  // workflow-local variables (deterministic, replay-safe) and threaded into");
  lines.push("  // every activity call so `runCapabilityStep`/`rollbackCapabilityStep` can");
  lines.push("  // resolve `@Phase.field` references exactly like the local executor does.");
  lines.push("  // componentOutputs starts from the caller's seed (empty when the CLI starts");
  lines.push("  // this workflow standalone): this workflow compiles and runs ONE component, so");
  lines.push("  // any other component's `@<name>.publish.*` / stackOutput() values can only");
  lines.push("  // arrive via `input.componentOutputs` — the same way `runComponents`' single-");
  lines.push("  // name branch is seeded from --seed-outputs locally (see packages/core/src/");
  lines.push("  // components/cli-support.ts). Unseeded cross-component references resolve to");
  lines.push("  // undefined, same as a single local run without its dependency's wave.");
  lines.push("  // Once every deploy phase has run, this component's own outputs are folded");
  lines.push("  // in by the `accumulateComponentOutputs` activity — the same core accumulator");
  lines.push("  // the local driver uses (#700) — and returned for a parent to thread onward.");
  lines.push("  const phaseOutputs: Record<string, Record<string, unknown>> = {};");
  lines.push("  let componentOutputs: Record<string, Record<string, unknown>> = { ...(input?.componentOutputs ?? {}) };");
  lines.push("  const executed: Array<{ step: Record<string, unknown>; phaseName: string }> = [];");
  lines.push("");

  // Render one non-gate entry (a capability step, or a nested fan-out phase)
  // and return the JS expression text that evaluates to its output (an
  // `object | undefined`), without touching `phaseOutputs` itself — callers
  // merge the returned output into `phaseOutputs` AFTER every entry in the
  // phase has settled, which is what keeps a `parallel: true` phase race-free
  // (see the parallel branch below): writing to the shared `phaseOutputs[phase]`
  // key from inside each concurrent branch, as soon as that branch's own
  // await resolves, would let two sibling steps race on the same
  // read-merge-write and silently drop one of their outputs.
  const renderEntry = (entry: DriverStep | DriverPhase, phaseName: string, ind: string): string => {
    if (isPhaseStep(entry)) {
      // A nested fan-out phase has no single "output" of its own (it's a
      // recursive composition, not a capability step) — run it for effect
      // and contribute nothing to the parent phase's merged output, matching
      // driver.ts's `runPhase`, which only merges `output` from `DriverStep`
      // entries (`isPhaseStep` entries recurse without producing one).
      lines.push(`${ind}await (async () => {`);
      renderPhase(entry, `${ind}  `);
      lines.push(`${ind}})();`);
      return "undefined";
    }
    const id = outCounter++;
    const stepVar = `__step${id}`;
    const outVar = `__out${id}`;
    const stepJson = JSON.stringify(entry);
    lines.push(`${ind}const ${stepVar} = ${stepJson};`);
    lines.push(
      `${ind}const ${outVar} = await runCapabilityStep({ step: ${stepVar}, phase: ${JSON.stringify(phaseName)}, component: ${JSON.stringify(component.name)}, env: __env, vars: __vars, phaseOutputs, componentOutputs });`,
    );
    lines.push(`${ind}executed.push({ step: ${stepVar}, phaseName: ${JSON.stringify(phaseName)} });`);
    return outVar;
  };

  let outCounter = 0;

  const renderPhase = (phaseDef: DriverPhase, indent: string) => {
    lines.push(`${indent}// Phase: ${phaseDef.phase}`);
    lines.push(`${indent}upsertSearchAttributes({ Phase: [${JSON.stringify(phaseDef.phase)}] });`);

    const entries = phaseDef.steps.filter((s): s is DriverStep | DriverPhase => !isGateStep(s));
    const gateSteps = phaseDef.steps.filter(isGateStep);

    if (phaseDef.parallel && entries.length > 1) {
      // Each branch resolves to its own output var; all outputs are merged
      // into phaseOutputs[phase] in one pass AFTER Promise.all settles, so
      // no two branches ever race on the same read-merge-write.
      const parallelId = outCounter++;
      const branchVars = entries.map((_, i) => `__branch${parallelId}_${i}`);
      lines.push(`${indent}const [${branchVars.join(", ")}] = await Promise.all([`);
      for (const entry of entries) {
        lines.push(`${indent}  (async () => {`);
        const outExpr = renderEntry(entry, phaseDef.phase, `${indent}    `);
        lines.push(`${indent}    return ${outExpr};`);
        lines.push(`${indent}  })(),`);
      }
      lines.push(`${indent}]);`);
      lines.push(
        `${indent}phaseOutputs[${JSON.stringify(phaseDef.phase)}] = { ...(phaseOutputs[${JSON.stringify(phaseDef.phase)}] ?? {}), ${branchVars.map((v) => `...(${v} as object ?? {})`).join(", ")} };`,
      );
    } else {
      for (const entry of entries) {
        const outExpr = renderEntry(entry, phaseDef.phase, indent);
        lines.push(
          `${indent}phaseOutputs[${JSON.stringify(phaseDef.phase)}] = { ...(phaseOutputs[${JSON.stringify(phaseDef.phase)}] ?? {}), ...(${outExpr} as object ?? {}) };`,
        );
      }
    }

    for (const gateStep of gateSteps) {
      const varName = gateSignalVarName(gateStep.signalName);
      const timeout = gateStep.timeout || "48h";
      if (gateStep.description) lines.push(`${indent}// Gate: ${gateStep.signalName} — ${gateStep.description}`);
      else lines.push(`${indent}// Gate: ${gateStep.signalName}`);
      lines.push(`${indent}let ${varName}Cleared = false;`);
      lines.push(`${indent}let ${varName}Approver: string | undefined;`);
      lines.push(`${indent}setHandler(${varName}, (arg) => { ${varName}Approver = arg?.approver; ${varName}Cleared = true; });`);
      lines.push(`${indent}await condition(() => ${varName}Cleared, ${JSON.stringify(timeout)});`);
      lines.push(`${indent}void ${varName}Approver;`);
    }

    lines.push("");
  };

  const renderPhases = (phases: DriverPhase[], indent: string) => {
    for (const phaseDef of phases) renderPhase(phaseDef, indent);
  };

  const renderRollback = (phases: DriverPhase[] | undefined, indent: string) => {
    // Saga unwind of already-executed steps, mirroring driver.ts's
    // rollbackExecuted: reverse order, best-effort, via each capability's
    // own `rollback` (opted-out steps are reported by the activity itself).
    lines.push(`${indent}for (const __e of [...executed].reverse()) {`);
    lines.push(`${indent}  try {`);
    lines.push(
      `${indent}    await rollbackCapabilityStep({ step: __e.step, phase: __e.phaseName, component: ${JSON.stringify(component.name)}, env: __env, vars: __vars, phaseOutputs, componentOutputs });`,
    );
    lines.push(`${indent}  } catch { /* best-effort unwind — never mask the original error */ }`);
    lines.push(`${indent}}`);
    if (phases && phases.length > 0) {
      lines.push(`${indent}try {`);
      renderPhases([...phases].reverse(), `${indent}  `);
      lines.push(`${indent}} catch { /* best-effort compensation — never mask the original error */ }`);
    }
  };

  const hasRollback = (component.rollback?.length ?? 0) > 0;
  lines.push("  try {");
  renderPhases(component.deploy, "    ");
  lines.push("    // Every deploy phase succeeded: capture publish/stack outputs under this");
  lines.push("    // component's name via the shared core accumulator (driver.ts parity, #700).");
  lines.push(
    `    componentOutputs = await accumulateComponentOutputs({ component: ${JSON.stringify(component.name)}, phaseOutputs, componentOutputs });`,
  );
  lines.push("  } catch (__compErr) {");
  lines.push("    // Saga rollback + onFailure/rollback compensation (terminal failure only),");
  lines.push("    // matching runComponentDeploy's local semantics exactly.");
  renderRollback(hasRollback ? component.rollback : undefined, "    ");
  lines.push("    throw __compErr;");
  lines.push("  }");
  lines.push("");
  lines.push("  // Returned so the CLI (chant run --components <name> --temporal, #597) can read");
  lines.push("  // the promoted artifact's digest via handle.result() after a COMPLETED run, to");
  lines.push("  // auto-emit a release-ledger record — never computed inside the CLI itself, since");
  lines.push("  // phaseOutputs/componentOutputs are only ever produced here, deterministically,");
  lines.push("  // from values this workflow already computed (mirrors runComponentDeploy's");
  lines.push("  // return shape locally; adds no new non-determinism, just returns state that");
  lines.push("  // already existed).");
  lines.push("  return { phaseOutputs, componentOutputs };");
  lines.push("}");
  lines.push("");

  return lines.join("\n");
}

// ── Activities re-export ──────────────────────────────────────────────────────

function generateActivities(): string {
  return [
    "// Generated by chant — do not edit directly.",
    "// Re-exports the generic capability-dispatch activities.",
    "export { runCapabilityStep, rollbackCapabilityStep, accumulateComponentOutputs } from '@intentius/chant-lexicon-temporal/component-op/activities';",
    "",
  ].join("\n");
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Deterministic workflow function name for a component — used by the CLI to start/signal the workflow. */
export function componentWorkflowFnName(componentName: string): string {
  return workflowFnName(componentName);
}

/**
 * Serialize one component into generated file content: `workflow.ts`,
 * `activities.ts`, `worker.ts`. Returns a map of relative output paths ->
 * file content, e.g. `{ "components/search-service/workflow.ts": "...", ... }`
 * — the same shape `serializeOps` returns for `ops/<name>/*`, so the CLI
 * (`chant run --components <name> --temporal`) can write them the same way.
 *
 * `options.env`/`options.vars` are baked into the generated workflow as
 * literals (see `generateWorkflow`'s docstring for why codegen, not the
 * workflow itself, is where the target environment is resolved).
 */
export function serializeComponent(
  component: DriverComponent,
  options: SerializeComponentOptions = {},
): Record<string, string> {
  const dir = `components/${component.name}`;
  return {
    [`${dir}/workflow.ts`]: generateWorkflow(component, options),
    [`${dir}/activities.ts`]: generateActivities(),
    [`${dir}/worker.ts`]: generateWorkerBootstrap({ dir: "components", name: component.name, taskQueue: component.name }),
  };
}
