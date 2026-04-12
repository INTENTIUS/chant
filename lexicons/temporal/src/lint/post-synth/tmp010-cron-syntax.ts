/**
 * TMP010: TemporalSchedule cron expression syntax
 *
 * Validates that cron expressions in TemporalSchedule.spec.cronExpressions
 * are valid 5- or 6-field cron syntax. Malformed crons are silently ignored
 * by Temporal's scheduler, leading to schedules that never fire.
 *
 * This is a pre-submission guard — final validation is Temporal's own parser.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";

/** Very permissive cron field pattern — catches obvious syntax errors. */
const CRON_FIELD = /^[0-9*,/\-?LW#]+$/;

function isValidCronExpression(expr: string): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length < 5 || fields.length > 6) return false;
  return fields.every((f) => CRON_FIELD.test(f));
}

export const tmp010: PostSynthCheck = {
  id: "TMP010",
  description: "TemporalSchedule cron expressions must be valid 5- or 6-field cron syntax",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [lexicon, output] of ctx.outputs) {
      if (lexicon !== "temporal") continue;

      // Schedules emit individual TypeScript files — check the schedules/ files.
      const files =
        typeof output === "string"
          ? new Map<string, string>()
          : (output as { primary: string; files?: Record<string, string> }).files
            ? new Map(Object.entries((output as { files: Record<string, string> }).files))
            : new Map<string, string>();

      for (const [filename, content] of files) {
        if (!filename.startsWith("schedules/")) continue;

        // Extract cron expressions from the generated TypeScript:
        // cronExpressions: ["0 3 * * *"]
        const cronMatches = [...content.matchAll(/cronExpressions:\s*\[([^\]]+)\]/g)];
        for (const match of cronMatches) {
          const exprs = [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
          for (const expr of exprs) {
            if (!isValidCronExpression(expr)) {
              diagnostics.push({
                checkId: "TMP010",
                severity: "warning",
                message: `${filename}: cron expression "${expr}" does not look like valid 5- or 6-field cron syntax`,
                lexicon: "temporal",
              });
            }
          }
        }
      }
    }

    return diagnostics;
  },
};
