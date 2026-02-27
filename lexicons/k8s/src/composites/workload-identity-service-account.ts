/**
 * WorkloadIdentityServiceAccount composite — ServiceAccount + GKE Workload Identity annotation + optional RBAC.
 *
 * @gke Creates a ServiceAccount with the `iam.gke.io/gcp-service-account`
 * annotation for GKE Workload Identity Federation.
 */

export interface WorkloadIdentityServiceAccountProps {
  /** ServiceAccount name — used in metadata and labels. */
  name: string;
  /** GCP service account email for Workload Identity annotation. */
  gcpServiceAccountEmail: string;
  /** Optional RBAC rules — if provided, creates Role + RoleBinding. */
  rbacRules?: Array<{
    apiGroups: string[];
    resources: string[];
    verbs: string[];
  }>;
  /** Additional labels to apply to all resources. */
  labels?: Record<string, string>;
  /** Namespace for all resources. */
  namespace?: string;
}

export interface WorkloadIdentityServiceAccountResult {
  serviceAccount: Record<string, unknown>;
  role?: Record<string, unknown>;
  roleBinding?: Record<string, unknown>;
}

/**
 * Create a WorkloadIdentityServiceAccount composite — returns prop objects for
 * a ServiceAccount with GKE Workload Identity annotation, and optional Role + RoleBinding.
 *
 * @gke
 * @example
 * ```ts
 * import { WorkloadIdentityServiceAccount } from "@intentius/chant-lexicon-k8s";
 *
 * const { serviceAccount, role, roleBinding } = WorkloadIdentityServiceAccount({
 *   name: "app-sa",
 *   gcpServiceAccountEmail: "sa@my-project.iam.gserviceaccount.com",
 *   rbacRules: [
 *     { apiGroups: [""], resources: ["secrets"], verbs: ["get"] },
 *   ],
 * });
 * ```
 */
export function WorkloadIdentityServiceAccount(
  props: WorkloadIdentityServiceAccountProps,
): WorkloadIdentityServiceAccountResult {
  const {
    name,
    gcpServiceAccountEmail,
    rbacRules,
    labels: extraLabels = {},
    namespace,
  } = props;

  const roleName = `${name}-role`;
  const bindingName = `${name}-binding`;

  const commonLabels: Record<string, string> = {
    "app.kubernetes.io/name": name,
    "app.kubernetes.io/managed-by": "chant",
    ...extraLabels,
  };

  const serviceAccountProps: Record<string, unknown> = {
    metadata: {
      name,
      ...(namespace && { namespace }),
      labels: { ...commonLabels, "app.kubernetes.io/component": "service-account" },
      annotations: {
        "iam.gke.io/gcp-service-account": gcpServiceAccountEmail,
      },
    },
  };

  const result: WorkloadIdentityServiceAccountResult = {
    serviceAccount: serviceAccountProps,
  };

  if (rbacRules && rbacRules.length > 0) {
    result.role = {
      metadata: {
        name: roleName,
        ...(namespace && { namespace }),
        labels: { ...commonLabels, "app.kubernetes.io/component": "rbac" },
      },
      rules: rbacRules,
    };

    result.roleBinding = {
      metadata: {
        name: bindingName,
        ...(namespace && { namespace }),
        labels: { ...commonLabels, "app.kubernetes.io/component": "rbac" },
      },
      roleRef: {
        apiGroup: "rbac.authorization.k8s.io",
        kind: "Role",
        name: roleName,
      },
      subjects: [
        {
          kind: "ServiceAccount",
          name,
          ...(namespace && { namespace }),
        },
      ],
    };
  }

  return result;
}
