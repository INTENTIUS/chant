/**
 * Prior art for these audit rules: the open-source tools whose checks cover the
 * same condition, credited per rule. See packages/core/src/audit/prior-art.ts for
 * the registry, the relation vocabulary, and why this is credit rather than
 * authority. Kept by hand; the prior-art sweep (scripts/prior-art-sweep.ts) reports
 * when a credited tool's index no longer lists a rule cited here.
 */
import type { Lineage } from "@intentius/chant/audit/catalog";

export const renderAuditLineage: Record<string, Lineage[]> = {
  REN010: [
    { tool: "render-docs", rule: "buildCommand / startCommand", url: "https://render.com/docs/blueprint-spec#buildcommand", relation: "overlaps" },
  ],
  REN012: [
    { tool: "render-docs", rule: "Free web services limitations", url: "https://render.com/docs/free#persistent-disks", relation: "overlaps" },
  ],
};
