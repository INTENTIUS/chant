/**
 * IrsaServiceAccount composite — ServiceAccount + IAM annotation + optional RBAC.
 *
 * @eks Creates a ServiceAccount with the `eks.amazonaws.com/role-arn`
 * annotation for IAM Roles for Service Accounts (IRSA).
 */

export interface IrsaServiceAccountProps {
  /** ServiceAccount name — used in metadata and labels. */
  name: string;
  /** IAM Role ARN for IRSA annotation. */
  iamRoleArn: string;
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

export interface IrsaServiceAccountResult {
  serviceAccount: Record<string, unknown>;
  role?: Record<string, unknown>;
  roleBinding?: Record<string, unknown>;
}

/**
 * Create an IrsaServiceAccount composite — returns prop objects for
 * a ServiceAccount with IRSA annotation, and optional Role + RoleBinding.
 *
 * @eks
 * @example
 * ```ts
 * import { IrsaServiceAccount } from "@intentius/chant-lexicon-k8s";
 *
 * const { serviceAccount, role, roleBinding } = IrsaServiceAccount({
 *   name: "app-sa",
 *   iamRoleArn: "arn:aws:iam::123456789012:role/my-app-role",
 *   rbacRules: [
 *     { apiGroups: [""], resources: ["secrets"], verbs: ["get"] },
 *   ],
 * });
 * ```
 */
export function IrsaServiceAccount(props: IrsaServiceAccountProps): IrsaServiceAccountResult {
  const {
    name,
    iamRoleArn,
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
        "eks.amazonaws.com/role-arn": iamRoleArn,
      },
    },
  };

  const result: IrsaServiceAccountResult = {
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
