/**
 * The temporal lexicon's chant audit catalog — metadata for the TMP post-synth
 * checks, contributed via `temporalPlugin.auditCatalog()` (#687).
 *
 * Three of the four read the chant model (`ctx.entities`) rather than the
 * emitted output, so they carry `yamlBased: false` and cannot fire on an audit
 * of standalone Temporal config; TMP010 reads `ctx.outputs` and can.
 * `auditRule()` hardcodes `yamlBased: true`, so these are constructed directly.
 *
 * Without this the four checks reached `chant audit` with no title, tier, fix
 * kind, or category at all — `resolveAuditCatalog` contributes nothing for a
 * lexicon that omits the method, silently (#1346).
 */

import type { RuleMeta } from "@intentius/chant/audit/catalog";

function rule(
  id: string,
  tier: RuleMeta["tier"],
  category: RuleMeta["category"],
  title: string,
  remediation: string,
  yamlBased = false,
): RuleMeta {
  return { id, tier, fixKind: "guidance", category, title, remediation, yamlBased };
}

export const temporalAuditCatalog: Record<string, RuleMeta> = {
  TMP001: rule(
    "TMP001",
    "merge-worthy",
    "best-practice",
    "Namespace retention is shorter than three days",
    "Raise `retentionDays` to at least 3 so a failed workflow's history survives long enough to debug.",
  ),
  TMP002: rule(
    "TMP002",
    "report-only",
    "best-practice",
    "Schedule allows overlapping runs without saying why",
    "Set `state.note` explaining why concurrent runs are safe, or use a non-overlapping policy.",
  ),
  TMP010: rule(
    "TMP010",
    "merge-worthy",
    "correctness",
    "Schedule cron expression is not valid cron syntax",
    "Use a 5- or 6-field cron expression; an invalid one is rejected by the server, not by chant.",
    true,
  ),
  TMP011: rule(
    "TMP011",
    "merge-worthy",
    "correctness",
    "Search attribute references an undeclared namespace",
    "Point `namespace` at a TemporalNamespace declared in the same stack.",
  ),
};
