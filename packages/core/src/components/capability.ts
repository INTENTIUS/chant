/**
 * Capability contract — the typed leaf behavior components compose from.
 *
 * A capability is a verb ("docker-build", "cfn-deploy", "wait-steady-state"),
 * never a noun (never named after the component that happens to use it).
 * Registered once by `kind`, dispatched by the orchestrator, composed by an
 * unbounded number of components. See:
 * https://intentius.io/chant/components/capabilities/
 *
 * This module defines the interface and registry only. Verb implementations
 * live under `./verbs/*` as typed stubs — no cloud calls, no side effects.
 * Cloud implementations are a later phase (see epic #551, issue #554).
 */

import type { ReleaseIdentity } from "../telemetry-attribution";
import type { ChangeSetPart } from "../change-set";

/**
 * Ambient information a capability's `run`/`rollback` receives, independent of
 * its typed `input`. Deliberately minimal for this phase: the orchestrator
 * (interpret-mode driver, #556) will thread through the resolved environment,
 * a logger, and step-output wiring (`@Phase.output`) once it exists. Kept as
 * an extensible interface so a later phase can widen it without breaking the
 * `Capability` signature.
 */
export interface DeployContext {
  /** Target environment name (e.g. "dev", "staging", "prod"). */
  env: string;
  /** Component name this run belongs to, for logging/attribution. */
  component: string;
  /** Arbitrary environment config resolved by the orchestrator (registry URLs, cluster names, ...). */
  vars?: Record<string, unknown>;
  /**
   * The release this run deploys (#3061, ws-081): the commit, set by the
   * caller, and the digest of the artifact a publish step has promoted so
   * far in this component's run, set by the driver. A deploy step passes it
   * to the workload with `releaseEnvironment()`. Absent outside
   * `chant run --components`.
   */
  release?: ReleaseIdentity;
  /**
   * What this component's steps planned before its wave's gate was decided
   * (#3049), keyed by {@link CapabilityPlan.member}. Set by a gated-wave
   * fan-out and by a pull request's apply (#3183). A capability whose `run`
   * finds its own member here applies that plan, the one the approver
   * approved, instead of planning again. A `run` that finds the target moved
   * since that plan refuses with an error {@link isPlanMovedError} accepts
   * (#3997), and the command that applied it exits 3, as for a moved digest.
   */
  plans?: Record<string, unknown>;
  /**
   * What a step kept for a member in an earlier attempt at this same fan-out
   * (#3459), keyed by member: the value it last passed to {@link carry}. A
   * choudoufu root keeps choudoufu's wave resume file here, so the next
   * attempt hands choudoufu the file it wrote. Set by `chant components
   * fan-out --resume`; absent otherwise.
   */
  carried?: Record<string, unknown>;
  /**
   * Keep `value` for `member` in the fan-out's attempt record, replacing what
   * was kept before. The next attempt finds it in {@link carried}. Call it
   * before throwing, too: a failed root's state is what a retry needs most.
   * Absent outside a fan-out that writes a record.
   */
  carry?: (member: string, value: unknown) => void;
  /**
   * Set when a step is planned (#4084): the components or stacks whose
   * outputs this step's input reads through `stackOutput()` or
   * `@<component>.publish.*` and which had nothing to read yet, so the input
   * holds `undefined` there. Their values are known only when the run
   * applies them. A `plan` that needs them can say so instead of planning
   * against missing values.
   */
  unresolvedInputs?: string[];
}

/**
 * What a capability's `plan` produced (#3049): the member it planned, that
 * plan's digest, and whatever `run` needs to apply exactly that plan.
 */
export interface CapabilityPlan {
  /** The member's name in a wave's set digest. For a terraform-family step, the root. */
  member: string;
  /** The digest a gate on this member alone would bind (#2300). */
  planDigest: string;
  /** Handed back to `run` as `DeployContext.plans[member]`. Opaque to the runner. */
  artifact?: unknown;
  /**
   * The member's part of a change-set document (#3181): every change the
   * plan proposes. A pull request's plan (#3183) composes the parts into the
   * document whose grouped summary the PR note shows. Without it the member
   * still counts toward the digest, with no entries.
   */
  changeSet?: ChangeSetPart;
  /**
   * The outputs `run` will expose once it applies this plan (#3999), as far
   * as the plan can tell. A pull request's plan reads a dependent's
   * `stackOutput()` references into this member from here when both are in
   * the change, instead of from the outputs standing now. Absent when the
   * plan cannot say: every output of the step is then known only after it
   * applies.
   */
  outputs?: PlannedOutputs;
}

/**
 * What a plan says about the outputs its apply will leave (#3999). An
 * output named in neither field is known only after apply, the same as one
 * in `unknown`.
 */
export interface PlannedOutputs {
  /** Each output whose value the plan knows, by name: what `run` will expose. */
  known: Record<string, unknown>;
  /** Outputs the plan names whose value is known only after apply, sorted. */
  unknown: string[];
}

/**
 * A typed leaf behavior. `kind` is the verb string components reference in
 * their composition (`{ kind: "cfn-deploy", ... }`); `run` performs the
 * operation; `rollback` is the optional paired compensation the orchestrator
 * calls, in reverse step order, on saga unwind.
 *
 * Typed `In`/`Out` let a composition wire one step's output into the next
 * step's input (`imageRef: "@Publish.digest"`) and let lint check the wiring
 * before anything runs.
 */
