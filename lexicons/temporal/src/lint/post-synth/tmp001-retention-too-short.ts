/**
 * TMP001: TemporalNamespace retention too short
 *
 * Workflow history older than the retention period is permanently deleted.
 * Retentions shorter than 3 days leave very little time for debugging
 * failures or running ad-hoc queries against closed workflow executions.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";

/** Parse a retention string like "1d", "12h", "3d" → total hours. Returns NaN on unrecognised format. */
function retentionHours(retention: string): number {
  const days = /^(\d+)d$/i.exec(retention);
  if (days) return Number(days[1]) * 24;
  const hours = /^(\d+)h$/i.exec(retention);
  if (hours) return Number(hours[1]);
  return NaN;
}

export const tmp001: PostSynthCheck = {
  id: "TMP001",
  description: "TemporalNamespace retention should be at least 3 days to preserve workflow history for debugging",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [name, entity] of ctx.entities) {
      const et = (entity as unknown as Record<string, unknown>).entityType as string;
      if (et !== "Temporal::Namespace") continue;

      const props = (entity as { props?: Record<string, unknown> }).props ?? {};
      const retention = props.retention as string | undefined;
      if (!retention) continue; // default "7d" — not an error

      const hours = retentionHours(retention);
      if (isNaN(hours)) continue; // unrecognised format — skip

      if (hours < 72) {
        diagnostics.push({
          checkId: "TMP001",
          severity: "error",
          message: `Namespace "${name}" has retention "${retention}" — minimum recommended is 3d (72h) to preserve workflow history. Set retention to at least "3d" — e.g. retention: "7d"`,
          entity: name,
          lexicon: "temporal",
        });
      }
    }

    return diagnostics;
  },
};
