/**
 * Prior art for these audit rules: the open-source tools whose checks cover the
 * same condition, credited per rule. See packages/core/src/audit/prior-art.ts for
 * the registry, the relation vocabulary, and why this is credit rather than
 * authority. Kept by hand; the prior-art sweep (scripts/prior-art-sweep.ts) reports
 * when a credited tool's index no longer lists a rule cited here.
 */
import type { Lineage } from "@intentius/chant/audit/catalog";

export const fountainAuditLineage: Record<string, Lineage[]> = {
  FTN015: [
    { tool: "agent-audit", rule: "auth-bypass/env-secret-in-config", url: "https://raw.githubusercontent.com/piiiico/agent-audit/main/README.md", relation: "overlaps" },
    { tool: "mcp-audit", rule: "Secrets Detection", url: "https://raw.githubusercontent.com/apisec-inc/mcp-audit/main/README.md", relation: "overlaps" },
  ],
};
