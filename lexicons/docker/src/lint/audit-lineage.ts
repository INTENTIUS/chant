/**
 * Prior art for these audit rules: the open-source tools whose checks cover the
 * same condition, credited per rule. See packages/core/src/audit/prior-art.ts for
 * the registry, the relation vocabulary, and why this is credit rather than
 * authority. Kept by hand; the prior-art sweep (scripts/prior-art-sweep.ts) reports
 * when a credited tool's index no longer lists a rule cited here.
 */
import type { Lineage } from "@intentius/chant/audit/catalog";

export const dockerAuditLineage: Record<string, Lineage[]> = {
  DKRD001: [
    { tool: "hadolint", rule: "DL3007", url: "https://github.com/hadolint/hadolint/wiki/DL3007", relation: "overlaps" },
    { tool: "checkov", rule: "CKV_DOCKER_7", url: "https://www.checkov.io/5.Policy%20Index/dockerfile.html", relation: "overlaps" },
    { tool: "kics", rule: "image_version_using_latest", url: "https://docs.kics.io/latest/queries/dockerfile-queries/f45ea400-6bbe-4501-9fc7-1c3d75c32067/", relation: "overlaps" },
  ],
  DKRD003: [
    { tool: "checkov", rule: "CKV_DOCKER_1", url: "https://www.checkov.io/5.Policy%20Index/dockerfile.html", relation: "overlaps" },
    { tool: "kics", rule: "Exposing Port 22 (SSH)", url: "https://docs.kics.io/latest/queries/dockerfile-queries/5907595b-5b6d-4142-b173-dbb0e73fbff8/", relation: "overlaps" },
  ],
  DKRD010: [
    { tool: "hadolint", rule: "DL3015", url: "https://github.com/hadolint/hadolint/wiki/DL3015", relation: "equivalent" },
    { tool: "kics", rule: "apt_get_not_avoiding_additional_packages", url: "https://docs.kics.io/latest/queries/dockerfile-queries/7384dfb2-fcd1-4fbf-91cd-6c44c318c33c/", relation: "equivalent" },
  ],
  DKRD011: [
    { tool: "hadolint", rule: "DL3020", url: "https://github.com/hadolint/hadolint/wiki/DL3020", relation: "equivalent" },
    { tool: "checkov", rule: "CKV_DOCKER_4", url: "https://www.checkov.io/5.Policy%20Index/dockerfile.html", relation: "overlaps" },
    { tool: "dockle", rule: "CIS-DI-0009", url: "https://github.com/goodwithtech/dockle/blob/master/CHECKPOINT.md#cis-di-0009", relation: "overlaps" },
  ],
  DKRD012: [
    { tool: "checkov", rule: "CKV_DOCKER_3", url: "https://www.checkov.io/5.Policy%20Index/dockerfile.html", relation: "equivalent" },
    { tool: "kics", rule: "missing_user_instruction", url: "https://docs.kics.io/latest/queries/dockerfile-queries/fd54f200-402c-4333-a5a4-36ef6709af2f/", relation: "equivalent" },
    { tool: "dockle", rule: "CIS-DI-0001", url: "https://github.com/goodwithtech/dockle/blob/master/CHECKPOINT.md#cis-di-0001", relation: "overlaps" },
  ],
};
