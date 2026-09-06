import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { propsOf } from "../../entity-props";

/**
 * FTN020: a Schedule's cron expression must parse.
 *
 * fountain stores the schedule either way and the scheduler simply never
 * fires it, so a typo here is a cadence that silently does not happen — the
 * failure mode nobody notices until the thing the schedule was watching has
 * already gone wrong.
 *
 * Upstream documents five fields in UTC plus the `@daily`-style shorthands,
 * with `@reboot` refused (there is no boot to hang it on). The field check is
 * deliberately permissive — a pre-submission guard, not a second scheduler.
 * Six fields pass too: a seconds column is the common variant, and rejecting
 * it here would be chant inventing a stricter rule than the server enforces.
 *
 * #2120: switch to @intentius/chant/op/cron once it lands. The five-or-six
 * field check below is inlined from the temporal lexicon's TMP010 until then,
 * so both lexicons agree on what a cron string is.
 */

/** Very permissive cron field pattern — catches obvious syntax errors. */
const CRON_FIELD = /^[0-9*,/\-?LW#]+$/;

/** The nicknames fountain accepts; `@reboot` is documented as refused. */
const CRON_NICKNAMES = new Set(["@yearly", "@annually", "@monthly", "@weekly", "@daily", "@midnight", "@hourly"]);

function isValidCronExpression(expr: string): boolean {
  const trimmed = expr.trim();
  if (trimmed.startsWith("@")) return CRON_NICKNAMES.has(trimmed.toLowerCase());
  const fields = trimmed.split(/\s+/);
  if (fields.length < 5 || fields.length > 6) return false;
  return fields.every((f) => CRON_FIELD.test(f));
}

export const scheduleCronSyntaxCheck: PostSynthCheck = {
  id: "FTN020",
  description: "Schedule cron must be five-field UTC cron (or a supported @nickname)",

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
            `Schedule "${name}" cron "${cron}" is not five-field cron syntax — ` +
            `fountain would store it and never fire it`,
          entity: name,
          lexicon: "fountain",
        });
      }
    }

    return diagnostics;
  },
};
