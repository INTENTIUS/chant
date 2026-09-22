import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { propsOf } from "../../entity-props";

/**
 * FTN024: an Environment's `setup_timeout_seconds` is a whole number from 1 to 900.
 *
 * fountain v0.21.0 declares the field as an integer with `minimum: 1` and
 * `maximum: 900`, and defaults it to 120 when it is absent. Codegen types it as
 * `number` and carries neither bound into validation, so without this rule a
 * 901 or a 12.5 builds cleanly and the first anyone hears of it is a 422 at
 * apply.
 *
 * A value in range is still worth a second look in review. Changing it
 * invalidates the environment's checkpoints (recorded on chant#2391), so an
 * edit to this field costs what an edit to `setup_script` costs.
 */

const MIN = 1;
const MAX = 900;

export const setupTimeoutRangeCheck: PostSynthCheck = {
  id: "FTN024",
  description: "Environment setup_timeout_seconds must be an integer from 1 to 900",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [name, entity] of ctx.entities) {
      if (entity.entityType !== "Fountain::V1::Environment") continue;
      const timeout = propsOf(entity).setup_timeout_seconds;
      if (timeout === undefined || timeout === null) continue;

      if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < MIN || timeout > MAX) {
        diagnostics.push({
          checkId: "FTN024",
          severity: "error",
          message:
            `Environment "${name}" setup_timeout_seconds ${JSON.stringify(timeout)} is not an integer ` +
            `from ${MIN} to ${MAX}; fountain refuses it at apply`,
          entity: name,
          lexicon: "fountain",
        });
      }
    }

    return diagnostics;
  },
};
