/**
 * Prior art for these audit rules: the open-source tools whose checks cover the
 * same condition, credited per rule. See packages/core/src/audit/prior-art.ts for
 * the registry, the relation vocabulary, and why this is credit rather than
 * authority. Kept by hand; the prior-art sweep (scripts/prior-art-sweep.ts) reports
 * when a credited tool's index no longer lists a rule cited here.
 */
import type { Lineage } from "@intentius/chant/audit/catalog";

export const k8sAuditLineage: Record<string, Lineage[]> = {
  FLUX002: [
    { tool: "flux-docs", rule: ".spec.sourceRef", url: "https://fluxcd.io/flux/components/kustomize/kustomizations/#source-reference", relation: "overlaps" },
  ],
  FLUX003: [
    { tool: "flux-docs", rule: ".spec.dependsOn", url: "https://fluxcd.io/flux/components/kustomize/kustomizations/#dependencies", relation: "overlaps" },
  ],
  WK8005: [
    { tool: "polaris", rule: "sensitiveContainerEnvVar", url: "https://polaris.docs.fairwinds.com/checks/security/", relation: "overlaps" },
    { tool: "kube-linter", rule: "env-var-secret", url: "https://github.com/stackrox/kube-linter/blob/main/docs/generated/checks.md#env-var-secret", relation: "overlaps" },
  ],
  WK8006: [
    { tool: "kube-linter", rule: "latest-tag", url: "https://github.com/stackrox/kube-linter/blob/main/docs/generated/checks.md#latest-tag", relation: "equivalent" },
    { tool: "polaris", rule: "tagNotSpecified", url: "https://polaris.docs.fairwinds.com/checks/reliability/", relation: "equivalent" },
    { tool: "checkov", rule: "CKV_K8S_14", url: "https://www.checkov.io/5.Policy%20Index/kubernetes.html", relation: "equivalent" },
  ],
  WK8041: [
    { tool: "polaris", rule: "sensitiveContainerEnvVar", url: "https://polaris.docs.fairwinds.com/checks/security/", relation: "overlaps" },
    { tool: "kube-linter", rule: "env-var-secret", url: "https://github.com/stackrox/kube-linter/blob/main/docs/generated/checks.md#env-var-secret", relation: "overlaps" },
    { tool: "datree", rule: "prevent-exposed-secrets-aws", url: "https://hub.datree.io/built-in-rules/prevent-exposed-secrets-aws", relation: "overlaps" },
  ],
  WK8042: [
    { tool: "polaris", rule: "sensitiveConfigmapContent", url: "https://polaris.docs.fairwinds.com/checks/security/", relation: "overlaps" },
    { tool: "datree", rule: "prevent-exposed-secrets-privatekey", url: "https://hub.datree.io/built-in-rules/prevent-exposed-secrets-privatekey", relation: "overlaps" },
  ],
  WK8101: [
    { tool: "kube-linter", rule: "mismatching-selector", url: "https://github.com/stackrox/kube-linter/blob/main/docs/generated/checks.md#mismatching-selector", relation: "equivalent" },
    { tool: "kube-score", rule: "deployment-pod-selector-labels-match-template-metadata-labels", url: "https://github.com/zegl/kube-score/blob/master/README_CHECKS.md", relation: "equivalent" },
  ],
  WK8105: [
    { tool: "polaris", rule: "pullPolicyNotAlways", url: "https://polaris.docs.fairwinds.com/checks/reliability/", relation: "overlaps" },
    { tool: "kube-score", rule: "container-image-pull-policy", url: "https://github.com/zegl/kube-score/blob/master/README_CHECKS.md", relation: "overlaps" },
    { tool: "checkov", rule: "CKV_K8S_15", url: "https://www.checkov.io/5.Policy%20Index/kubernetes.html", relation: "overlaps" },
  ],
  WK8201: [
    { tool: "polaris", rule: "cpuLimitsMissing", url: "https://polaris.docs.fairwinds.com/checks/efficiency/", relation: "overlaps" },
    { tool: "checkov", rule: "CKV_K8S_13", url: "https://www.checkov.io/5.Policy%20Index/kubernetes.html", relation: "overlaps" },
    { tool: "kube-score", rule: "container-resources", url: "https://github.com/zegl/kube-score/blob/master/README_CHECKS.md", relation: "overlaps" },
  ],
  WK8202: [
    { tool: "kube-linter", rule: "privileged-container", url: "https://github.com/stackrox/kube-linter/blob/main/docs/generated/checks.md#privileged-container", relation: "equivalent" },
    { tool: "polaris", rule: "runAsPrivileged", url: "https://polaris.docs.fairwinds.com/checks/security/", relation: "equivalent" },
    { tool: "checkov", rule: "CKV_K8S_16", url: "https://www.checkov.io/5.Policy%20Index/kubernetes.html", relation: "equivalent" },
  ],
  WK8203: [
    { tool: "kube-linter", rule: "no-read-only-root-fs", url: "https://github.com/stackrox/kube-linter/blob/main/docs/generated/checks.md#no-read-only-root-fs", relation: "equivalent" },
    { tool: "polaris", rule: "notReadOnlyRootFilesystem", url: "https://polaris.docs.fairwinds.com/checks/security/", relation: "equivalent" },
    { tool: "checkov", rule: "CKV_K8S_22", url: "https://www.checkov.io/5.Policy%20Index/kubernetes.html", relation: "equivalent" },
  ],
  WK8204: [
    { tool: "polaris", rule: "runAsRootAllowed", url: "https://polaris.docs.fairwinds.com/checks/security/", relation: "equivalent" },
    { tool: "checkov", rule: "CKV_K8S_23", url: "https://www.checkov.io/5.Policy%20Index/kubernetes.html", relation: "equivalent" },
    { tool: "kube-linter", rule: "run-as-non-root", url: "https://github.com/stackrox/kube-linter/blob/main/docs/generated/checks.md#run-as-non-root", relation: "overlaps" },
  ],
  WK8205: [
    { tool: "kubesec", rule: "containers[] .securityContext .capabilities .drop | index(\"ALL\")", url: "https://kubesec.io/basics/containers-securitycontext-capabilities-drop-index-all/", relation: "equivalent" },
    { tool: "kics", rule: "No Drop Capabilities for Containers", url: "https://docs.kics.io/latest/queries/kubernetes-queries/268ca686-7fb7-4ae9-b129-955a2a89064e/", relation: "overlaps" },
    { tool: "kube-linter", rule: "drop-net-raw-capability", url: "https://github.com/stackrox/kube-linter/blob/main/docs/generated/checks.md#drop-net-raw-capability", relation: "overlaps" },
  ],
  WK8207: [
    { tool: "kube-linter", rule: "host-network", url: "https://github.com/stackrox/kube-linter/blob/main/docs/generated/checks.md#host-network", relation: "equivalent" },
    { tool: "polaris", rule: "hostNetworkSet", url: "https://polaris.docs.fairwinds.com/checks/security/", relation: "equivalent" },
    { tool: "checkov", rule: "CKV_K8S_19", url: "https://www.checkov.io/5.Policy%20Index/kubernetes.html", relation: "equivalent" },
  ],
  WK8208: [
    { tool: "kube-linter", rule: "host-pid", url: "https://github.com/stackrox/kube-linter/blob/main/docs/generated/checks.md#host-pid", relation: "equivalent" },
    { tool: "polaris", rule: "hostPIDSet", url: "https://polaris.docs.fairwinds.com/checks/security/", relation: "equivalent" },
    { tool: "checkov", rule: "CKV_K8S_17", url: "https://www.checkov.io/5.Policy%20Index/kubernetes.html", relation: "equivalent" },
  ],
  WK8209: [
    { tool: "kube-linter", rule: "host-ipc", url: "https://github.com/stackrox/kube-linter/blob/main/docs/generated/checks.md#host-ipc", relation: "equivalent" },
    { tool: "polaris", rule: "hostIPCSet", url: "https://polaris.docs.fairwinds.com/checks/security/", relation: "equivalent" },
    { tool: "checkov", rule: "CKV_K8S_18", url: "https://www.checkov.io/5.Policy%20Index/kubernetes.html", relation: "equivalent" },
  ],
  WK8301: [
    { tool: "kube-score", rule: "pod-probes", url: "https://github.com/zegl/kube-score/blob/master/README_CHECKS.md", relation: "overlaps" },
    { tool: "polaris", rule: "readinessProbeMissing", url: "https://polaris.docs.fairwinds.com/checks/reliability/", relation: "overlaps" },
    { tool: "checkov", rule: "CKV_K8S_8", url: "https://www.checkov.io/5.Policy%20Index/kubernetes.html", relation: "overlaps" },
  ],
  WK8302: [
    { tool: "polaris", rule: "deploymentMissingReplicas", url: "https://polaris.docs.fairwinds.com/checks/reliability/", relation: "equivalent" },
    { tool: "kube-score", rule: "deployment-replicas", url: "https://github.com/zegl/kube-score/blob/master/README_CHECKS.md", relation: "equivalent" },
    { tool: "datree", rule: "ensure-minimum-two-replicas", url: "https://hub.datree.io/built-in-rules/ensure-minimum-two-replicas", relation: "equivalent" },
  ],
  WK8303: [
    { tool: "kube-score", rule: "deployment-has-poddisruptionbudget", url: "https://github.com/zegl/kube-score/blob/master/README_CHECKS.md", relation: "overlaps" },
    { tool: "polaris", rule: "missingPodDisruptionBudget", url: "https://polaris.docs.fairwinds.com/checks/reliability/", relation: "overlaps" },
    { tool: "kics", rule: "Deployment Without PodDisruptionBudget", url: "https://docs.kics.io/latest/queries/kubernetes-queries/b23e9b98-0cb6-4fc9-b257-1f3270442678/", relation: "overlaps" },
  ],
  WK8304: [
    { tool: "polaris", rule: "tlsSettingsMissing", url: "https://polaris.docs.fairwinds.com/checks/security/", relation: "overlaps" },
  ],
  WK8305: [
    { tool: "kube-linter", rule: "dangling-ingress", url: "https://github.com/stackrox/kube-linter/blob/main/docs/generated/checks.md#dangling-ingress", relation: "overlaps" },
    { tool: "kube-score", rule: "ingress-targets-service", url: "https://github.com/zegl/kube-score/blob/master/README_CHECKS.md", relation: "overlaps" },
  ],
  WK8405: [
    { tool: "kube-score", rule: "deployment-has-poddisruptionbudget", url: "https://github.com/zegl/kube-score/blob/master/README_CHECKS.md", relation: "overlaps" },
    { tool: "polaris", rule: "missingPodDisruptionBudget", url: "https://polaris.docs.fairwinds.com/checks/reliability/", relation: "overlaps" },
  ],
  WK8406: [
    { tool: "checkov", rule: "CKV_K8S_13", url: "https://www.checkov.io/5.Policy%20Index/kubernetes.html", relation: "overlaps" },
    { tool: "kube-score", rule: "container-resources", url: "https://github.com/zegl/kube-score/blob/master/README_CHECKS.md", relation: "overlaps" },
    { tool: "kube-linter", rule: "unset-memory-requirements", url: "https://github.com/stackrox/kube-linter/blob/main/docs/generated/checks.md#unset-memory-requirements", relation: "overlaps" },
  ],
  WK8501: [
    { tool: "kube-linter", rule: "schema-validation", url: "https://github.com/stackrox/kube-linter/blob/main/docs/generated/checks.md#schema-validation", relation: "overlaps" },
  ],
  WK8502: [
    { tool: "kube-linter", rule: "schema-validation", url: "https://github.com/stackrox/kube-linter/blob/main/docs/generated/checks.md#schema-validation", relation: "overlaps" },
  ],
  WK8503: [
    { tool: "kube-linter", rule: "env-value-from", url: "https://github.com/stackrox/kube-linter/blob/main/docs/generated/checks.md#env-value-from", relation: "overlaps" },
  ],
  WK8505: [
    { tool: "flux-docs", rule: ".spec.decryption", url: "https://fluxcd.io/flux/components/kustomize/kustomizations/#decryption", relation: "overlaps" },
  ],
};
