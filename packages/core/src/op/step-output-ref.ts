/**
 * Step-output references — chant #1290 ("A step cannot reference a prior
 * step's output, so values leave an Op only as search attributes").
 *
 * An Op's steps run in a fixed sequence chant already knows: phases in
 * order, and (within a non-parallel phase) steps in order. Today the only
 * way a value escapes a step is `outcomeAttribute`, which stringifies it
 * into a Temporal search attribute — a UI filter, not something a later
 * step can consume. `StepOutputRef` is the mechanism that lets a later
 * step's `args` hold a *reference* to an earlier step's declared return
 * value instead.
 *
 * Deliberately a reference, not an expression: `diff.out.driftedStacks` is
 * a value placeholder the build resolves and the serializer compiles into a
 * real local variable in the generated workflow — never `diff.out.count >
 * 0` or a `.map()` over a reference. That property (an Op is data you can
 * read and know what it does, not a program) is exactly what makes it safe
 * to add this without Ops becoming programs; see the issue's "line not to
 * cross".
 *
 * Scope, kept deliberately tight (see the issue's "Open questions"):
 *  - same-Op only — no cross-Op plumbing (that needs a durable place to put
 *    the value, which #1290 explicitly defers).
 *  - main `phases` only — a step inside `onFailure` or nested inside an
 *    `EffectStep` can neither produce nor consume a step-output reference.
 *    `onFailure` compensation runs only when something upstream already
 *    failed, so a main-phase step's captured result isn't reliably
 *    available there; an effect step's nested steps run only when the
 *    receipt comparison mismatches, so a value it produces isn't reliably
 *    available to anything outside it either. Both are conditional
 *    execution paths, which is exactly the class of thing #1290 keeps out
 *    of an Op's inert-data model.
 *  - producer must run to completion before the consumer starts: an earlier
 *    phase, or an earlier step within the same non-parallel phase. Two
 *    steps in the same parallel phase run concurrently (`Promise.all`) with
 *    no ordering guarantee, so neither may reference the other.
 *  - the producer needs a registered `ActivityContract` with a `returns`
 *    schema — without one there is nothing to validate the reference
 *    against, and it degrades into the same stringly path `outcomeAttribute`
 *    already had (chant #1288 comment on this issue).
 *
 * References only, no expressions: the issue asks for this to be "enforced
 * by a lint rule rather than left as a convention." What's here instead is
 * a runtime-on-load guard — `diff.out.count > 0` or a template literal over
 * a reference coerces it to a primitive, and the reference throws when that
 * happens, at the moment chant loads the `.op.ts` module to build the
 * entity graph (i.e. still before anything runs). A real static lint rule
 * would need to parse-inspect the author's TypeScript for expression syntax
 * around a reference — a genuine ESLint-rule-shaped feature, and a bigger
 * one than this issue's scope. The coercion guard catches the same misuse
 * (arithmetic, comparisons, template literals, `String(...)`) without it;
 * a `.map()`-style structural misuse already throws on its own (`StepOutputRef`
 * has no array methods).
 */

import { z } from "zod";
import type { ActivityStep, OpConfig, PhaseDefinition } from "./types";
import { pathExistsInSchema, type ActivityContract, type ActivityContractIssue } from "./activity-contract";

const STEP_OUTPUT_REF_BRAND = Symbol.for("chant.op.stepOutputRef");

/**
 * A typed reference to a prior step's declared return value. Inert by
 * construction — it carries a producer step id and an optional dot-path
 * into that producer's return schema, resolved by `chant build`
 * (`validateStepOutputRefs`) and compiled by the temporal serializer into a
 * local variable holding the awaited activity result.
 */
export interface StepOutputRef {
  readonly [STEP_OUTPUT_REF_BRAND]: true;
  readonly kind: "step-output-ref";
  /** `ActivityStep.id` of the producing step. */
  readonly step: string;
  /**
   * Dot-path into the producer's declared return value (e.g.
   * `"driftedStacks"`, `"result.healthy"`). Omitted references the whole
   * return value.
   */
  readonly path?: string;
}

/** Structural guard for a value produced by {@link stepOutput} (or `activity()`'s `.out`). */
export function isStepOutputRef(value: unknown): value is StepOutputRef {
  return typeof value === "object" && value !== null && (value as Record<symbol, unknown>)[STEP_OUTPUT_REF_BRAND] === true;
}

