/**
 * Op serializer — generates Temporal workflow, worker, and activities files
 * for each Temporal::Op entity.
 *
 * For an Op named "alb-deploy" it emits three files under dist/ops/alb-deploy/:
 *   workflow.ts   — the Temporal workflow function
 *   activities.ts — re-exports from the pre-built activity library
 *   worker.ts     — bootstrap worker that reads chant.config.ts
 *
 * Step-output references (chant #1290): a step whose `id` a later step's
 * `args` references (via `stepOutput()`/`.out`, `@intentius/chant/op`) gets
 * its awaited result captured into a `const __rN`, same as `outcomeAttribute`
 * already does — the two share one capture pass and one `__rN` counter. The
 * referencing step's `args` are then rendered with the reference compiled
 * to `__rN` (or `__rN?.path?.segments`) instead of a JSON literal, so the
 * value flows through the generated workflow as a real local variable.
 * `validateStepOutputRefs` (TMP013) is what makes this safe to compile
 * unconditionally — every reference reaching this file already resolved to
 * a step id in scope, ordered before its consumer.
 */

import type { Declarable } from "@intentius/chant/declarable";
import { isResourceDeclarable } from "@intentius/chant/declarable";
import type { OpConfig, PhaseDefinition, StepDefinition, ActivityStep, GateStep, EffectStep } from "@intentius/chant/op";
import { isStepOutputRef, collectStepOutputRefs, validateStepOutputRefScope } from "@intentius/chant/op";
import { kebabToCamel, signalVarName, generateWorkerBootstrap } from "../codegen-shared";

// ── Name helpers ──────────────────────────────────────────────────────────────

function workflowFnName(opName: string): string {
  return kebabToCamel(opName) + "Workflow";
}

// ── Type helpers ──────────────────────────────────────────────────────────────

function isActivityStep(s: StepDefinition): s is ActivityStep {
  return s.kind === "activity";
}

function isGateStep(s: StepDefinition): s is GateStep {
  return s.kind === "gate";
}

function isEffectStep(s: StepDefinition): s is EffectStep {
  return s.kind === "effect";
}

function effectiveProfile(step: ActivityStep): string {
  return step.profile ?? "fastIdempotent";
}

// ── Workflow code generation ──────────────────────────────────────────────────

// The receipt-store activities an effect step's read-compare-run-write calls
// (#1834). Fixed steps so `bindActivities` gives them one proxy binding at the
// `fastIdempotent` profile; the implementations come from the receipt row's
// lexicon (#1835, aws) via the activity registry.
const RECEIPT_READ_STEP: ActivityStep = { kind: "activity", fn: "receiptRead", profile: "fastIdempotent" };
const RECEIPT_WRITE_STEP: ActivityStep = { kind: "activity", fn: "receiptWrite", profile: "fastIdempotent" };

function collectActivitySteps(phases: PhaseDefinition[]): ActivityStep[] {
  return phases.flatMap((p) =>
    p.steps.flatMap((s) =>
      isActivityStep(s)
        ? [s]
        : isEffectStep(s)
          ? [RECEIPT_READ_STEP, ...s.steps.filter(isActivityStep), RECEIPT_WRITE_STEP]
          : [],
    ),
  );
}

/** Every gate in a phase, including gates nested inside effect steps. */
function collectGateSteps(phases: PhaseDefinition[]): GateStep[] {
  return phases.flatMap((p) =>
    p.steps.flatMap((s) =>
      isGateStep(s) ? [s] : isEffectStep(s) ? s.steps.filter(isGateStep) : [],
    ),
  );
}

/**
 * One proxy binding per (activity, profile) pair.
 *
 * Each profile gets its own `proxyActivities(...)` call, and an activity is
 * destructured from it under a local identifier. The first profile an activity
 * is authored at keeps the bare function name (`shellCmd`); every further
 * profile the same activity appears at gets a suffixed alias
 * (`shellCmd_longInfra`) so the generated workflow never declares the same
 * `const` twice (#1698). Steps reference the alias for their own profile.
 */
