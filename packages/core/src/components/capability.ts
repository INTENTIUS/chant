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
   * local interpret driver (../driver.ts) always threads it through; the
   * durable Temporal path (lexicons/temporal/src/component-op/*.ts) threads
   * it across the Activity boundary as plain JSON, which is exactly the case
   * this exists for — see ./verbs/run-agent.ts's "Rollback identity" doc
   * comment for the motivating gap (a fresh sprite's checkpoint id, recorded
   * only in an in-process `WeakMap` keyed by `run()`'s `input` object, never
   * survives to a `rollback()` call that runs as a separate Activity with its
   * own freshly-resolved `input`). Optional and additive: a capability that
   * never needs it (most of them) simply ignores the third parameter.
   */
  rollback?(ctx: DeployContext, input: In, output?: Out): Promise<void>;
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
