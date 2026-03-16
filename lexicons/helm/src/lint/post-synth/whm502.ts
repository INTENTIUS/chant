/**
 * WHM502: K8s API version/kind validation.
 *
 * Checks for deprecated or invalid Kubernetes API versions in templates
 * and suggests replacements.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getChartFiles } from "./helm-helpers";

/**
 * Deprecated API versions with their replacements.
 */
const DEPRECATED_APIS: Record<string, { replacement: string; kinds: string[] }> = {
  "extensions/v1beta1": {
    replacement: "networking.k8s.io/v1",
    kinds: ["Ingress"],
  },
  "networking.k8s.io/v1beta1": {
    replacement: "networking.k8s.io/v1",
    kinds: ["Ingress", "IngressClass"],
  },
  "apps/v1beta1": {
    replacement: "apps/v1",
    kinds: ["Deployment", "StatefulSet"],
  },
  "apps/v1beta2": {
    replacement: "apps/v1",
    kinds: ["Deployment", "StatefulSet", "DaemonSet", "ReplicaSet"],
  },
  "rbac.authorization.k8s.io/v1beta1": {
    replacement: "rbac.authorization.k8s.io/v1",
    kinds: ["ClusterRole", "ClusterRoleBinding", "Role", "RoleBinding"],
  },
  "admissionregistration.k8s.io/v1beta1": {
    replacement: "admissionregistration.k8s.io/v1",
    kinds: ["MutatingWebhookConfiguration", "ValidatingWebhookConfiguration"],
  },
  "batch/v1beta1": {
    replacement: "batch/v1",
    kinds: ["CronJob"],
  },
  "policy/v1beta1": {
    replacement: "policy/v1",
    kinds: ["PodDisruptionBudget", "PodSecurityPolicy"],
  },
  "autoscaling/v2beta1": {
    replacement: "autoscaling/v2",
    kinds: ["HorizontalPodAutoscaler"],
  },
  "autoscaling/v2beta2": {
    replacement: "autoscaling/v2",
    kinds: ["HorizontalPodAutoscaler"],
  },
};

export const whm502: PostSynthCheck = {
  id: "WHM502",
  description: "Detect deprecated or invalid Kubernetes API versions",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const files = getChartFiles(output);

      for (const [filename, content] of Object.entries(files)) {
        if (!filename.startsWith("templates/") || filename.endsWith("_helpers.tpl") || filename.endsWith("NOTES.txt")) continue;

        // Extract apiVersion from template
        const apiVersionMatch = content.match(/apiVersion:\s*(.+)/);
        if (!apiVersionMatch) continue;

        const apiVersion = apiVersionMatch[1].trim();

        // Skip template expressions
        if (apiVersion.includes("{{")) continue;

        const deprecation = DEPRECATED_APIS[apiVersion];
        if (deprecation) {
          diagnostics.push({
            checkId: "WHM502",
            severity: "warning",
            message: `${filename}: apiVersion "${apiVersion}" is deprecated — use "${deprecation.replacement}" instead`,
            entity: filename,
            lexicon: "helm",
          });
        }
      }
    }

    return diagnostics;
  },
};
