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

import type { PlanShape } from "./covered-round";
import { CHANT_EXIT } from "../exit-codes";
import type { ReleaseIdentity } from "../telemetry-attribution";
import type { ChangeSetPart } from "../change-set";
import type { DeployAdoption } from "./adoption";
import type { LockGrain, LockRow } from "../lifecycle/lock-rows";

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
  /**
   * The addresses this component's steps narrow to (#4300), from
   * `--target <component>:<address>`, sorted. A step's `plan` plans only
   * these, and its `run` applies only these. Every capability step of the
   * component must accept targets ({@link Capability.targets}), or the
   * component refuses before anything plans or runs. Absent: the whole step.
   */
  targets?: string[];
  /**
   * `--adopt <adoption-file>` (#4537): the resources to adopt into this
   * component's stack, the index version they come from, and the review
   * every change set the adoption makes goes through before it executes. A
   * deploy step that can adopt takes it by setting `outcome`; a step that
   * cannot ignores it, and the command refuses a run no step took it in.
   * Absent: a plain deploy. See ./adoption.ts.
   */
  adoption?: DeployAdoption;
  /**
   * The member's `ci.lockGrain` (#4552), read from the declaration at base
   * by the caller: the member's own, else the workspace's. Absent when
   * neither sets one, and then the capability's `defaultLockGrain` holds. A
   * step input's own grain (`pulumi-up`'s `lockGrain`) wins over it.
   */
  lockGrain?: LockGrain;
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
  /**
   * The targets this plan narrowed to (#4300), sorted. A plan made with
   * `DeployContext.targets` gives them back, which says it planned only
   * those. Planning binds them into the member's digest
   * ({@link targetedPlanDigest} in ./wave-plan.ts), so an approval of a
   * targeted plan covers that plan and no other.
   */
  targets?: string[];
  /**
   * What the plan does, without values (#4419): the resources it touches,
   * their actions and replacement, and the inputs it was made without. A
   * pull request's apply compares the shape of a plan made after an upstream
   * applied with this one (`coveredRound`) to decide whether the first
   * approval covers it. Absent, core derives the shape from `changeSet`.
   */
  shape?: PlanShape;
  /**
   * The engine's own reasons the plan is destructive (#4569), sorted, when it
   * classes more as destructive than a delete or replace in the change set
   * (a Postgres table rewrite, a revoke, a ClickHouse mutation). An op wave
   * counts a plan that names any as destructive, which `on-destructive`
   * waits on. Absent or empty: the change set alone decides.
   */
  destructive?: string[];
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
   * Optional (#4552): the lock grain a member of this kind takes when
   * `ci.lockGrain` sets none. `plan`, when given, is the member's plan. Absent:
   * `target`. The terraform lexicon answers `resource` for choudoufu and
   * `target` for Terraform, tofu and Terragrunt; the pulumi lexicon
   * `resource` for plunge and `target` for stock Pulumi.
   */
  defaultLockGrain?(input: In, plan?: CapabilityPlan): LockGrain | Promise<LockGrain>;
  /**
   * Optional (#4552): why this member cannot take `grain`, or undefined when
   * it can. A refusal names the engine, and stops the plan.
   */
  lockGrainRefusal?(input: In, grain: LockGrain, plan?: CapabilityPlan): string | undefined | Promise<string | undefined>;
  /**
   * Optional (#4552): the rows an apply of `plan` holds on the resource
   * grain, one per changed resource, keyed as the lexicon keys them (see
   * ../lifecycle/lock-rows.ts). Absent: the resource grain is refused.
   */
  lockRows?(input: In, plan: CapabilityPlan): LockRow[] | Promise<LockRow[]>;
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
  /**
   * Whether this verb narrows to `DeployContext.targets` (#4300). `"accept"`:
   * its `plan` and `run` act on the targets alone, and its plan gives them
   * back in {@link CapabilityPlan.targets}. `{ refuse }`: it can't, and says
   * why. Unset refuses too, with a reason that names the verb.
   */
  readonly targets?: TargetSupport;
  /**
   * Optional (#4435, ws-107): why this capability will not plan and apply
   * `members` as one group, or `undefined` when it will. Core asks before
   * anything is planned, so the answer must come from the declaration and
   * the files alone, never from a plan. A fallback with
   * {@link GroupFallback.drop} leaves only those members out: core forms
   * the group again from the rest and asks again (#4419 ruling 1). A
   * capability with `planGroup` and no `groupFallback` takes every group
   * core forms.
   */
  groupFallback?(ctx: GroupContext, members: readonly GroupMember<In>[]): Promise<GroupFallback | undefined>;
  /**
   * Optional (#4447): reads between this capability's components that core
   * cannot see in their declarations, such as a Terraform root's
   * `terraform_remote_state` block. Core asks once per capability, before
   * groups form, with every component of the change whose step this
   * capability takes (`ctx.components` in plan order, no `input`), and adds
   * each read to the reads it joins, orders and splits groups by, and to
   * the group reads the report names. The answer must come from the
   * declaration and the files alone. A read naming a component outside
   * `members` is ignored; a throw counts as no reads.
   */
  groupReads?(ctx: GroupContext, members: readonly GroupMember<In>[]): Promise<ReportedGroupRead[]>;
  /**
   * Optional (#4466): reads between this capability's steps that sit in the
   * files a step names rather than in its wiring, such as a CloudFormation
   * template's `Fn::ImportValue` of an export another stack's template
   * declares. Core asks once, after discovery and before the order is
   * derived, with every step of this kind in the project. Each read becomes
   * a `stackOutput()` reference at {@link DeclaredRead.at} in the reader's
   * step and a `dependsOn` on the upstream, so it orders the reader after
   * the upstream, is listed under `unknownInputs` while the upstream's plan
   * cannot say the value, and holds the reader for a round, like a read the
   * declaration states. A place the declaration already fills is left as it
   * is. The answer must come from the declaration and the files alone; a
   * throw counts as no reads.
   */
  declaredReads?(ctx: DeclaredReadsContext, members: readonly DeclaredReadMember[]): Promise<DeclaredRead[]> | DeclaredRead[];
  /**
   * Optional (#4542): the local files a step deploys from when its input
   * names them indirectly, as `terraform-apply` names a root by key. A
   * release cut records them for the step's component, with their paths
   * from the member's directory kept, and a promote or rollback under that
   * release writes them under `.chant/release-templates/<digest>/` and sets
   * the step's {@link ReleaseInputs.field} to the recorded copy of
   * {@link ReleaseInputs.dir}, so the step plans the release's files. Null
   * when the step deploys nothing local; {@link ReleaseInputsUnbound} when
   * its files can't be deployed from a copy, which the cut prints.
   */
  releaseInputs?(input: In, ctx: ReleaseInputsContext): Promise<ReleaseInputs | ReleaseInputsUnbound | null> | ReleaseInputs | ReleaseInputsUnbound | null;
  /**
   * Optional (#4435, ws-107): plan `members` as one, in one call. Declared
   * together with `runGroup`; a capability with only one of the two never
   * gets a group. Throwing makes every member plan-failed.
   */
  planGroup?(ctx: GroupContext, members: readonly GroupMember<In>[]): Promise<CapabilityGroupPlan>;
  /**
   * Optional (#4435, ws-107): apply the group `planGroup` planned, in one
   * call, and say how each member's part ended. It should not throw: a throw
   * reads as every member `failed`, or every member `not-started` when the
   * error is a moved plan ({@link isPlanMovedError}).
   */
  runGroup?(ctx: GroupContext, run: GroupRun, members: readonly GroupMember<In>[]): Promise<CapabilityGroupOutcome>;
}

