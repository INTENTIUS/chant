/**
 * OPS012: activity step args/outcomeAttribute must match the activity's
 * declared contract (chant #1288 Stage 1; moved from the temporal lexicon's
 * TMP012 to core in #2122, epic #2114 sub-issue 6, so it fires on every
 * project that declares an Op, not only one with the temporal lexicon
 * configured).
 *
 * Validates every Op entity's steps against `./activity-contracts.ts`'s
 * registered contracts, using the generic walk in `@intentius/chant/op`'s
 * `validateActivitySteps`. A step whose `fn` has no registered contract here
 * is skipped — most activities don't have one yet; see that module's doc for
 * why that's the intended, non-breaking default.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "../../post-synth";
import { validateActivitySteps, type ActivityContract } from "../../../op";
import type { OpConfig } from "../../../op";
import * as contracts from "./activity-contracts";
import { isOpEntityType } from "./support";

const CONTRACTS: Map<string, ActivityContract> = new Map(
  Object.values(contracts).map((c) => [c.name, c]),
);

export const ops012: PostSynthCheck = {
  id: "OPS012",
  description: "Activity step args and outcomeAttribute.from must match the activity's declared contract",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [entityKey, entity] of ctx.entities) {
      const rec = entity as unknown as Record<string, unknown>;
      if (!isOpEntityType(rec.entityType)) continue;

      const props = ((entity as { props?: Record<string, unknown> }).props ?? {}) as unknown as OpConfig;
      if (typeof props.name !== "string" || !Array.isArray(props.phases)) continue;

      for (const issue of validateActivitySteps(props, CONTRACTS)) {
        diagnostics.push({
          checkId: "OPS012",
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
