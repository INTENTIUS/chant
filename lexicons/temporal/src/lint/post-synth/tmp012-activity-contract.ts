/**
 * TMP012: activity step args/outcomeAttribute must match the activity's
 * declared contract (chant #1288 Stage 1).
 *
 * Validates every `Temporal::Op`'s steps against the contracts this lexicon
 * registers for its own activities in `../../op/activity-contracts.ts`,
 * using the generic walk in `@intentius/chant/op`'s `validateActivitySteps`.
 * A step whose `fn` has no registered contract here is skipped — most
 * activities (this lexicon's more complex ones, and every other lexicon's)
 * don't have one yet; adopting the same pattern in another lexicon is a
 * follow-up (see the module doc on `activity-contracts.ts`).
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { validateActivitySteps, type ActivityContract } from "@intentius/chant/op";
import type { OpConfig } from "@intentius/chant/op";
import * as contracts from "../../op/activity-contracts";

const CONTRACTS: Map<string, ActivityContract> = new Map(
  Object.values(contracts).map((c) => [c.name, c]),
);

export const tmp012: PostSynthCheck = {
  id: "TMP012",
  description: "Activity step args and outcomeAttribute.from must match the activity's declared contract",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [entityKey, entity] of ctx.entities) {
      const et = (entity as unknown as Record<string, unknown>).entityType as string;
      if (et !== "Temporal::Op") continue;

      const props = ((entity as { props?: Record<string, unknown> }).props ?? {}) as unknown as OpConfig;
      if (typeof props.name !== "string" || !Array.isArray(props.phases)) continue;

      for (const issue of validateActivitySteps(props, CONTRACTS)) {
        diagnostics.push({
          checkId: "TMP012",
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