/**
 * What a group's calls share (ws-107): the run's environment and variables,
 * and the group's components in apply order. Each member's own context is
 * {@link GroupMember.ctx}.
 */
export interface GroupContext {
  env: string;
  vars?: Record<string, unknown>;
  /** The group's components, upstreams first. */
  components: string[];
}

/**
 * A read of one group member's output by another (ws-107). Core leaves the
 * value out of the reader's `input` (it is `undefined` at `at`) and the
 * capability wires it inside its own apply.
 */
export interface GroupRead {
  /** Where in the reader's step input the value goes, as a JSON Pointer. */
  at: string;
  /** `<component>.<output>`, as `PrMember.reads` and `unknownInputs` name it. */
  ref: string;
  /** The member whose output it is. */
  component: string;
  output: string;
}

/**
 * A read of one component by another that a capability reports through
 * `groupReads` (#4447), with no place in the reader's step input.
 */
export interface ReportedGroupRead {
  /** The component that reads. */
  reader: string;
  /** The component whose output it reads. */
  upstream: string;
  /** The read as the report names it, e.g. `data.terraform_remote_state.network`. */
  ref: string;
  /**
   * The upstream output read, when the capability knows it. Without it the
   * read counts as known at plan only when the upstream's plan knows every
   * output it names.
   */
  output?: string;
}

