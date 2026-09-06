/**
 * OPS013: a step-output reference (`stepOutput()`/`activity().out`, chant
 * #1290) must name a step that precedes it, in scope (main `phases`, not
 * `onFailure` or nested inside an `EffectStep`), with a registered
 * `ActivityContract` whose `returns` schema the referenced path resolves
 * against. Moved from the temporal lexicon's TMP013 to core in #2122 (epic
 * #2114 sub-issue 6), so it fires on every project that declares an Op — a
 * project on the local runtime with no lexicons configured included.
 *
 * Same shape as OPS012 (`./ops012-activity-contract.ts`): the generic walk
 * lives in `@intentius/chant/op`'s `validateStepOutputRefs`, over the same
 * contract map this file builds from core's own base-activity contracts
 * (`../../../op/activities/activity-contracts.ts`, #2117). A producer
 * step whose `fn` has no registered contract is flagged (unlike OPS012's
 * args/outcomeAttribute checks, which skip an unregistered `fn` — a
 * reference has nothing to validate against without one, so it can't be
 * silently allowed the way an unchecked arg can). The purely structural half
 * of this check (an unknown step id, or a reference into a later phase) is
 * independent of the contract map's contents entirely — no lexicon needs to
 * be configured, and no activity needs a registered contract at all, for it
 * to fire.
 *
 * This check is what makes it safe for a lexicon's own serializer to compile
 * every reference it finds unconditionally: `chant build` blocks file output
 * while an error-severity post-synth finding stands, so a workflow.ts
 * referencing an unresolved step never reaches disk (see the temporal
 * lexicon's `op/serializer.ts`, which also runs its own scope-only subset of
 * this same check directly — `validateStepOutputRefScope` — as
 * defense-in-depth, chant #1950 pre-merge review finding 2).
 *
 * Cross-contract type compatibility (chant #1950 pre-merge review, finding
 * 3): this rule also compares a producer's declared return type at `path`
 * against the consumer's declared arg type at the same position
 * (`string`/`number`/`boolean`/`object`/`array` only) and flags a mismatch —
 * a string-returning path feeding a number-typed arg, for example.
 * Deliberately shallow: a union, enum, literal, `z.any()`/`z.unknown()`, a
 * transform, or a reference sitting inside an array in `args` all bail
 * silently rather than being reasoned about. See `@intentius/chant/op`'s
 * `step-output-ref.ts` module doc for the full writeup of what this catches
 * and what it defers (to #1288 Stage 2).
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "../../post-synth";
import { validateStepOutputRefs, type ActivityContract } from "../../../op";
import type { OpConfig } from "../../../op";
import * as contracts from "../../../op/activities/activity-contracts";
import { isOpEntity } from "./support";

const CONTRACTS: Map<string, ActivityContract> = new Map(
  Object.values(contracts).map((c) => [c.name, c]),
);

export const ops013: PostSynthCheck = {
  id: "OPS013",
  description: "A step-output reference must name an in-scope, preceding, contract-validated producer step",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [entityKey, entity] of ctx.entities) {
      if (!isOpEntity(entity)) continue;
      const rec = entity as unknown as Record<string, unknown>;

      const props = ((entity as { props?: Record<string, unknown> }).props ?? {}) as unknown as OpConfig;
      if (typeof props.name !== "string" || !Array.isArray(props.phases)) continue;

      for (const issue of validateStepOutputRefs(props, CONTRACTS)) {
        diagnostics.push({
          checkId: "OPS013",
          severity: "error",
          message: `Op "${issue.opName}", phase "${issue.phase}", step "${issue.fn}": ${issue.message}`,
          entity: entityKey,
          lexicon: typeof rec.lexicon === "string" ? rec.lexicon : undefined,
        });
      }
    }

    return diagnostics;
  },
};
