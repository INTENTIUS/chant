/**
 * Prior art for these audit rules: the open-source tools whose checks cover the
 * same condition, credited per rule. See packages/core/src/audit/prior-art.ts for
 * the registry, the relation vocabulary, and why this is credit rather than
 * authority. Kept by hand; the prior-art sweep (scripts/prior-art-sweep.ts) reports
 * when a credited tool's index no longer lists a rule cited here.
 */
import type { Lineage } from "@intentius/chant/audit/catalog";

export const k3sAuditLineage: Record<string, Lineage[]> = {
  K3S104: [
    { tool: "kube-bench", rule: "k3s-cis-1.8 1.1.13", url: "https://raw.githubusercontent.com/aquasecurity/kube-bench/main/cfg/k3s-cis-1.8/master.yaml", relation: "overlaps" },
  ],
};