/** What `releaseInputs` is asked with (#4542). */
export interface ReleaseInputsContext {
  /** The member's directory, which the answer's paths are relative to. */
  memberDir: string;
}

/** The files a step deploys from (#4542), each relative to the member's directory. */
export interface ReleaseInputs {
  /** The step field a promote under a release sets to the recorded copy of {@link dir}. */
  field: string;
  /** The directory the step runs in. One of {@link paths}. */
  dir: string;
  /** Every directory and file the step reads, {@link dir} included. */
  paths: string[];
}

/** A step whose files a release can't deploy from a copy (#4542), and why. */
export interface ReleaseInputsUnbound {
  unbound: string;
}

/** What `declaredReads` is asked with (#4466). */
export interface DeclaredReadsContext {
  /** The project root, which a step's relative file paths are read against. */
  root: string;
}

/** One step a capability's `declaredReads` is asked about (#4466). */
export interface DeclaredReadMember {
  component: string;
  /** Which of the component's steps of this kind, counting from 0 in declaration order. */
  index: number;
  /** The step as declared, without `kind`, wiring unresolved. */
  step: Record<string, unknown>;
}

/**
 * A read `declaredReads` found (#4466): `reader`'s step `index` reads
 * `upstream`'s output `output`. Core puts `{ stackOutput: { stack:
 * upstream, name: output } }` at `at` in that step, so the read is named
 * `<upstream>.<output>` wherever reads are.
 */
export interface DeclaredRead {
  reader: string;
  /** The reader's step, as {@link DeclaredReadMember.index}. Default 0. */
  index?: number;
  upstream: string;
  output: string;
  /** Where in the reader's step the reference goes, as a JSON Pointer. */
  at: string;
}

/** One component of a group, as core hands it to the capability (ws-107). */
export interface GroupMember<In = unknown> {
  component: string;
  /** The component's one step as declared, without `kind`, wiring unresolved. */
  step: Record<string, unknown>;
  /**
   * The step's input resolved against the outputs from outside the group.
   * Each {@link GroupRead} is `undefined` here. Absent in `groupFallback`,
   * which is asked before any output is read.
   */
  input?: In;
  /** The member's reads of other members, sorted by `ref`. */
  reads: GroupRead[];
  /**
   * The component's `dependsOn` as declared (#4447): an order with no read,
   * which a capability that applies the group in one call has to keep or
   * refuse.
   */
  dependsOn?: string[];
  /**
   * The member's own context: `component`, `targets`, `carried` and `carry`
   * as for a single step. `unresolvedInputs` names only components outside
   * the group. In `runGroup`, `plans` holds this member's plan.
   */
  ctx: DeployContext;
}

/**
 * Why a set of components does not run as one group (ws-107). `kind` is a
 * short stable word the report keys on; `reason` is one line for a person.
 * Core's own kinds are `steps`, `split` and `cycle`; a capability names its
 * own. A capability's `off` is recorded and not printed in the note.
 *
 * Without `drop`, the fallback is every member's and the group dissolves.
 * With `drop`, only the members it names leave, each with its own `kind`
 * and `reason` or else the fallback's; core forms the group again from the
 * rest by its own rules (`split`, `steps`, `cycle`, and a set of one is no
 * group) and asks again for each set that changed (#4419 ruling 1). A
 * `drop` that names no member of the group dissolves it.
 */
export interface GroupFallback {
  kind: string;
  reason: string;
  /** The members to leave out, when not the whole group. */
  drop?: GroupDrop[];
}

/** A member a {@link GroupFallback} leaves out of its group (#4419 ruling 1). */
export interface GroupDrop {
  component: string;
  /** Default: the fallback's `kind`. */
  kind?: string;
  /** Default: the fallback's `reason`. */
  reason?: string;
}

/** What `planGroup` returns (ws-107). */
export interface CapabilityGroupPlan {
  /**
   * One plan per member, by component: what `plan` would give for that
   * member, with `planDigest` before the group is folded in. Core folds the
   * group digest into each `planDigest` and its change-set part. `artifact`
   * on these is ignored; the group's artifact is below.
   */
  members: Record<string, CapabilityPlan>;
  /** The capability's digest of what the group adds to its members' plans. */
  digest: string;
  /** Handed back to `runGroup` in {@link GroupRun}. Core never reads it. */
  artifact?: unknown;
}

/** What core hands `runGroup` (ws-107): the plan that was approved. */
export interface GroupRun {
  artifact?: unknown;
  /** The group digest core bound: the capability's digest with the members folded in. */
  digest: string;
  /** Each member's plan as bound into the change set, by component. */
  plans: Record<string, CapabilityPlan>;
}

