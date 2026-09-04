/**
 * Prior art for these audit rules: the open-source tools whose checks cover the
 * same condition, credited per rule. See packages/core/src/audit/prior-art.ts for
 * the registry, the relation vocabulary, and why this is credit rather than
 * authority. Kept by hand; the prior-art sweep (scripts/prior-art-sweep.ts) reports
 * when a credited tool's index no longer lists a rule cited here.
 */
import type { Lineage } from "@intentius/chant/audit/catalog";

export const flyAuditLineage: Record<string, Lineage[]> = {
  FLY010: [
    { tool: "fly-docs", rule: "Create a Machine: config.image required", url: "https://fly.io/docs/machines/api/machines-resource/#create-a-machine", relation: "overlaps" },
  ],
};
