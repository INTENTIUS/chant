/**
 * ExternalDnsAgent composite — Deployment + IRSA ServiceAccount + ClusterRole + ClusterRoleBinding.
 *
 * @eks ExternalDNS for Route53 DNS management. Common in production EKS setups
 * where Ingress/Service hostnames should automatically create DNS records.
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import { Deployment, ServiceAccount, ClusterRole, ClusterRoleBinding } from "../generated";

export interface ExternalDnsAgentProps {
  /** IAM Role ARN for IRSA (needs Route53 permissions). */
  iamRoleArn: string;
  /** Domain filters — only manage DNS records for these domains. */
  domainFilters: string[];
  /** DNS provider (default: "aws"). */
  provider?: string;
  /** Source of DNS records (default: "ingress"). */
  source?: string;
  /** TXT record owner ID for identifying managed records. */
  txtOwnerId?: string;
  /** Agent name (default: "external-dns"). */
  name?: string;
  /** Container image (default: "registry.k8s.io/external-dns/external-dns:v0.14.0"). */
  image?: string;
  /** Namespace (default: "kube-system"). */
  namespace?: string;
  /** Additional labels. */
  labels?: Record<string, string>;
  /** Per-member defaults for fine-grained overrides. */
  defaults?: {
    deployment?: Partial<Record<string, unknown>>;
    serviceAccount?: Partial<Record<string, unknown>>;
    clusterRole?: Partial<Record<string, unknown>>;
    clusterRoleBinding?: Partial<Record<string, unknown>>;
  };
}

export interface ExternalDnsAgentResult {
  deployment: InstanceType<typeof Deployment>;
  serviceAccount: InstanceType<typeof ServiceAccount>;
  clusterRole: InstanceType<typeof ClusterRole>;
  clusterRoleBinding: InstanceType<typeof ClusterRoleBinding>;
}

/**
 * Create an ExternalDnsAgent composite — returns prop objects for
 * a Deployment, ServiceAccount (with IRSA), ClusterRole, and ClusterRoleBinding.
 *
 * @eks
 * @example
 * ```ts
 * import { ExternalDnsAgent } from "@intentius/chant-lexicon-k8s";
 *
 * const { deployment, serviceAccount, clusterRole, clusterRoleBinding } = ExternalDnsAgent({
 *   iamRoleArn: "arn:aws:iam::123456789012:role/external-dns-role",
 *   domainFilters: ["example.com"],
 *   txtOwnerId: "my-cluster",
 * });
 * ```
 */
export const ExternalDnsAgent = Composite<ExternalDnsAgentProps>((props) => {
  const {
    iamRoleArn,
    domainFilters,
    provider = "aws",
    source = "ingress",
    txtOwnerId,
    name = "external-dns",
    image = "registry.k8s.io/external-dns/external-dns:v0.14.0",
    namespace = "kube-system",
    labels: extraLabels = {},
    defaults: defs,
  } = props;

  const saName = `${name}-sa`;
  const clusterRoleName = `${name}-role`;
  const bindingName = `${name}-binding`;

  const commonLabels: Record<string, string> = {
    "app.kubernetes.io/name": name,
    "app.kubernetes.io/managed-by": "chant",
    ...extraLabels,
  };

  // Build args for external-dns
  const args: string[] = [
    `--source=${source}`,
    `--provider=${provider}`,
    "--policy=upsert-only",
    "--registry=txt",
  ];

  for (const domain of domainFilters) {
    args.push(`--domain-filter=${domain}`);
  }

  if (txtOwnerId) {
    args.push(`--txt-owner-id=${txtOwnerId}`);
  }

  const deployment = new Deployment(mergeDefaults({
    metadata: {
      name,
      namespace,
      labels: { ...commonLabels, "app.kubernetes.io/component": "dns" },
    },
    spec: {
      replicas: 1,
      selector: { matchLabels: { "app.kubernetes.io/name": name } },
      template: {
        metadata: { labels: { "app.kubernetes.io/name": name, ...extraLabels } },
        spec: {
          serviceAccountName: saName,
          containers: [
            {
              name,
              image,
              args,
              resources: {
                requests: { cpu: "50m", memory: "64Mi" },
                limits: { cpu: "100m", memory: "128Mi" },
              },
              securityContext: {
                runAsNonRoot: true,
                runAsUser: 65534,
                readOnlyRootFilesystem: true,
                allowPrivilegeEscalation: false,
              },
            },
          ],
        },
      },
    },
  }, defs?.deployment));

  const serviceAccount = new ServiceAccount(mergeDefaults({
    metadata: {
      name: saName,
      namespace,
      labels: { ...commonLabels, "app.kubernetes.io/component": "dns" },
      annotations: {
        "eks.amazonaws.com/role-arn": iamRoleArn,
      },
    },
  }, defs?.serviceAccount));

  const clusterRole = new ClusterRole(mergeDefaults({
    metadata: {
      name: clusterRoleName,
      labels: { ...commonLabels, "app.kubernetes.io/component": "rbac" },
    },
    rules: [
      { apiGroups: [""], resources: ["services", "endpoints", "pods"], verbs: ["get", "watch", "list"] },
      { apiGroups: ["extensions", "networking.k8s.io"], resources: ["ingresses"], verbs: ["get", "watch", "list"] },
      { apiGroups: [""], resources: ["nodes"], verbs: ["list", "watch"] },
    ],
  }, defs?.clusterRole));

  const clusterRoleBinding = new ClusterRoleBinding(mergeDefaults({
    metadata: {
      name: bindingName,
      labels: { ...commonLabels, "app.kubernetes.io/component": "rbac" },
    },
    roleRef: {
      apiGroup: "rbac.authorization.k8s.io",
      kind: "ClusterRole",
      name: clusterRoleName,
    },
    subjects: [
      {
        kind: "ServiceAccount",
        name: saName,
        namespace,
      },
    ],
  }, defs?.clusterRoleBinding));

  return { deployment, serviceAccount, clusterRole, clusterRoleBinding };
}, "ExternalDnsAgent");