interface ActivityBindings {
  /** profile → [activity fn → local identifier], in first-seen order */
  byProfile: Map<string, Map<string, string>>;
  /** `${profile}:${fn}` → local identifier */
  ident: (step: ActivityStep) => string;
}

function bindActivities(steps: ActivityStep[]): ActivityBindings {
  const byProfile = new Map<string, Map<string, string>>();
  const seenFns = new Set<string>();
  for (const step of steps) {
    const prof = effectiveProfile(step);
    if (!byProfile.has(prof)) byProfile.set(prof, new Map());
    const fns = byProfile.get(prof)!;
    if (fns.has(step.fn)) continue;
    fns.set(step.fn, seenFns.has(step.fn) ? `${step.fn}_${prof}` : step.fn);
    seenFns.add(step.fn);
  }
  return {
    byProfile,
    ident: (step) => byProfile.get(effectiveProfile(step))!.get(step.fn)!,
  };
}

/**
 * Defense-in-depth against a scope-invalid step-output reference (chant
 * #1290 pre-merge review, finding 2): `validateStepOutputRefs` (TMP013) is
 * what's *supposed* to keep a reference like this from ever reaching this
 * file — `chant build` blocks file output while an error-severity post-synth
 * finding stands. But `serializeOps` is itself a public export a caller can
 * invoke directly, bypassing `chant build`'s lint pass entirely. Without
 * this check, a reference authored inside an `onFailure` phase (or nested
 * inside an `EffectStep`) that happens to name a step id captured elsewhere
 * in the Op silently compiles: the reference resolves by "was this producer
 * ever captured" alone, with no notion of *scope* — the captured `const
 * __rN` may live inside a `try` block the reference's own render site (a
 * `catch` block, or a sibling `if`/`else` branch) can't see, producing
 * generated TypeScript that fails to compile (TS2304, reproduced in the
 * review). This runs the same scope/ordering validation TMP013 does
 * (`validateStepOutputRefScope` — the contract-independent half of
 * `validateStepOutputRefs`) and refuses to emit anything for an Op that
 * fails it, regardless of caller.
 */
function assertStepOutputRefsInScope(config: OpConfig): void {
  const issues = validateStepOutputRefScope(config);
  if (issues.length === 0) return;
  throw new Error(
    `Op "${config.name}": ${issues.length} scope-invalid step-output reference(s) — ` +
      `refusing to emit generated code that would reference an out-of-scope variable ` +
      `(run \`chant build\` for the full TMP013 report):\n` +
      issues.map((i) => `  - phase "${i.phase}", step "${i.fn}": ${i.message}`).join("\n"),
  );
}