export interface Capability<In = unknown, Out = unknown> {
  /** The verb this capability implements — e.g. "docker-build", "cfn-deploy". Never a component name. */
  readonly kind: string;
  /** Perform the operation. */
  run(ctx: DeployContext, input: In): Promise<Out>;
  /**
   * Optional paired compensation, invoked in reverse order on saga rollback.
   * `output`, when supplied, is the exact value this step's own `run()` call
   * returned (#1944, epic #1564 phase 4) — a serializable identity channel a
   * capability can use to recover state `rollback` needs when it cannot rely
   * on in-process object identity between its `run`/`rollback` calls. The
   * local interpret driver (../driver.ts) always threads it through; a
   * hosting runtime that splits a run across process boundaries threads it
   * across as plain JSON, which is exactly the case this exists for — see
   * ./verbs/run-agent.ts's "Rollback identity" doc
   * comment for the motivating gap (a fresh sprite's checkpoint id, recorded
   * only in an in-process `WeakMap` keyed by `run()`'s `input` object, never
   * survives to a `rollback()` call that runs as a separate Activity with its
   * own freshly-resolved `input`). Optional and additive: a capability that
   * never needs it (most of them) simply ignores the third parameter.
   */
  rollback?(ctx: DeployContext, input: In, output?: Out): Promise<void>;
  /**
   * Optional: say what `run` would change, without changing it (#3049). A
   * gated-wave fan-out calls this for every step of every component in a
   * wave, once the waves before it have applied, and binds the wave's gate
   * to the set digest of the results. `run` then receives the result's
   * `artifact` through `DeployContext.plans`. A capability without `plan`
   * is covered by its component's composition digest instead.
   */
  plan?(ctx: DeployContext, input: In): Promise<CapabilityPlan>;
  /**
   * Optional: the outputs `run` exposed when it last ran, read without
   * changing anything (#3183). A pull request's plan reads them for each
   * component a planned one depends on that the change does not plan
   * (#4104), so a `stackOutput()` wiring resolves to the value standing now.
   * A dependency the change plans is read from its plan's
   * {@link CapabilityPlan.outputs} instead (#3999). The shape is `run`'s
   * `outputs` field.
   */
  outputs?(ctx: DeployContext, input: In): Promise<Record<string, unknown>>;
  /**
   * How this verb relates to rollback, for the COMP003 composition check.
   * Usually derivable and left unset: a capability with a `rollback` method is
   * treated as `"native"`, everything else as `"none-by-design"` (build/publish/
   * wait — nothing to compensate). Set it explicitly to `"needs-opt-out"` on a
   * *mutating* verb that has no rollback and no safe undo (e.g. `s3-sync`,
   * `run-migration`), so COMP003 requires the component to acknowledge the
   * compensation gap. See ../lint/rules/comp/comp003-mutating-no-rollback.ts.
   */
  readonly rollbackPolicy?: RollbackPolicy;
}

/** A capability's relationship to rollback — see `Capability.rollbackPolicy`. */
export type RollbackPolicy = "native" | "none-by-design" | "needs-opt-out";

/** Extract a capability's `In` type. */
export type CapabilityInput<C> = C extends Capability<infer In, unknown> ? In : never;
/** Extract a capability's `Out` type. */
export type CapabilityOutput<C> = C extends Capability<unknown, infer Out> ? Out : never;

/**
 * The exit code of a command whose capability step refused a plan that moved
 * since it was approved: 3, the code `pr-apply` gives a moved digest and a
 * run gives a gate (#3997).
 */
export const PLAN_MOVED_EXIT_CODE = 3;

/**
 * Whether `err` is a `run`'s refusal to apply a plan from
 * `DeployContext.plans` because the target moved since it was planned
 * (#3997). The mark is a `planMoved: true` property, not a class, so a
 * lexicon built against an older core can set it. An `exitCode` of
 * {@link PLAN_MOVED_EXIT_CODE} on the error is the same mark. Any other
 * `exitCode` is ignored: a failed step exits 1, so a capability can't pick
 * the process's exit code.
 */
export function isPlanMovedError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { planMoved?: unknown; exitCode?: unknown };
  return e.planMoved === true || e.exitCode === PLAN_MOVED_EXIT_CODE;
}

/**
 * Thrown by a stub `run`/`rollback` — the verb is specified and typed but has
 * no cloud implementation yet. Distinguishes "not implemented" from a runtime
 * failure so callers (and tests) can assert on it specifically.
 */
export class CapabilityNotImplementedError extends Error {
  constructor(public readonly kind: string) {
    super(`capability "${kind}" is not implemented`);
    this.name = "CapabilityNotImplementedError";
  }
}

/**
 * Resolves capabilities by `kind`. One registry instance is the composition
 * root the orchestrator dispatches through; `createCapabilityRegistry` builds
 * one pre-seeded with the starter verb set (see `./verbs`).
 */
export class CapabilityRegistry {
  private readonly capabilities = new Map<string, Capability<never, unknown>>();

  /** Register a capability. Throws if `kind` is already registered — a capability is a verb, registered once. */
  register<In, Out>(capability: Capability<In, Out>): this {
    if (this.capabilities.has(capability.kind)) {
      throw new Error(`capability "${capability.kind}" is already registered`);
    }
    this.capabilities.set(capability.kind, capability as Capability<never, unknown>);
    return this;
  }

  /** Resolve a capability by `kind`. Throws a friendly error listing known kinds if absent. */
  resolve(kind: string): Capability<never, unknown> {
    const capability = this.capabilities.get(kind);
    if (!capability) {
      const known = [...this.capabilities.keys()].sort().join(", ");
      throw new Error(`no capability registered for kind "${kind}" (known: ${known})`);
    }
    return capability;
  }

  /** True if a capability is registered for `kind`. */
  has(kind: string): boolean {
    return this.capabilities.has(kind);
  }

  /** All registered kinds, sorted. */
  kinds(): string[] {
    return [...this.capabilities.keys()].sort();
  }
}
