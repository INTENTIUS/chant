/**
 * WorkloadIdentityServiceAccount composite — ServiceAccount + GKE Workload Identity annotation + optional RBAC.
 *
 * @gke Creates a ServiceAccount with the `iam.gke.io/gcp-service-account`
 * annotation for GKE Workload Identity Federation.
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import { ServiceAccount, Role, RoleBinding } from "../generated";

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
  /** Per-member defaults for fine-grained overrides. */
  defaults?: {
    serviceAccount?: Partial<Record<string, unknown>>;
    role?: Partial<Record<string, unknown>>;
    roleBinding?: Partial<Record<string, unknown>>;
  };
}

export interface WorkloadIdentityServiceAccountResult {
  serviceAccount: InstanceType<typeof ServiceAccount>;
  role?: InstanceType<typeof Role>;
  roleBinding?: InstanceType<typeof RoleBinding>;
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
export const WorkloadIdentityServiceAccount = Composite<WorkloadIdentityServiceAccountProps>((props) => {
  const {
    name,
    gcpServiceAccountEmail,
    rbacRules,
    labels: extraLabels = {},
    namespace,
    defaults: defs,
  } = props;

  const roleName = `${name}-role`;
  const bindingName = `${name}-binding`;

  const commonLabels: Record<string, string> = {
    "app.kubernetes.io/name": name,
    "app.kubernetes.io/managed-by": "chant",
    ...extraLabels,
  };

  const serviceAccount = new ServiceAccount(mergeDefaults({
    metadata: {
      name,
      ...(namespace && { namespace }),
      labels: { ...commonLabels, "app.kubernetes.io/component": "service-account" },
      annotations: {
        "iam.gke.io/gcp-service-account": gcpServiceAccountEmail,
      },
    },
  }, defs?.serviceAccount));

  const result: Record<string, any> = { serviceAccount };

  if (rbacRules && rbacRules.length > 0) {
    result.role = new Role(mergeDefaults({
      metadata: {
        name: roleName,
        ...(namespace && { namespace }),
        labels: { ...commonLabels, "app.kubernetes.io/component": "rbac" },
      },
      rules: rbacRules,
    }, defs?.role));

    result.roleBinding = new RoleBinding(mergeDefaults({
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
    }, defs?.roleBinding));
  }

  return result;
}, "WorkloadIdentityServiceAccount");