function generateWorkflow(config: OpConfig): string {
  assertStepOutputRefsInScope(config);

  const allActivitySteps = [
    ...collectActivitySteps(config.phases),
    ...(config.onFailure ? collectActivitySteps(config.onFailure) : []),
  ];

  const bindings = bindActivities(allActivitySteps);
  const byProfile = bindings.byProfile;
  const callee = bindings.ident;

  const allGateSteps = [
    ...collectGateSteps(config.phases),
    ...collectGateSteps(config.onFailure ?? []),
  ];

  const hasEffects = [...config.phases, ...(config.onFailure ?? [])].some((p) =>
    p.steps.some(isEffectStep),
  );

  const fnName = workflowFnName(config.name);

  const lines: string[] = [
    "// Generated by chant — do not edit directly.",
    `// Source: ${config.name}.op.ts`,
    `import { proxyActivities, condition, defineSignal, setHandler, upsertSearchAttributes${hasEffects ? ", log" : ""} } from '@temporalio/workflow';`,
    // Import profiles from the config leaf, not the package root: the root pulls
    // in the plugin/serializer (node:fs/path), which Temporal's workflow sandbox
    // forbids and the worker's bundler rejects. config.ts is import-free.
    "import { TEMPORAL_ACTIVITY_PROFILES } from '@intentius/chant-lexicon-temporal/config';",
    "import type * as activities from './activities';",
    "",
  ];

  // proxyActivities per profile
  if (byProfile.size === 0) {
    lines.push("// No activities defined.");
    lines.push("");
  } else {
    for (const [prof, fns] of byProfile) {
      const destructured = [...fns]
        .map(([fn, id]) => (id === fn ? fn : `${fn}: ${id}`))
        .join(", ");
      lines.push(`const { ${destructured} } = proxyActivities<typeof activities>(`);
      lines.push(`  TEMPORAL_ACTIVITY_PROFILES.${prof},`);
      lines.push(`);`);
    }
    lines.push("");
  }

  // Gate signals declarations. The signal carries an approver identity in its
  // payload so that "who approved this gate" is persisted in the Temporal
  // workflow history (the WorkflowExecutionSignaled event records the signal
  // input) — the durable, attributable half of the approval, sent by whoever
  // clears the gate (see `chant run signal ... --approver`). The field is
  // optional at the type level so an older approver client that sends no
  // payload still clears the gate (approver simply stays undefined).
  if (allGateSteps.length > 0) {
    for (const gate of allGateSteps) {
      const varName = signalVarName(gate.signalName);
      lines.push(`const ${varName} = defineSignal<[{ approver?: string }?]>(${JSON.stringify(gate.signalName)});`);
    }
    lines.push("");
  }

  // Workflow function
  lines.push(`export async function ${fnName}(): Promise<void> {`);

  // Initial search attributes — OpName plus any user-provided attrs.
  // Each value is wrapped in a single-element array (classic
  // upsertSearchAttributes API takes arrays).
  const initialAttrs: Record<string, string[]> = {
    OpName: [config.name],
  };
  for (const [k, v] of Object.entries(config.searchAttributes ?? {})) {
    initialAttrs[k] = [v];
  }
  lines.push(`  upsertSearchAttributes(${JSON.stringify(initialAttrs)});`);
  lines.push("");

  // Counter for outcome-attribute AND step-output-reference capture
  // variables (workflow-scoped) — one shared `__rN` counter/var per step
  // that needs its result captured, whichever reason(s) apply.
  let resultCounter = 0;
  const nextResultVar = (): string => `__r${resultCounter++}`;

  // Step-output references (#1290). Scope matches `validateStepOutputRefs`
  // exactly: `config.phases` only, top-level activity steps only — never
  // `onFailure`, never a step nested inside an `EffectStep`. A step whose
  // `id` is referenced needs its result captured into a variable even when
  // it has no `outcomeAttribute`; `varNameForStepId` records which variable
  // once that step has been emitted, so a later consuming step's `args` can
  // be rendered as a real reference to it instead of a JSON literal.
  const referencedStepIds = new Set<string>();
  for (const p of config.phases) {
    for (const s of p.steps) {
      if (s.kind !== "activity") continue;
      for (const ref of collectStepOutputRefs(s.args)) referencedStepIds.add(ref.step);
    }
  }
  const varNameForStepId = new Map<string, string>();
  const needsCapture = (step: ActivityStep): boolean =>
    !!step.outcomeAttribute || (!!step.id && referencedStepIds.has(step.id));

  // Build a `String(<var>?.<from-path>)` fragment from a dot-path.
  const stringifyFromPath = (varName: string, from?: string): string => {
    if (!from) return `String(${varName})`;
    const parts = from.split(".");
    return `String(${varName}?.${parts.join("?.")})`;
  };

  // Emit `upsertSearchAttributes({ <name>: [<expr>] })` for an outcome attr.
  const emitOutcomeUpsert = (
    step: ActivityStep,
    varName: string,
    indent = "  ",
  ): string | null => {
    if (!step.outcomeAttribute) return null;
    const { name, from } = step.outcomeAttribute;
    return `${indent}upsertSearchAttributes({ ${JSON.stringify(name)}: [${stringifyFromPath(varName, from)}] });`;
  };

  // Counter for effect-step capture variables (workflow-scoped).
  let effectCounter = 0;
  const nextEffectVar = (): string => `__eff${effectCounter++}`;

  // Render a step-output reference as `<var>` (whole value) or
  // `<var>?.<path, ?.-joined>` (a sub-field) — the earlier step's captured
  // result, not a JSON literal. Throws if the producer wasn't captured:
  // `validateStepOutputRefs` (TMP013) rejects every config that would reach
  // this — an unresolved reference here means the serializer ran on
  // unvalidated input, so fail loud rather than emit `undefined?.path`.
  const stepOutputRefExpr = (varName: string | undefined, ref: { step: string; path?: string }): string => {
    if (!varName) {
      throw new Error(
        `Op "${config.name}": unresolved step-output reference to step "${ref.step}" — run \`chant build\` ` +
          "(TMP013) first; the serializer does not itself validate references.",
      );
    }
    return ref.path ? `${varName}?.${ref.path.split(".").join("?.")}` : varName;
  };

  // Render an args value as TypeScript source, substituting every
  // step-output reference (anywhere in the structure) with the captured
  // variable it resolves to. A JSON.stringify fast path handles the (much
  // more common) reference-free case.
  const argsSourceOf = (value: unknown): string => {
    if (isStepOutputRef(value)) return stepOutputRefExpr(varNameForStepId.get(value.step), value);
    if (Array.isArray(value)) return `[${value.map(argsSourceOf).join(",")}]`;
    if (value && typeof value === "object") {
      return `{${Object.entries(value)
        .map(([k, v]) => `${JSON.stringify(k)}:${argsSourceOf(v)}`)
        .join(",")}}`;
    }
    return JSON.stringify(value);
  };

  const argsOf = (step: ActivityStep): string => {
    if (!step.args || Object.keys(step.args).length === 0) return "{}";
    return collectStepOutputRefs(step.args).length > 0 ? argsSourceOf(step.args) : JSON.stringify(step.args);
  };

  // Record which variable a captured step's result landed in, keyed by the
  // step's authored `id`, so a later step's `argsOf` can resolve a
  // reference to it. A step with no `id` was never referenceable in the
  // first place (`validateStepOutputRefs` requires one), so there is
  // nothing to record.
  const recordCapture = (step: ActivityStep, varName: string) => {
    if (step.id) varNameForStepId.set(step.id, varName);
  };

  // A run of consecutive activity steps. In a sequential context each is
  // awaited in turn; in a parallel phase the run is a single Promise.all.
  const emitActivityRun = (run: ActivityStep[], out: string[], indent: string, parallel: boolean) => {
    if (parallel && run.length > 1) {
      // Capture results into an array if any step needs its result held —
      // an outcome attribute, or being referenced by a later step —
      // otherwise just await Promise.all without the destructure.
      const anyNeedsCapture = run.some(needsCapture);
      if (anyNeedsCapture) {
        const vars = run.map(() => nextResultVar());
        out.push(`${indent}const [${vars.join(", ")}] = await Promise.all([`);
        for (const step of run) {
          out.push(`${indent}  ${callee(step)}(${argsOf(step)}),`);
        }
        out.push(`${indent}]);`);
        for (let i = 0; i < run.length; i++) {
          recordCapture(run[i], vars[i]);
          const upsert = emitOutcomeUpsert(run[i], vars[i], indent);
          if (upsert) out.push(upsert);
        }
      } else {
        out.push(`${indent}await Promise.all([`);
        for (const step of run) {
          out.push(`${indent}  ${callee(step)}(${argsOf(step)}),`);
        }
        out.push(`${indent}]);`);
      }
      return;
    }
    for (const step of run) {
      if (needsCapture(step)) {
        const v = nextResultVar();
        out.push(`${indent}const ${v} = await ${callee(step)}(${argsOf(step)});`);
        recordCapture(step, v);
        const upsert = emitOutcomeUpsert(step, v, indent);
        if (upsert) out.push(upsert);
      } else {
        out.push(`${indent}await ${callee(step)}(${argsOf(step)});`);
      }
    }
  };

  const emitGate = (gateStep: GateStep, out: string[], indent: string) => {
    const varName = signalVarName(gateStep.signalName);
    const timeout = gateStep.timeout ?? "48h";
    if (gateStep.description) {
      out.push(`${indent}// Gate: ${gateStep.signalName} — ${gateStep.description}`);
    } else {
      out.push(`${indent}// Gate: ${gateStep.signalName}`);
    }
    out.push(`${indent}let ${varName}Cleared = false;`);
    // Capture the approver identity from the signal payload. It rides in
    // the signal event, so Temporal persists it in the workflow history
    // even though the workflow itself only needs the boolean to proceed.
    out.push(`${indent}let ${varName}Approver: string | undefined;`);
    out.push(`${indent}setHandler(${varName}, (arg) => { ${varName}Approver = arg?.approver; ${varName}Cleared = true; });`);
    out.push(`${indent}await condition(() => ${varName}Cleared, ${JSON.stringify(timeout)});`);
    // Surface the approver in a search attribute when the caller opted a
    // stack into one (config.searchAttributes contains "Approver"): only
    // then is the attribute guaranteed registered, so an unconditional
    // upsert can never break a gate on a cluster that never declared it.
    if (config.searchAttributes && "Approver" in config.searchAttributes) {
      out.push(`${indent}upsertSearchAttributes({ Approver: [${varName}Approver ?? "unknown"] });`);
    } else {
      out.push(`${indent}void ${varName}Approver;`);
    }
  };

  // Read-compare-run-write over an effect receipt (#1834). Receipt identity
  // and (when static) expectation ride as data; the nested steps render inside
  // the mismatch branch, and the receipt write is emitted last — the effect
  // step is the sole writer, on success (#1703 decision 3). A nested-step
  // failure throws out of the workflow before the write, leaving the receipt
  // stale so the next run re-proposes the effect.
  const emitEffect = (step: EffectStep, out: string[], indent: string) => {
    const v = nextEffectVar();
    out.push(`${indent}// Effect: ${step.receipt.name} (${step.receipt.effect}) — read-compare-run-write (#1834)`);
    if (step.description) out.push(`${indent}// ${step.description}`);
    const readArgs = JSON.stringify({
      receipt: step.receipt,
      ...(step.expectation !== undefined ? { expectation: step.expectation } : {}),
    });
    out.push(`${indent}const ${v} = await ${callee(RECEIPT_READ_STEP)}(${readArgs});`);
    out.push(`${indent}if (${v}.current === ${v}.expectation) {`);
    out.push(`${indent}  log.info(${JSON.stringify(`effect already applied: ${step.receipt.name}`)});`);
    out.push(`${indent}} else {`);
    renderSteps(step.steps, out, `${indent}  `, false);
    out.push(`${indent}  // Sole writer of the receipt — after every nested step succeeded, last (#1703).`);
    out.push(`${indent}  await ${callee(RECEIPT_WRITE_STEP)}({ receipt: ${JSON.stringify(step.receipt)}, expectation: ${v}.expectation });`);
    out.push(`${indent}}`);
  };

  // Walk the steps in authored order. A gate or effect step splits the
  // surrounding activities into separate runs, so [gate, activity] waits for
  // the gate before the activity runs (and [activity, gate] the other way
  // round) — the serializer never reorders what the author wrote (#1698).
  const renderSteps = (steps: StepDefinition[], out: string[], indent: string, parallel: boolean) => {
    let run: ActivityStep[] = [];
    const flush = () => {
      emitActivityRun(run, out, indent, parallel);
      run = [];
    };
    for (const step of steps) {
      if (isActivityStep(step)) {
        run.push(step);
        continue;
      }
      flush();
      if (isGateStep(step)) emitGate(step, out, indent);
      else if (isEffectStep(step)) emitEffect(step, out, indent);
    }
    flush();
  };

  const renderPhases = (phases: PhaseDefinition[]) => {
    for (const phase of phases) {
      if (phase.parallel && phase.steps.some(isEffectStep)) {
        throw new Error(
          `Op "${config.name}", phase "${phase.name}": an effect step cannot run in a ` +
            `parallel phase — read-compare-run-write is ordered`,
        );
      }
      const phaseLines: string[] = [];
      phaseLines.push(`  // Phase: ${phase.name}`);
      phaseLines.push(`  upsertSearchAttributes({ Phase: ${JSON.stringify([phase.name])} });`);

      renderSteps(phase.steps, phaseLines, "  ", phase.parallel ?? false);

      lines.push(...phaseLines);
      lines.push("");
    }
  };

  if (config.onFailure && config.onFailure.length > 0) {
    // Compensation must run ONLY on terminal failure, in reverse phase order,
    // and must never mask the original error — matching the local executor
    // (packages/core/src/op/local-executor.ts). Wrap the main phases in
    // try/catch; run onFailure phases reversed in the catch (best-effort), then
    // re-throw the original failure.
    lines.push("  try {");
    renderPhases(config.phases);
    lines.push("  } catch (__opErr) {");
    lines.push("    // onFailure compensation (reverse phase order, terminal failure only)");
    lines.push("    try {");
    renderPhases([...config.onFailure].reverse());
    lines.push("    } catch { /* best-effort compensation — never mask the original error */ }");
    lines.push("    throw __opErr;");
    lines.push("  }");
  } else {
    renderPhases(config.phases);
  }

  lines.push("}");
  lines.push("");

  return lines.join("\n");
}

