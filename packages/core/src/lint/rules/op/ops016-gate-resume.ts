/**
 * OPS016: a gate that resumes (`resume: true`, #3947) can. It sits at the top
 * of a main phase, asks no decision point, is not in an Op with a
 * `workLease`, names a plan step that runs before it when its plan is a
 * reference, and no step after it reads an output an activity contract marks
 * secret, since a checkpoint never stores one.
 *
 * The run itself treats a gate that fails one of these as one that doesn't
 * resume. This check makes that a build error instead of a quiet re-run from
 * the first phase. Contracts come from the same merged map OPS013 uses.
 */
import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "../../post-synth";
import { mergeActivityContracts, type ActivityContract } from "../../../op";
import type { OpConfig } from "../../../op";
import { validateGateResume } from "../../../op/gate-checkpoint";
import * as contracts from "../../../op/activities/activity-contracts";
import { isOpEntity } from "./support";

const CONTRACTS: Map<string, ActivityContract> = new Map(
  Object.values(contracts).map((c) => [c.name, c]),
);

export const ops016: PostSynthCheck = {
  id: "OPS016",
  description:
    "A gate with resume: true can resume: at the top of a main phase, no decision point or workLease, a plan step before it, and no secret output read after it",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];
    const activeContracts = mergeActivityContracts(CONTRACTS, ctx.activityContracts);
    for (const [entityKey, entity] of ctx.entities) {
      if (!isOpEntity(entity)) continue;
      const rec = entity as unknown as Record<string, unknown>;
      const props = ((entity as { props?: Record<string, unknown> }).props ?? {}) as unknown as OpConfig;
      if (typeof props.name !== "string" || !Array.isArray(props.phases)) continue;
      for (const issue of validateGateResume(props, activeContracts)) {
        diagnostics.push({
          checkId: "OPS016",
          severity: "error",
          message: `Op "${issue.opName}", phase "${issue.phase}", ${issue.fn}: ${issue.message}`,
          entity: entityKey,
          lexicon: typeof rec.lexicon === "string" ? rec.lexicon : undefined,
        });
      }
    }
    return diagnostics;
  },
};
