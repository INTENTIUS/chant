import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { isValidCronExpression } from "@intentius/chant/op";
import { propsOf } from "../../entity-props";

/**
 * FTN020: a Schedule's cron expression must parse.
 *
 * fountain stores the schedule either way and the scheduler simply never
 * fires it, so a typo here is a cadence that silently does not happen — the
 * failure mode nobody notices until the thing the schedule was watching has
 * already gone wrong.
 *
 * The field check is core's own `isValidCronExpression` (`@intentius/chant/op`,
 * #2120) rather than a copy of it: deliberately permissive about what a field
 * contains, a pre-submission guard rather than a second scheduler. Six fields
 * pass too — a seconds column is the common variant, and rejecting it here
 * would be chant inventing a stricter rule than the server enforces.
 *
 * The `@daily`-style nicknames are refused (#2195). This rule used to accept
 * them and core's validator never has. chant has one idea of what a cron
 * string is: the expression an Op's `schedule` carries, the one `chant
 * operator` matches a tick against, and the one this rule checks. `cronMatches`
 * cannot evaluate a nickname, so a cadence written that way is a cadence chant
 * itself will not fire, even where fountain upstream would take it. Write the
 * five fields out (`@daily` is `0 0 * * *`). `@reboot` was already refused,
 * since there is no boot to hang it on.
 */

export const scheduleCronSyntaxCheck: PostSynthCheck = {
  id: "FTN020",
  description: "Schedule cron must be five- or six-field UTC cron (no @nickname shorthands)",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [name, entity] of ctx.entities) {
      if (entity.entityType !== "Fountain::V1::Schedule") continue;
      const cron = propsOf(entity).cron;
      if (typeof cron !== "string") continue;

      if (!isValidCronExpression(cron)) {
        diagnostics.push({
          checkId: "FTN020",
          severity: "error",
          message:
            `Schedule "${name}" cron "${cron}" is not five- or six-field cron syntax — ` +
            `fountain would store it and never fire it. The @daily-style shorthands are ` +
            `not accepted either; write the fields out.`,
          entity: name,
          lexicon: "fountain",
        });
      }
    }

    return diagnostics;
  },
};
