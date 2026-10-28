/**
 * Plan one wave of a gated-wave fan-out (#3049).
 *
 * Each component in the wave is asked what it would change: every deploy
 * step whose capability has a `plan` (`Capability.plan`, ./capability.ts) is
 * planned, with its wiring resolved against the outputs the earlier waves
 * left behind. That is the point of planning at the wave rather than up
 * front: a root that reads an upstream output plans against the value the
 * upstream wave actually wrote.
 *
 * A component with no plannable step is still a member of the wave. Its plan
 * digest is the composition digest a gate inside it would bind
 * (`componentPlanDigest`, ./gate-plan.ts, #2574), so a wave mixing roots and
 * other components still has one digest that moves when any of them does.
 *
 * The files a step without a `plan` deploys from are bound too (#4155,
 * ./deploy-inputs.ts). A component with no plannable step folds them into its
 * composition digest. A component with one gets a member more,
 * `<component>#inputs`, over its other steps' files, so a `lambda-deploy`
 * source or a Helm chart beside a `cfn-deploy` moves the wave's digest. A step
 * whose content chant can't name is a hole on that member, so the plan note
 * lists it as unbound.
 *
 * Known limit: a step input that reads an earlier step of the same
 * component (`@Phase.field`) has no value before the component runs, so it
 * plans as `undefined`. Cross-component wiring (`stackOutput()`,
 * `@<component>.publish.*`) resolves.
 */

import { resolvePlannedLock, type PlannedLock } from "../lifecycle/lock-rows";
import type { PlanShape } from "./covered-round";
import { assertTargetsAccepted, resolveStepInput, unresolvedWiringSources, type DriverComponent, type DriverPhase, type DriverStep } from "./driver";
import { componentPlanDigest } from "./gate-plan";
import { componentDeployInputs, type ComponentDeployInputs } from "./deploy-inputs";
import { computePlanDigest } from "../lifecycle/plan-digest";
import type { CapabilityPlan, CapabilityRegistry, DeployContext, PlannedOutputs } from "./capability";
import type { WaveMember } from "../gated-waves";
import type { ChangeSetPart } from "../change-set";

/**
 * What planning one component produced: its members, what its steps hand to
 * `run`, and each member's change-set part (#3183), or why it could not plan.
 * A member whose capability returns no part gets one with no entries, so the
 * parts always cover the members. `outputs` is what its steps' plans say the
 * component will expose once applied (#3999), merged the way the driver
 * merges a run's outputs; absent when no step's plan says.
 */
export type WaveComponentPlan =
  | {
      component: string;
      members: WaveMember[];
      plans: Record<string, unknown>;
      parts: ChangeSetPart[];
      outputs?: PlannedOutputs;
      shapes?: Record<string, PlanShape>;
      policy?: CapabilityPolicyFindings[];
      /** Each planned member's lock grain and rows (#4552), by member. Absent when no step planned. */
      locks?: Record<string, PlannedLock>;
      /** Each planned member's location in a pull request's environment (#4609), by member. Absent when no step gave one. */
      locations?: Record<string, string>;
    }
  | { component: string; error: string; policy?: CapabilityPolicyFindings[] };

/** A policy engine's findings a capability's plan carried for one member (#4550): `denied` when the plan threw `policyDenied`. */
export interface CapabilityPolicyFindings {
  member: string;
  denied: boolean;
  denials: Array<{ rule: string; message: string }>;
  holds: Array<{ rule: string; message: string }>;
  warnings: string[];
}

const findingList = (v: unknown): Array<{ rule: string; message: string }> =>
  Array.isArray(v) ? v.filter((f): f is { rule: string; message: string } => typeof f?.rule === "string" && typeof f?.message === "string").map((f) => ({ rule: f.rule, message: f.message })) : [];

/**
 * The findings a capability's plan or its policy error carries (#4550), in
 * the gate-policy shape (`{ denials, holds, warnings }`) that chant#4541's
 * `pulumi-up` puts on its artifact as `policy` and on a
 * `PulumiPolicyDeniedError` as `findings`. Undefined when there are none.
 */
export function capabilityPolicyOf(member: string, findings: unknown, denied: boolean): CapabilityPolicyFindings | undefined {
  if (findings === null || typeof findings !== "object") return denied ? { member, denied, denials: [], holds: [], warnings: [] } : undefined;
  const f = findings as { denials?: unknown; holds?: unknown; warnings?: unknown };
  const out = {
    member,
    denied,
    denials: findingList(f.denials),
    holds: findingList(f.holds),
    warnings: Array.isArray(f.warnings) ? f.warnings.filter((w): w is string => typeof w === "string") : [],
  };
  return denied || out.denials.length + out.holds.length + out.warnings.length > 0 ? out : undefined;
}

/** Whether `err` is a capability's policy denial (#4550): the `policyDenied: true` mark, as `planMoved` marks a moved plan. */
export function isPolicyDeniedError(err: unknown): err is { policyDenied: true; member?: unknown; findings?: unknown } {
  return typeof err === "object" && err !== null && (err as { policyDenied?: unknown }).policyDenied === true;
}