function makeStepOutputRef(step: string, path?: string): StepOutputRef {
  const ref = { [STEP_OUTPUT_REF_BRAND]: true, kind: "step-output-ref", step, ...(path ? { path } : {}) } as StepOutputRef;
  // References only, no expressions (see module doc): coercing a reference
  // to a primitive — `diff.out.count > 0`, `` `${diff.out.name}` ``,
  // `String(diff.out.x)` — is exactly the "Op becomes a program" failure
  // mode the issue calls out, so it throws immediately on load instead of
  // silently producing a wrong value (NaN comparisons, "[object Object]").
  const rejectExpression = (): never => {
    throw new Error(
      `step-output reference (step "${step}"${path ? `, path "${path}"` : ""}) was coerced to a primitive — ` +
        "references only, no expressions: use it as a plain arg value, never inside a comparison, arithmetic, or template literal.",
    );
  };
  Object.defineProperty(ref, Symbol.toPrimitive, { value: rejectExpression, enumerable: false });
  Object.defineProperty(ref, "toString", { value: rejectExpression, enumerable: false });
  Object.defineProperty(ref, "valueOf", { value: rejectExpression, enumerable: false });
  return ref;
}

/**
 * Reference a named step's output from a later step's `args`. Works with
 * any step that has an `id` — an `activity()` builder result (which also
 * gets the `.out` proxy sugar below) or a plain `{ kind: "activity", ...,
 * id: "..." }` object literal, the shape composites author directly.
 *
 * `stepOutput(diff, "driftedStacks")` and `diff.out.driftedStacks` produce
 * an identical reference; `stepOutput` is the explicit form for authors who
 * build steps as object literals, or whose return schema has a top-level
 * field literally named `step`, `path`, or `kind` (the `.out` proxy
 * reserves those three property names for its own introspection).
 */
export function stepOutput(step: string | Pick<ActivityStep, "id">, path?: string): StepOutputRef {
  const id = typeof step === "string" ? step : step.id;
  if (!id) {
    throw new Error(
      "stepOutput(): the step has no `id` — pass one via activity(fn, args, { id: \"...\" }) or set `id` on the step object literal first.",
    );
  }
  return makeStepOutputRef(id, path);
}

/**
 * `.out` proxy attached to `activity()`'s result: `diff.out.driftedStacks`
 * builds a {@link StepOutputRef} without the explicit `stepOutput()` call.
 *
 * A single property-access level, matching `outcomeAttribute.from`'s
 * existing convention — the property name IS the dot-path, so a nested
 * field is `diff.out["result.healthy"]`, not `diff.out.result.healthy`.
 * `kind`, `step`, and `path` are reserved (the ref's own introspection
 * fields); a return schema with a top-level field by one of those names
 * needs `stepOutput(diff, "step")` instead.
 */
export function makeOutProxy(stepId: string): Record<string, StepOutputRef> {
  const whole = makeStepOutputRef(stepId);
  return new Proxy(whole as unknown as Record<string, StepOutputRef>, {
    get(target, prop, receiver) {
      if (typeof prop === "symbol" || prop === "kind" || prop === "step" || prop === "path" || prop === "toString" || prop === "valueOf") {
        return Reflect.get(target, prop, receiver);
      }
      return makeStepOutputRef(stepId, prop);
    },
  });
}

/** Every {@link StepOutputRef} found anywhere inside `value` (recursing through plain objects and arrays). */
export function collectStepOutputRefs(value: unknown): StepOutputRef[] {
  if (isStepOutputRef(value)) return [value];
  if (Array.isArray(value)) return value.flatMap(collectStepOutputRefs);
  if (value && typeof value === "object") return Object.values(value).flatMap(collectStepOutputRefs);
  return [];
}

// ── Validation ──────────────────────────────────────────────────────────────

interface StepLocation {
  phaseIndex: number;
  stepIndex: number;
  parallel: boolean;
  step: ActivityStep;
}

/** Top-level `ActivityStep`s of `phases`, in authored (phase, then step) order — gates, effects, and steps nested inside an effect are not producers or consumers (see the module doc's scope note). */
function locateActivitySteps(phases: PhaseDefinition[]): StepLocation[] {
  const locations: StepLocation[] = [];
  phases.forEach((phase, phaseIndex) => {
    let stepIndex = 0;
    for (const step of phase.steps) {
      if (step.kind !== "activity") continue;
      locations.push({ phaseIndex, stepIndex, parallel: phase.parallel === true, step });
      stepIndex++;
    }
  });
  return locations;
}

/** True when `producer` is guaranteed to have completed before `consumer` starts. */
function producerPrecedes(producer: StepLocation, consumer: StepLocation): boolean {
  if (producer.phaseIndex !== consumer.phaseIndex) return producer.phaseIndex < consumer.phaseIndex;
  if (producer.parallel) return false; // same parallel phase — Promise.all, no ordering guarantee
  return producer.stepIndex < consumer.stepIndex;
}

