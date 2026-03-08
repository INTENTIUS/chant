/**
 * IrsaServiceAccount composite — ServiceAccount + IAM annotation + optional RBAC.
 *
 * @eks Creates a ServiceAccount with the `eks.amazonaws.com/role-arn`
 * annotation for IAM Roles for Service Accounts (IRSA).
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import { ServiceAccount, Role, RoleBinding } from "../generated";

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
  /** Per-member defaults for fine-grained overrides. */
  defaults?: {
    serviceAccount?: Partial<Record<string, unknown>>;
    role?: Partial<Record<string, unknown>>;
    roleBinding?: Partial<Record<string, unknown>>;
  };
}

export interface IrsaServiceAccountResult {
  serviceAccount: InstanceType<typeof ServiceAccount>;
  role?: InstanceType<typeof Role>;
  roleBinding?: InstanceType<typeof RoleBinding>;
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
export const IrsaServiceAccount = Composite<IrsaServiceAccountProps>((props) => {
  const {
    name,
    iamRoleArn,
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
        "eks.amazonaws.com/role-arn": iamRoleArn,
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
}, "IrsaServiceAccount");
