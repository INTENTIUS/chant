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

/** What planning one component produced: its members and what its steps hand to `run`, or why it could not plan. */
export type WaveComponentPlan =
  | { component: string; members: WaveMember[]; plans: Record<string, unknown> }
  | { component: string; error: string };

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
    for (const step of capabilitySteps(component.deploy)) {
      const capability = registry.resolve(step.kind);
      if (!capability.plan) continue;
      const { kind: _kind, ...rest } = step;
      const input = resolveStepInput(rest, {}, componentOutputs);
      const planned = await capability.plan(ctx, input as never);
      members.push({ member: planned.member, planDigest: planned.planDigest });
      if (planned.artifact !== undefined) plans[planned.member] = planned.artifact;
    }
    if (members.length === 0) {
      members.push({
        member: component.name,
        planDigest: componentPlanDigest({
          environment: ctx.env,
          component,
          ...(ctx.vars ? { vars: ctx.vars } : {}),
        }),
      });
    }
    return { component: component.name, members, plans };
  } catch (err) {
    return { component: component.name, error: err instanceof Error ? err.message : String(err) };
  }
}