/**
 * Validate every step-output reference in an Op's main phases against a
 * contract map and the Op's own step ordering. Scope: `config.phases` only
 * (never `onFailure`, never a step nested inside an `EffectStep` — see the
 * module doc).
 *
 * Flags:
 *  - a reference authored inside `onFailure`, or inside an `EffectStep`'s
 *    nested steps — out of scope by design (see the module doc); flagged
 *    explicitly here rather than left to fall through as "unknown producer",
 *  - a reference to an unregistered step id (no step in scope declares it),
 *  - a duplicate step id (ambiguous producer),
 *  - a reference to a step that does not precede the referencing step
 *    (a later phase, a later step in the same phase, itself, or a step in
 *    the same parallel phase),
 *  - a reference into a step whose `fn` has no registered
 *    {@link ActivityContract}, or whose contract declares no `returns`
 *    schema — nothing to validate the reference against,
 *  - a `path` that does not resolve on the producer's declared return
 *    schema (an empty `path` — the whole return value — is always valid).
 */
export function validateStepOutputRefs(
  config: Pick<OpConfig, "name" | "phases" | "onFailure">,
  contracts: ReadonlyMap<string, ActivityContract>,
): ActivityContractIssue[] {
  const issues: ActivityContractIssue[] = [];

  const flagOutOfScope = (steps: ActivityStep[], phaseName: string, reason: string) => {
    for (const step of steps) {
      for (const ref of collectStepOutputRefs(step.args)) {
        issues.push({
          opName: config.name,
          phase: phaseName,
          fn: step.fn,
          message: `references step "${ref.step}"'s output, but ${reason}`,
        });
      }
    }
  };
  const effectNestedActivitySteps = (phase: PhaseDefinition): ActivityStep[] =>
    phase.steps.flatMap((s) => (s.kind === "effect" ? s.steps.filter((n) => n.kind === "activity") : []));
  for (const phase of config.onFailure ?? []) {
    const steps = phase.steps.filter((s): s is ActivityStep => s.kind === "activity").concat(effectNestedActivitySteps(phase));
    flagOutOfScope(steps, phase.name, "step-output references are not supported in onFailure compensation phases");
  }
  for (const phase of config.phases) {
    flagOutOfScope(effectNestedActivitySteps(phase), phase.name, "step-output references are not supported for a step nested inside an effect step");
  }

  const locations = locateActivitySteps(config.phases);

  const byId = new Map<string, StepLocation>();
  const duplicateIds = new Set<string>();
  for (const loc of locations) {
    if (!loc.step.id) continue;
    if (byId.has(loc.step.id)) duplicateIds.add(loc.step.id);
    else byId.set(loc.step.id, loc);
  }

  const phaseNameOf = (loc: StepLocation): string => config.phases[loc.phaseIndex]!.name;

  for (const consumer of locations) {
    const refs = collectStepOutputRefs(consumer.step.args);
    for (const ref of refs) {
      if (duplicateIds.has(ref.step)) {
        issues.push({
          opName: config.name,
          phase: phaseNameOf(consumer),
          fn: consumer.step.fn,
          message: `references step id "${ref.step}", but that id is used by more than one step in this Op — ids must be unique`,
        });
        continue;
      }

      const producer = byId.get(ref.step);
      if (!producer) {
        issues.push({
          opName: config.name,
          phase: phaseNameOf(consumer),
          fn: consumer.step.fn,
          message: `references unknown step id "${ref.step}" — no step in this Op's main phases declares that id`,
        });
        continue;
      }

      if (!producerPrecedes(producer, consumer)) {
        const reason =
          producer.phaseIndex > consumer.phaseIndex
            ? `step "${ref.step}" is in a later phase`
            : producer.parallel
              ? `step "${ref.step}" is in the same parallel phase (steps there run concurrently, with no ordering guarantee)`
              : `step "${ref.step}" does not run before this step`;
        issues.push({
          opName: config.name,
          phase: phaseNameOf(consumer),
          fn: consumer.step.fn,
          message: `references ${reason} — a step can only reference an earlier step's output`,
        });
        continue;
      }

      const producerContract = contracts.get(producer.step.fn);
      if (!producerContract) {
        issues.push({
          opName: config.name,
          phase: phaseNameOf(consumer),
          fn: consumer.step.fn,
          message: `references step "${ref.step}"'s output, but "${producer.step.fn}" has no registered activity contract to validate the reference against`,
        });
        continue;
      }
      if (!producerContract.returns) {
        issues.push({
          opName: config.name,
          phase: phaseNameOf(consumer),
          fn: consumer.step.fn,
          message: `references step "${ref.step}"'s output, but "${producer.step.fn}"'s contract declares no return schema`,
        });
        continue;
      }
      if (ref.path && !pathExistsInSchema(producerContract.returns as z.ZodTypeAny, ref.path)) {
        issues.push({
          opName: config.name,
          phase: phaseNameOf(consumer),
          fn: consumer.step.fn,
          message: `references step "${ref.step}"'s output path "${ref.path}", which does not exist on "${producer.step.fn}"'s declared return type`,
        });
      }
    }
  }

  return issues;
}