/**
 * How one member's part of a group apply ended (ws-107). `partial`: some of
 * its planned changes applied. `not-started`: the apply stopped before its
 * part began. `no-changes`: it planned none.
 */
export type GroupMemberStatus = "applied" | "partial" | "failed" | "not-started" | "no-changes";

export interface GroupMemberOutcome {
  status: GroupMemberStatus;
  /** What the member exposes now, as `run`'s outputs: set for `applied` and `no-changes`. */
  outputs?: Record<string, unknown>;
  error?: string;
}

/** What `runGroup` returns (ws-107): every member's outcome, by component. */
export interface CapabilityGroupOutcome {
  members: Record<string, GroupMemberOutcome>;
  /** An error no member's part names. */
  error?: string;
}

/** A capability's relationship to rollback — see `Capability.rollbackPolicy`. */
export type RollbackPolicy = "native" | "none-by-design" | "needs-opt-out";

/** Whether a capability accepts `DeployContext.targets` (#4300). See `Capability.targets`. */
export type TargetSupport = "accept" | { refuse: string };

/**
 * A component was asked to narrow to targets (#4300) and one of its steps'
 * capabilities refuses them. Nothing in the component plans or runs.
 */
export class TargetsRefusedError extends Error {
  constructor(
    readonly component: string,
    readonly kind: string,
    readonly reason: string,
  ) {
    super(`component "${component}": ${kind} refuses targets: ${reason}`);
    this.name = "TargetsRefusedError";
  }
}

/** Why `capability` refuses targets, or `undefined` when it accepts them (#4300). */
export function targetRefusal(capability: Pick<Capability<never, unknown>, "kind" | "targets">): string | undefined {
  const t = capability.targets;
  if (t === "accept") return undefined;
  if (t && typeof t === "object" && typeof t.refuse === "string") return t.refuse;
  return `${capability.kind} does not say it can narrow to targets`;
}

/** Extract a capability's `In` type. */
export type CapabilityInput<C> = C extends Capability<infer In, unknown> ? In : never;
/** Extract a capability's `Out` type. */
export type CapabilityOutput<C> = C extends Capability<unknown, infer Out> ? Out : never;

/**
 * The exit code of a command whose capability step refused a plan that moved
 * since it was approved: `CHANT_EXIT.moved`, 4, the code `pr-apply` gives a
 * moved digest (#3997, #4553). Before #4553 it was 3, a gate's code.
 */
export const PLAN_MOVED_EXIT_CODE = CHANT_EXIT.moved;

/**
 * The moved-plan code before #4553. A lexicon built against an older core
 * may still set it on the error it throws for a moved plan; read for one
 * release, then dropped.
 */
const LEGACY_PLAN_MOVED_EXIT_CODE = 3;

/**
 * Whether `err` is a `run`'s refusal to apply a plan from
 * `DeployContext.plans` because the target moved since it was planned
 * (#3997). The mark is a `planMoved: true` property, not a class, so a
 * lexicon built against an older core can set it. An `exitCode` of 3 on
 * the error, the moved code before #4553, is the same mark for one more
 * release; a lexicon sets `planMoved` and core picks the number. Any other
 * `exitCode` is ignored: a failed step exits 1, so a capability can't pick
 * the process's exit code.
 */
export function isPlanMovedError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { planMoved?: unknown; exitCode?: unknown };
  return e.planMoved === true || e.exitCode === LEGACY_PLAN_MOVED_EXIT_CODE;
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

/**
 * `--target <component>:<address>` values (#4300), grouped by component with
 * each component's addresses sorted and unique. The address is everything
 * after the first `:`, so it may hold colons of its own. Throws for a value
 * with no component or no address, and, given `known`, for a component not
 * among them.
 */
export function parseComponentTargets(values: readonly string[], known?: ReadonlySet<string>): Record<string, string[]> {
  const out: Record<string, Set<string>> = {};
  for (const value of values) {
    const at = value.indexOf(":");
    const component = at > 0 ? value.slice(0, at).trim() : "";
    const address = at > 0 ? value.slice(at + 1).trim() : "";
    if (component === "" || address === "") throw new Error(`--target needs a component and an address: --target <component>:<address>, got "${value}"`);
    if (known && !known.has(component)) {
      throw new Error(`--target ${value}: no component is named ${component} (components: ${[...known].sort().join(", ") || "none"})`);
    }
    (out[component] ??= new Set()).add(address);
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)).map(([c, s]) => [c, [...s].sort()]));
}
