/**
 * Prior art for these audit rules: the open-source tools whose checks cover the
 * same condition, credited per rule. See packages/core/src/audit/prior-art.ts for
 * the registry, the relation vocabulary, and why this is credit rather than
 * authority. Kept by hand; the prior-art sweep (scripts/prior-art-sweep.ts) reports
 * when a credited tool's index no longer lists a rule cited here.
 */
import type { Lineage } from "@intentius/chant/audit/catalog";

export const cedarAuditLineage: Record<string, Lineage[]> = {
  CEDC001: [
    { tool: "cedar-docs", rule: "effect", url: "https://docs.cedarpolicy.com/policies/json-format.html#effect", relation: "overlaps" },
  ],
  CEDC010: [
    { tool: "cedar-cli", rule: "check-parse", url: "https://github.com/cedar-policy/cedar/tree/main/cedar-policy-cli", relation: "equivalent" },
  ],
  CEDC011: [
    { tool: "cedar-cli", rule: "check-parse", url: "https://github.com/cedar-policy/cedar/tree/main/cedar-policy-cli", relation: "overlaps" },
  ],
  CEDC012: [
    { tool: "cedar-policy-crate", rule: "PolicySetError::AlreadyDefined", url: "https://docs.rs/cedar-policy/latest/cedar_policy/enum.PolicySetError.html#variant.AlreadyDefined", relation: "overlaps" },
  ],
  CEDE010: [
    { tool: "cedar-validator", rule: "supported-validation-checks (errors)", url: "https://docs.cedarpolicy.com/policies/validation.html#supported-validation-checks", relation: "equivalent" },
  ],
  CEDE011: [
    { tool: "cedar-validator", rule: "supported-validation-checks (warnings)", url: "https://docs.cedarpolicy.com/policies/validation.html#supported-validation-checks", relation: "equivalent" },
  ],
  DWDE011: [
    { tool: "cedar-validator", rule: "supported-validation-checks (errors)", url: "https://docs.cedarpolicy.com/policies/validation.html#supported-validation-checks", relation: "overlaps" },
  ],
};
