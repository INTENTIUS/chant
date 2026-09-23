/**
 * OPS015: a gate's `approval` block (#2508) must be well formed. The quorum
 * count is an integer of at least 1, roles are named, the mode is `log-only`
 * or `enforce`, `enforce` has a policy to enforce, and `policy` resolves to a
 * gate policy set a lexicon rendered, with a version that is still the digest
 * of its text.
 *
 * `gate()` already throws on the first of these. This check runs over the
 * build output, so it also covers a gate step written without the builder and
 * reports every problem rather than the first.
 */
import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "../../post-synth";
import type { OpConfig, PhaseDefinition, StepDefinition } from "../../../op/types";
import { gateApprovalProblems } from "../../../op/gate-approval";
import { gateName } from "../../../op/gate-name";
import { isOpEntity } from "./support";

function* gateSteps(phases: PhaseDefinition[] | undefined): Generator<StepDefinition & { kind: "gate" }> {
  for (const phase of phases ?? []) {
    for (const step of phase.steps ?? []) {
      if (step.kind === "gate") yield step;
      else if (step.kind === "effect") {
        for (const nested of step.steps ?? []) if (nested.kind === "gate") yield nested;
      }
    }
  }
}

export const ops015: PostSynthCheck = {
  id: "OPS015",
  description:
    "A gate's approval block is well formed: quorum count at least 1, roles named, mode log-only or enforce, enforce has a policy, and policy resolves to a gate policy set whose version is the digest of its text",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];
    for (const [entityKey, entity] of ctx.entities) {
      if (!isOpEntity(entity)) continue;
      const rec = entity as unknown as Record<string, unknown>;
      const props = ((entity as { props?: Record<string, unknown> }).props ?? {}) as unknown as OpConfig;
      if (!Array.isArray(props.phases)) continue;

      for (const step of [...gateSteps(props.phases), ...gateSteps(props.onFailure)]) {
        if (step.approval === undefined) continue;
        for (const problem of gateApprovalProblems(step.approval)) {
          diagnostics.push({
            checkId: "OPS015",
            severity: "error",
            message: `Op "${props.name}", gate "${gateName(step)}": ${problem}`,
            entity: entityKey,
            lexicon: typeof rec.lexicon === "string" ? rec.lexicon : undefined,
          });
        }
      }
    }
    return diagnostics;
  },
};