/** A part with no entries, for a member whose planner describes no changes. `unbound` steps become its holes (#4155). */
function emptyPart(member: WaveMember, unbound: ComponentDeployInputs["unbound"] = []): ChangeSetPart {
  const holes = unbound.map((u) => ({ address: `${u.phase}/${u.kind}`, type: u.kind, reason: `unbound: ${u.reason}` }));
  return {
    member: { member: member.member, lexicon: "chant", planner: "chant", status: "planned", planDigest: member.planDigest, holes },
    entries: [],
  };
}

/** The member a planning component's other steps add (#4155): their files, under the component's name. */
export const inputsMemberName = (component: string): string => `${component}#inputs`;

/** Every capability step in a composition, nested phases included, gates left out. */
export function capabilitySteps(phases: readonly DriverPhase[]): DriverStep[] {
  const out: DriverStep[] = [];
  const walk = (steps: DriverPhase["steps"]): void => {
    for (const step of steps) {
      if (typeof (step as DriverPhase).phase === "string" && Array.isArray((step as DriverPhase).steps)) {
        walk((step as DriverPhase).steps);
        continue;
      }
      if ((step as { kind?: unknown }).kind === "gate") continue;
      out.push(step as DriverStep);
    }
  };
  for (const phase of phases) walk(phase.steps);
  return out;
}

/**
 * The context a step is planned with: `ctx`, plus the components whose
 * outputs the step reads and could not read yet (`unresolvedInputs`, #4084).
 */
export function planContext(
  ctx: DeployContext,
  stepInput: Record<string, unknown>,
  componentOutputs: Record<string, Record<string, unknown>>,
): DeployContext {
  const unresolved = unresolvedWiringSources(stepInput, componentOutputs);
  return unresolved.length > 0 ? { ...ctx, unresolvedInputs: unresolved } : ctx;
}

/** Plan one component against the outputs earlier waves produced. Never throws: a failure comes back as `error`. */
export async function planWaveComponent(
  component: DriverComponent,
  registry: CapabilityRegistry,
  ctx: DeployContext,
  componentOutputs: Record<string, Record<string, unknown>>,
): Promise<WaveComponentPlan> {
  try {
    const members: WaveMember[] = [];
    const plans: Record<string, unknown> = {};
    const parts: ChangeSetPart[] = [];
    let outputs: PlannedOutputs | undefined;
    const shapes: Record<string, PlanShape> = {};
    const policy: CapabilityPolicyFindings[] = [];
    const locks: Record<string, PlannedLock> = {};
    const locations: Record<string, string> = {};
    assertTargetsAccepted(component, registry, ctx);
    for (const step of capabilitySteps(component.deploy)) {
      const capability = registry.resolve(step.kind);
      if (!capability.plan) continue;
      const { kind: _kind, ...rest } = step;
      const input = resolveStepInput(rest, {}, componentOutputs);
      const planned = bindTargets(step.kind, ctx, await capability.plan(planContext(ctx, rest, componentOutputs), input as never));
      const member = { member: planned.member, planDigest: planned.planDigest };
      members.push(member);
      parts.push(planned.changeSet ?? emptyPart(member));
      if (planned.artifact !== undefined) plans[planned.member] = planned.artifact;
      // #4550: advisory findings the plan carried (pulumi-up's CrossGuard), for the note.
      const found = capabilityPolicyOf(planned.member, (planned.artifact as { policy?: unknown } | undefined)?.policy, false);
      if (found) policy.push(found);
      if (planned.shape) shapes[planned.member] = { ...planned.shape, member: planned.member };
      if (planned.outputs) outputs = mergePlannedOutputs(outputs, planned.outputs);
      // #4609: where the member's copy lives in a pull request's environment (a review stack).
      if (typeof planned.location === "string" && planned.location !== "") locations[planned.member] = planned.location;
      // #4552: the member's grain (declared at base, else its lexicon's) and, on the resource grain, its rows.
      locks[planned.member] = await resolvePlannedLock(capability, input, planned, ctx.lockGrain);
    }
    // #4155: the steps without a plan, which no member above covers.
    const planless = (step: DriverStep): boolean => !registry.has(step.kind) || registry.resolve(step.kind).plan === undefined;
    if (members.length === 0) {
      const read = componentDeployInputs(component.deploy, process.cwd());
      const member = {
        member: component.name,
        planDigest: componentPlanDigest({
          environment: ctx.env,
          component,
          ...(ctx.vars ? { vars: ctx.vars } : {}),
          inputs: read.inputs,
          ...(ctx.targets ? { targets: ctx.targets } : {}),
        }),
      };
      members.push(member);
      parts.push(emptyPart(member, read.unbound));
    } else {
      const read = componentDeployInputs(component.deploy, process.cwd(), planless);
      if (read.inputs.length > 0 || read.unbound.length > 0) {
        const member = {
          member: inputsMemberName(component.name),
          planDigest: computePlanDigest("component-inputs", { environment: ctx.env, component: component.name, inputs: read.inputs }),
        };
        members.push(member);
        parts.push(emptyPart(member, read.unbound));
      }
    }
    return {
      component: component.name,
      members,
      plans,
      parts,
      ...(outputs ? { outputs } : {}),
      ...(Object.keys(shapes).length > 0 ? { shapes } : {}),
      ...(policy.length > 0 ? { policy } : {}),
      ...(Object.keys(locks).length > 0 ? { locks } : {}),
      ...(Object.keys(locations).length > 0 ? { locations } : {}),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isPolicyDeniedError(err)) {
      const denied = capabilityPolicyOf(typeof err.member === "string" ? err.member : component.name, err.findings, true)!;
      return { component: component.name, error: message, policy: [denied] };
    }
    return { component: component.name, error: message };
  }
}

