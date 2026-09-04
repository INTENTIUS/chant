/**
 * Prior art for these audit rules: the open-source tools whose checks cover the
 * same condition, credited per rule. See packages/core/src/audit/prior-art.ts for
 * the registry, the relation vocabulary, and why this is credit rather than
 * authority. Kept by hand; the prior-art sweep (scripts/prior-art-sweep.ts) reports
 * when a credited tool's index no longer lists a rule cited here.
 */
import type { Lineage } from "@intentius/chant/audit/catalog";

export const helmAuditLineage: Record<string, Lineage[]> = {
  WHM005: [
    { tool: "helm-lint", rule: "templatesDirExists", url: "https://github.com/helm/helm/blob/main/pkg/chart/v2/lint/rules/template.go", relation: "overlaps" },
  ],
  WHM101: [
    { tool: "helm-lint", rule: "Chartfile (validateChartName, validateChartAPIVersion, validateChartVersion)", url: "https://github.com/helm/helm/blob/main/pkg/chart/v2/lint/rules/chartfile.go", relation: "equivalent" },
    { tool: "chart-testing", rule: "ct lint --chart-yaml-schema", url: "https://github.com/helm/chart-testing/blob/main/doc/ct_lint.md", relation: "overlaps" },
  ],
  WHM103: [
    { tool: "helm-lint", rule: "Templates (render error)", url: "https://github.com/helm/helm/blob/main/pkg/chart/v2/lint/rules/template.go", relation: "equivalent" },
  ],
  WHM302: [
    { tool: "kube-score", rule: "container-resources", url: "https://github.com/zegl/kube-score/blob/master/README_CHECKS.md", relation: "overlaps" },
    { tool: "kube-linter", rule: "unset-cpu-requirements", url: "https://github.com/stackrox/kube-linter/blob/main/docs/generated/checks.md#unset-cpu-requirements", relation: "overlaps" },
    { tool: "polaris", rule: "cpuRequestsMissing", url: "https://polaris.docs.fairwinds.com/checks/efficiency/", relation: "overlaps" },
  ],
  WHM401: [
    { tool: "kube-score", rule: "container-image-tag", url: "https://github.com/zegl/kube-score/blob/master/README_CHECKS.md", relation: "equivalent" },
    { tool: "kics", rule: "Invalid Image Tag", url: "https://docs.kics.io/latest/queries/kubernetes-queries/583053b7-e632-46f0-b989-f81ff8045385/", relation: "equivalent" },
    { tool: "datree", rule: "ensure-image-pinned-version", url: "https://hub.datree.io/built-in-rules/ensure-image-pinned-version", relation: "equivalent" },
  ],
  WHM402: [
    { tool: "kubesec", rule: "containers[] .securityContext .runAsNonRoot == true", url: "https://kubesec.io/basics/containers-securitycontext-runasnonroot-true/", relation: "equivalent" },
    { tool: "kics", rule: "Container Running As Root", url: "https://docs.kics.io/latest/queries/kubernetes-queries/cf34805e-3872-4c08-bf92-6ff7bb0cfadb/", relation: "equivalent" },
    { tool: "kube-score", rule: "container-security-context-user-group-id", url: "https://github.com/zegl/kube-score/blob/master/README_CHECKS.md", relation: "overlaps" },
  ],
  WHM403: [
    { tool: "kubesec", rule: "containers[] .securityContext .readOnlyRootFilesystem == true", url: "https://kubesec.io/basics/containers-securitycontext-readonlyrootfilesystem-true/", relation: "equivalent" },
    { tool: "kics", rule: "Root Container Not Mounted Read-only", url: "https://docs.kics.io/latest/queries/kubernetes-queries/a9c2f49d-0671-4fc9-9ece-f4e261e128d0/", relation: "equivalent" },
    { tool: "kube-score", rule: "container-security-context-readonlyrootfilesystem", url: "https://github.com/zegl/kube-score/blob/master/README_CHECKS.md", relation: "equivalent" },
  ],
  WHM404: [
    { tool: "kubesec", rule: "containers[] .securityContext .privileged == true", url: "https://kubesec.io/basics/containers-securitycontext-privileged-true/", relation: "equivalent" },
    { tool: "kics", rule: "Container Is Privileged", url: "https://docs.kics.io/latest/queries/kubernetes-queries/dd29336b-fe57-445b-a26e-e6aa867ae609/", relation: "equivalent" },
    { tool: "kube-score", rule: "container-security-context-privileged", url: "https://github.com/zegl/kube-score/blob/master/README_CHECKS.md", relation: "equivalent" },
  ],
  WHM405: [
    { tool: "checkov", rule: "CKV_K8S_10", url: "https://www.checkov.io/5.Policy%20Index/kubernetes.html", relation: "overlaps" },
    { tool: "checkov", rule: "CKV_K8S_12", url: "https://www.checkov.io/5.Policy%20Index/kubernetes.html", relation: "overlaps" },
    { tool: "kubesec", rule: "containers[] .resources .limits .memory", url: "https://kubesec.io/basics/containers-resources-limits-memory/", relation: "overlaps" },
  ],
  WHM407: [
    { tool: "kics", rule: "Using Kubernetes Native Secret Management", url: "https://docs.kics.io/latest/queries/kubernetes-queries/b9c83569-459b-4110-8f79-6305aa33cb37/", relation: "overlaps" },
  ],
  WHM502: [
    { tool: "pluto", rule: "detect-files", url: "https://github.com/FairwindsOps/pluto", relation: "equivalent" },
    { tool: "helm-lint", rule: "validateNoDeprecations", url: "https://github.com/helm/helm/blob/main/pkg/chart/v2/lint/rules/deprecations.go", relation: "equivalent" },
    { tool: "kube-score", rule: "stable-version", url: "https://github.com/zegl/kube-score/blob/master/README_CHECKS.md", relation: "equivalent" },
  ],
  WHM503: [
    { tool: "kics", rule: "Using Kubernetes Native Secret Management", url: "https://docs.kics.io/latest/queries/kubernetes-queries/b9c83569-459b-4110-8f79-6305aa33cb37/", relation: "overlaps" },
  ],
};