// ── Activities re-export ──────────────────────────────────────────────────────

function generateActivities(): string {
  return [
    "// Generated by chant — do not edit directly.",
    "// Re-exports all pre-built activity implementations.",
    "export * from '@intentius/chant-lexicon-temporal/op/activities';",
    "",
  ].join("\n");
}

// ── Worker bootstrap ──────────────────────────────────────────────────────────

function generateWorker(config: OpConfig): string {
  return generateWorkerBootstrap({
    dir: "ops",
    name: config.name,
    taskQueue: config.taskQueue ?? config.name,
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

function getProps(entity: Declarable): Record<string, unknown> {
  if (isResourceDeclarable(entity) && typeof entity.props === "object" && entity.props !== null) {
    return entity.props as Record<string, unknown>;
  }
  return {};
}

/**
 * Serialize a map of Temporal::Op entities into generated file content.
 *
 * Returns a map of relative output paths → file content.
 * e.g. `{ "ops/alb-deploy/workflow.ts": "...", ... }`
 *
 * Throws if a `depends` reference names an Op that is not in the entity map.
 */
export function serializeOps(ops: Map<string, Declarable>): Record<string, string> {
  const knownNames = new Set<string>();

  // First pass: collect all names
  for (const [, entity] of ops) {
    const props = getProps(entity) as unknown as OpConfig;
    if (props.name) knownNames.add(props.name);
  }

  const files: Record<string, string> = {};

  for (const [, entity] of ops) {
    const config = getProps(entity) as unknown as OpConfig;

    if (!config.name) {
      throw new Error("Op entity missing required `name` field.");
    }

    // Validate depends
    for (const dep of config.depends ?? []) {
      if (!knownNames.has(dep)) {
        throw new Error(
          `Op "${config.name}" depends on unknown Op "${dep}". Known Ops: ${[...knownNames].join(", ")}`,
        );
      }
    }

    const dir = `ops/${config.name}`;
    files[`${dir}/workflow.ts`] = generateWorkflow(config);
    files[`${dir}/activities.ts`] = generateActivities();
    files[`${dir}/worker.ts`] = generateWorker(config);
  }

  return files;
}