/**
 * A member's digest with its targets in it (#4300), the way terragucci's
 * cone plan digest binds a cone: the digest over the plan's own digest and
 * the sorted targets, so an approval of one narrowing covers no other.
 */
export function targetedPlanDigest(planDigest: string, targets: readonly string[]): string {
  return computePlanDigest("capability-targets", { plan: planDigest, targets: [...new Set(targets)].sort() });
}

/**
 * A step's plan made with `ctx.targets` (#4300), its digest bound to them.
 * The plan must give back the targets it was asked for, which says it planned
 * those alone; one that gives back others, or none, refuses. Without
 * `ctx.targets`, the plan as it came.
 */
export function bindTargets(kind: string, ctx: DeployContext, planned: CapabilityPlan): CapabilityPlan {
  const asked = ctx.targets;
  if (!asked || asked.length === 0) return planned;
  const want = [...new Set(asked)].sort();
  const got = [...new Set(planned.targets ?? [])].sort();
  if (got.length !== want.length || got.some((t, i) => t !== want[i])) {
    throw new Error(
      `component "${ctx.component}": ${kind} was asked to plan ${want.join(", ")} but its plan of ${planned.member} ` +
        (got.length === 0 ? "names no targets" : `names ${got.join(", ")}`),
    );
  }
  const planDigest = targetedPlanDigest(planned.planDigest, want);
  const changeSet = planned.changeSet
    ? { ...planned.changeSet, member: { ...planned.changeSet.member, planDigest } }
    : undefined;
  return { ...planned, planDigest, targets: want, ...(changeSet ? { changeSet } : {}) };
}

/** `next` over `prior`, as a later step's outputs win over an earlier one's in a run. */
function mergePlannedOutputs(prior: PlannedOutputs | undefined, next: PlannedOutputs): PlannedOutputs {
  const known = { ...(prior?.known ?? {}), ...next.known };
  const unknown = new Set([...(prior?.unknown ?? []).filter((n) => !(n in next.known)), ...next.unknown]);
  for (const n of unknown) delete known[n];
  return { known, unknown: [...unknown].sort() };
}

/**
 * The outputs `component` exposes now, read from each step whose capability
 * has `outputs` (#3183), merged the way the driver merges a run's outputs.
 * `undefined` when no step can say. A pull request's plan reads these for
 * the components a planned one depends on, before anything has applied.
 */
export async function readComponentOutputs(
  component: DriverComponent,
  registry: CapabilityRegistry,
  ctx: DeployContext,
  componentOutputs: Record<string, Record<string, unknown>>,
): Promise<Record<string, unknown> | undefined> {
  let found: Record<string, unknown> | undefined;
  for (const step of capabilitySteps(component.deploy)) {
    const capability = registry.resolve(step.kind);
    if (!capability.outputs) continue;
    const { kind: _kind, ...rest } = step;
    const input = resolveStepInput(rest, {}, componentOutputs);
    found = { ...found, ...(await capability.outputs(ctx, input as never)) };
  }
  return found;
}

/**
 * Read the deployed outputs of each of `names` that `outputs` holds nothing
 * for yet (#4104), through {@link readComponentOutputs}, and add them to
 * `outputs`. A name that is not among `components`, or whose steps cannot
 * say, is left out, so its dependents' references stay unresolved. Returns,
 * per component read, the names of the outputs the read gave, sorted.
 *
 * `components` must be the whole graph, not the selection: the dependency a
 * selected member reads is often one the change did not select.
 */
export async function readDeployedOutputs(
  names: readonly string[],
  components: ReadonlyMap<string, DriverComponent>,
  registry: CapabilityRegistry,
  ctxOf: (component: string) => DeployContext,
  outputs: Record<string, Record<string, unknown>>,
): Promise<Record<string, string[]>> {
  const read: Record<string, string[]> = {};
  for (const name of names) {
    if (name in outputs || name in read) continue;
    const component = components.get(name);
    if (!component) continue;
    const found = await readComponentOutputs(component, registry, ctxOf(name), outputs);
    if (!found) continue;
    outputs[name] = found;
    read[name] = Object.keys(found).sort();
  }
  return read;
}
