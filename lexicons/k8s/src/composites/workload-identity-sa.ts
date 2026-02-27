/**
 * WorkloadIdentityServiceAccount composite — ServiceAccount + Workload Identity annotation + optional RBAC.
 *
 * @aks Creates a ServiceAccount with the `azure.workload.identity/client-id`
 * annotation and `azure.workload.identity/use: "true"` label for AKS Workload Identity.
 */

export interface WorkloadIdentityServiceAccountProps {
  /** ServiceAccount name — used in metadata and labels. */
  name: string;
  /** Azure AD application client ID for Workload Identity. */
  clientId: string;
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
 * a ServiceAccount with AKS Workload Identity annotation, and optional Role + RoleBinding.
 *
 * @aks
 * @example
 * ```ts
 * import { WorkloadIdentityServiceAccount } from "@intentius/chant-lexicon-k8s";
 *
 * const { serviceAccount, role, roleBinding } = WorkloadIdentityServiceAccount({
 *   name: "app-sa",
 *   clientId: "00000000-0000-0000-0000-000000000000",
 *   rbacRules: [
 *     { apiGroups: [""], resources: ["secrets"], verbs: ["get"] },
 *   ],
 * });
 * ```
 */
export function WorkloadIdentityServiceAccount(props: WorkloadIdentityServiceAccountProps): WorkloadIdentityServiceAccountResult {
  const {
    name,
    clientId,
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
      labels: {
        ...commonLabels,
        "app.kubernetes.io/component": "service-account",
        "azure.workload.identity/use": "true",
      },
      annotations: {
        "azure.workload.identity/client-id": clientId,
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
