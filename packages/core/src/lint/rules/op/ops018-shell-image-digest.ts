/**
 * OPS018: a `shellCmd` step that runs in a container (#4015) names its image
 * pinned by digest, `<ref>@sha256:<digest>`, as a literal string. A tag can
 * move between two runs of the same Op, and then the step record's image no
 * longer says what ran. Checked over the main phases, `onFailure`, and the
 * steps inside an effect.
 */
import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "../../post-synth";
import type { OpConfig, PhaseDefinition, StepDefinition } from "../../../op";
import { imageProblem } from "../../../op/activities/shell";
import { isOpEntity } from "./support";

function activitySteps(steps: readonly StepDefinition[]): Array<{ fn: string; args?: Record<string, unknown> }> {
  return steps.flatMap((step) =>
    step.kind === "activity" ? [step] : step.kind === "effect" ? step.steps.filter((s) => s.kind === "activity") : [],
  ) as Array<{ fn: string; args?: Record<string, unknown> }>;
}

export const ops018: PostSynthCheck = {
  id: "OPS018",
  description: "A shell step with an image names it pinned by digest, as a literal string",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];
    for (const [entityKey, entity] of ctx.entities) {
      if (!isOpEntity(entity)) continue;
      const rec = entity as unknown as Record<string, unknown>;
      const props = ((entity as { props?: Record<string, unknown> }).props ?? {}) as unknown as OpConfig;
      if (typeof props.name !== "string" || !Array.isArray(props.phases)) continue;
      const phases: PhaseDefinition[] = [...props.phases, ...(props.onFailure ?? [])];
      for (const phase of phases) {
        for (const step of activitySteps(phase.steps ?? [])) {
          if (step.fn !== "shellCmd" || step.args?.image === undefined) continue;
          const problem = imageProblem(step.args.image);
          if (!problem) continue;
          diagnostics.push({
            checkId: "OPS018",
            severity: "error",
            message: `Op "${props.name}", phase "${phase.name}", shellCmd: ${problem}`,
            entity: entityKey,
            lexicon: typeof rec.lexicon === "string" ? rec.lexicon : undefined,
          });
        }
      }
    }
    return diagnostics;
  },
};
