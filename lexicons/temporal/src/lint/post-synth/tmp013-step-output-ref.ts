/**
 * TMP013: a step-output reference (`stepOutput()`/`activity().out`, chant
 * #1290) must name a step that precedes it, in scope (main `phases`, not
 * `onFailure` or nested inside an `EffectStep`), with a registered
 * `ActivityContract` whose `returns` schema the referenced path resolves
 * against.
 *
 * Same shape as TMP012 (`./tmp012-activity-contract.ts`): the generic walk
 * lives in `@intentius/chant/op`'s `validateStepOutputRefs`, over the same
 * contract map this lexicon registers in `../../op/activity-contracts.ts`.
 * A producer step whose `fn` has no registered contract here is flagged
 * (unlike TMP012's args/outcomeAttribute checks, which skip an
 * unregistered `fn` — a reference has nothing to validate against without
 * one, so it can't be silently allowed the way an unchecked arg can).
 *
 * This check is what makes it safe for the serializer
 * (`../../op/serializer.ts`) to compile every reference it finds
 * unconditionally: `chant build` blocks file output while an error-severity
 * post-synth finding stands, so a workflow.ts referencing an unresolved
 * step never reaches disk.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { validateStepOutputRefs, type ActivityContract } from "@intentius/chant/op";
import type { OpConfig } from "@intentius/chant/op";
import * as contracts from "../../op/activity-contracts";

const CONTRACTS: Map<string, ActivityContract> = new Map(
  Object.values(contracts).map((c) => [c.name, c]),
);

export const tmp013: PostSynthCheck = {
  id: "TMP013",
  description: "A step-output reference must name an in-scope, preceding, contract-validated producer step",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [entityKey, entity] of ctx.entities) {
      const et = (entity as unknown as Record<string, unknown>).entityType as string;
      if (et !== "Temporal::Op") continue;

      const props = ((entity as { props?: Record<string, unknown> }).props ?? {}) as unknown as OpConfig;
      if (typeof props.name !== "string" || !Array.isArray(props.phases)) continue;

      for (const issue of validateStepOutputRefs(props, CONTRACTS)) {
        diagnostics.push({
          checkId: "TMP013",
          severity: "error",
          message: `Op "${issue.opName}", phase "${issue.phase}", step "${issue.fn}": ${issue.message}`,
          entity: entityKey,
          lexicon: "temporal",
        });
      }
    }

    return diagnostics;
  },
};
