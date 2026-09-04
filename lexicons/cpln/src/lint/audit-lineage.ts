/**
 * Prior art for these audit rules: the open-source tools whose checks cover the
 * same condition, credited per rule. See packages/core/src/audit/prior-art.ts for
 * the registry, the relation vocabulary, and why this is credit rather than
 * authority. Kept by hand; the prior-art sweep (scripts/prior-art-sweep.ts) reports
 * when a credited tool's index no longer lists a rule cited here.
 */
import type { Lineage } from "@intentius/chant/audit/catalog";

export const cplnAuditLineage: Record<string, Lineage[]> = {
  CPL020: [
    { tool: "controlplane-docs", rule: "Workload types: serverless", url: "https://docs.controlplane.com/reference/workload/types", relation: "overlaps" },
  ],
  CPL021: [
    { tool: "controlplane-docs", rule: "Workload types: cron", url: "https://docs.controlplane.com/reference/workload/types", relation: "overlaps" },
  ],
  CPL026: [
    { tool: "controlplane-docs", rule: "Autoscaling: scale to zero", url: "https://docs.controlplane.com/reference/workload/autoscaling", relation: "overlaps" },
  ],
  CPL027: [
    { tool: "controlplane-docs", rule: "Autoscaling: Capacity AI", url: "https://docs.controlplane.com/reference/workload/autoscaling", relation: "overlaps" },
  ],
  CPL028: [
    { tool: "controlplane-docs", rule: "Volume set: performance classes / file system type", url: "https://docs.controlplane.com/reference/volumeset#performance-classes", relation: "overlaps" },
  ],
  CPL029: [
    { tool: "controlplane-docs", rule: "Identity: GVC scope", url: "https://docs.controlplane.com/reference/identity", relation: "overlaps" },
  ],
  CPL030: [
    { tool: "controlplane-docs", rule: "Domain: apex domain considerations", url: "https://docs.controlplane.com/reference/domain#apex-domain-considerations", relation: "overlaps" },
  ],
  CPL040: [
    { tool: "controlplane-docs", rule: "Image: tags and digests", url: "https://docs.controlplane.com/reference/image#image-tags-and-digests", relation: "overlaps" },
  ],
  CPL041: [
    { tool: "controlplane-docs", rule: "Image: reference formats", url: "https://docs.controlplane.com/reference/image#image-reference-formats", relation: "overlaps" },
  ],
  CPL042: [
    { tool: "controlplane-docs", rule: "GVC locations", url: "https://docs.controlplane.com/reference/gvc#gvc-locations", relation: "overlaps" },
  ],
};
