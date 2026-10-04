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

import { resolveStepInput, type DriverComponent, type DriverPhase, type DriverStep } from "./driver";
import { componentPlanDigest } from "./gate-plan";
import type { CapabilityRegistry, DeployContext } from "./capability";
import type { WaveMember } from "../gated-waves";
import type { ChangeSetPart } from "../change-set";

/**
 * What planning one component produced: its members, what its steps hand to
 * `run`, and each member's change-set part (#3183), or why it could not plan.
 * A member whose capability returns no part gets one with no entries, so the
 * parts always cover the members.
 */
export type WaveComponentPlan =
  | { component: string; members: WaveMember[]; plans: Record<string, unknown>; parts: ChangeSetPart[] }
  | { component: string; error: string };

/** A part with no entries, for a member whose planner describes no changes. */
function emptyPart(member: WaveMember): ChangeSetPart {
  return {
    member: { member: member.member, lexicon: "chant", planner: "chant", status: "planned", planDigest: member.planDigest, holes: [] },
    entries: [],
  };
}

/** Every capability step in a composition, nested phases included, gates left out. */
function capabilitySteps(phases: readonly DriverPhase[]): DriverStep[] {
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
    for (const step of capabilitySteps(component.deploy)) {
      const capability = registry.resolve(step.kind);
      if (!capability.plan) continue;
      const { kind: _kind, ...rest } = step;
      const input = resolveStepInput(rest, {}, componentOutputs);
      const planned = await capability.plan(ctx, input as never);
      const member = { member: planned.member, planDigest: planned.planDigest };
      members.push(member);
      parts.push(planned.changeSet ?? emptyPart(member));
      if (planned.artifact !== undefined) plans[planned.member] = planned.artifact;
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
    return { component: component.name, members, plans, parts };
  } catch (err) {
    return { component: component.name, error: err instanceof Error ? err.message : String(err) };
  }
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
