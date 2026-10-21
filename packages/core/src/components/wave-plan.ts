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
 * Known limit: a step input that reads an earlier step of the same
 * component (`@Phase.field`) has no value before the component runs, so it
 * plans as `undefined`. Cross-component wiring (`stackOutput()`,
 * `@<component>.publish.*`) resolves.
 */

import { resolveStepInput, unresolvedWiringSources, type DriverComponent, type DriverPhase, type DriverStep } from "./driver";
import { componentPlanDigest } from "./gate-plan";
import type { CapabilityRegistry, DeployContext, PlannedOutputs } from "./capability";
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
  | { component: string; members: WaveMember[]; plans: Record<string, unknown>; parts: ChangeSetPart[]; outputs?: PlannedOutputs }
  | { component: string; error: string };

/** A part with no entries, for a member whose planner describes no changes. */
function emptyPart(member: WaveMember): ChangeSetPart {
  return {
    member: { member: member.member, lexicon: "chant", planner: "chant", status: "planned", planDigest: member.planDigest, holes: [] },
    entries: [],
  };
}

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
    for (const step of capabilitySteps(component.deploy)) {
      const capability = registry.resolve(step.kind);
      if (!capability.plan) continue;
      const { kind: _kind, ...rest } = step;
      const input = resolveStepInput(rest, {}, componentOutputs);
      const planned = await capability.plan(planContext(ctx, rest, componentOutputs), input as never);
      const member = { member: planned.member, planDigest: planned.planDigest };
      members.push(member);
      parts.push(planned.changeSet ?? emptyPart(member));
      if (planned.artifact !== undefined) plans[planned.member] = planned.artifact;
      if (planned.outputs) outputs = mergePlannedOutputs(outputs, planned.outputs);
    }
    if (members.length === 0) {
      const member = {
        member: component.name,
        planDigest: componentPlanDigest({
          environment: ctx.env,
          component,
          ...(ctx.vars ? { vars: ctx.vars } : {}),
        }),
      };
      members.push(member);
      parts.push(emptyPart(member));
    }
    return { component: component.name, members, plans, parts, ...(outputs ? { outputs } : {}) };
  } catch (err) {
    return { component: component.name, error: err instanceof Error ? err.message : String(err) };
  }
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
