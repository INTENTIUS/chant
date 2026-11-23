/**
 * COMP009: stage-and-component-both-gate (#5482)
 *
 * Flags a component whose `gate` step applies in an environment that a
 * pipeline stage already gates. A promote into that stage waits for the
 * stage's approval of the release, and the component's own gate then waits
 * again, on a fact of its own, for the same change. chant accepts the
 * declaration, so this is a warning: a declaration that relies on both
 * approvals keeps working, and `chant approve --env <stage>` lists both
 * (`pendingApprovals` reports one `stage` and one `component` fact).
 *
 * The stages come from the member's `.chant/pipeline.ts`, folded from its
 * working tree by `chant lint` ({@link gatedStagesOf}) and handed to the
 * check on `ComponentCheckContext.gatedStages`. A stage is gated when it
 * declares a `gate` whose policy is not `never`. A gate step with no `environments` applies in every
 * environment, so it meets every gated stage. A check run without stages
 * (a direct unit test, a project with no pipeline) flags nothing.
 *
 * Triggers on: a component `gate` step with `environments: ["prod"]` (or
 * none) when the pipeline's `prod` stage has a `gate`.
 * OK: the same gate in an environment whose stage declares no gate, or no
 * pipeline.
 */

import type { ComponentCheck, ComponentCheckContext, ComponentCheckDiagnostic, GatedStage } from "../../component-checks";
import { gateName } from "../../../op/gate-name";
import { walkComponent } from "./support";

export const comp009StageAndComponentBothGateRule: ComponentCheck = {
  id: "COMP009",
  severity: "warning",
  category: "correctness",
  description: "A component's gate step applies in an environment whose pipeline stage already has a gate",
  check(ctx: ComponentCheckContext): ComponentCheckDiagnostic[] {
    const stages = ctx.gatedStages;
    if (!stages || stages.size === 0) return [];
    const diagnostics: ComponentCheckDiagnostic[] = [];

    for (const [name, { component, filePath }] of ctx.components) {
      for (const { gate, phaseName } of walkComponent(component).gates) {
        const scoped = gate.environments === undefined ? undefined : Array.isArray(gate.environments) ? gate.environments : Object.keys(gate.environments);
        const label = gateName(gate);
        for (const [stage, found] of stages) {
          if (scoped !== undefined && !scoped.includes(stage)) continue;
          diagnostics.push({
            checkId: "COMP009",
            severity: "warning",
            component: name,
            file: filePath,
            message:
              `Component "${name}": gate "${label}" (phase "${phaseName}") applies in "${stage}", and the pipeline's "${stage}" stage (${found.file}) already has a gate. ` +
              `A promote into "${stage}" waits for the stage's approval and then waits again for this gate on the same change. ` +
              `Leave "${stage}" out of the gate's environments, or remove the gate and let the stage ask once.`,
          });
        }
      }
    }

    return diagnostics;
  },
};

/**
 * The stages of the pipeline in `projectDir`'s `.chant/pipeline.ts` that
 * declare a `gate` that waits for an approval (a `policy` of `never` does not), by stage name. Tolerant: no pipeline, or one that does
 * not fold (its own check reports that), gives an empty map.
 */
export async function gatedStagesOf(projectDir: string): Promise<Map<string, GatedStage>> {
  const out = new Map<string, GatedStage>();
  try {
    const { readMemberPipeline } = await import("../../../pipeline/read");
    const read = readMemberPipeline(projectDir);
    if (read.status !== "folded") return out;
    for (const stage of read.spec.stages) if (stage.gate !== undefined && stage.gate.policy !== "never") out.set(stage.name, { file: read.file });
  } catch {
    return out;
  }
  return out;
}
