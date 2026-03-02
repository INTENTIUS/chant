/**
 * AksExternalDnsAgent composite — Deployment + ServiceAccount + ClusterRole + ClusterRoleBinding.
 *
 * @aks Like ExternalDnsAgent but uses --provider=azure and AKS Workload Identity
 * instead of IRSA for Azure DNS management.
 */

export interface AksExternalDnsAgentProps {
  /** Azure managed identity client ID for Workload Identity. */
  clientId: string;
  /** Azure resource group containing the DNS zone. */
  resourceGroup: string;
  /** Azure subscription ID. */
  subscriptionId: string;
  /** Azure tenant ID. */
  tenantId: string;
  /** Domain filters — only manage DNS records for these domains. */
  domainFilters: string[];
  /** TXT record owner ID for identifying managed records. */
  txtOwnerId?: string;
  /** Source of DNS records (default: "ingress"). */
  source?: string;
  /** Agent name (default: "external-dns"). */
  name?: string;
  /** Container image (default: "registry.k8s.io/external-dns/external-dns:v0.14.0"). */
  image?: string;
  /** Namespace (default: "kube-system"). */
  namespace?: string;
  /** Additional labels. */
  labels?: Record<string, string>;
}

export interface AksExternalDnsAgentResult {
  deployment: Record<string, unknown>;
  serviceAccount: Record<string, unknown>;
  clusterRole: Record<string, unknown>;
  clusterRoleBinding: Record<string, unknown>;
}

/**
 * Create an AksExternalDnsAgent composite — returns prop objects for
 * a Deployment, ServiceAccount (with AKS Workload Identity), ClusterRole, and ClusterRoleBinding.
 *
 * @aks
 * @example
 * ```ts
 * import { AksExternalDnsAgent } from "@intentius/chant-lexicon-k8s";
 *
 * const { deployment, serviceAccount, clusterRole, clusterRoleBinding } = AksExternalDnsAgent({
 *   clientId: "00000000-0000-0000-0000-000000000000",
 *   resourceGroup: "my-rg",
 *   subscriptionId: "00000000-0000-0000-0000-000000000000",
 *   tenantId: "00000000-0000-0000-0000-000000000000",
 *   domainFilters: ["example.com"],
 *   txtOwnerId: "my-cluster",
 * });
 * ```
 */
export function AksExternalDnsAgent(props: AksExternalDnsAgentProps): AksExternalDnsAgentResult {
  const {
    clientId,
    resourceGroup,
    subscriptionId,
    tenantId,
    domainFilters,
    txtOwnerId,
    source = "ingress",
    name = "external-dns",
    image = "registry.k8s.io/external-dns/external-dns:v0.14.0",
    namespace = "kube-system",
    labels: extraLabels = {},
  } = props;

  const saName = `${name}-sa`;
  const clusterRoleName = `${name}-role`;
  const bindingName = `${name}-binding`;

  const commonLabels: Record<string, string> = {
    "app.kubernetes.io/name": name,
    "app.kubernetes.io/managed-by": "chant",
    ...extraLabels,
  };

  const args: string[] = [
    `--source=${source}`,
    "--provider=azure",
    `--azure-resource-group=${resourceGroup}`,
    `--azure-subscription-id=${subscriptionId}`,
    "--policy=upsert-only",
    "--registry=txt",
  ];

  for (const domain of domainFilters) {
    args.push(`--domain-filter=${domain}`);
  }

  if (txtOwnerId) {
    args.push(`--txt-owner-id=${txtOwnerId}`);
  }

  const deploymentProps: Record<string, unknown> = {
    metadata: {
      name,
      namespace,
      labels: { ...commonLabels, "app.kubernetes.io/component": "dns" },
    },
    spec: {
      replicas: 1,
      selector: { matchLabels: { "app.kubernetes.io/name": name } },
      template: {
        metadata: {
          labels: {
            "app.kubernetes.io/name": name,
            "azure.workload.identity/use": "true",
            ...extraLabels,
          },
        },
        spec: {
          serviceAccountName: saName,
          containers: [
            {
              name,
              image,
              args,
              env: [
                { name: "AZURE_TENANT_ID", value: tenantId },
                { name: "AZURE_SUBSCRIPTION_ID", value: subscriptionId },
                { name: "AZURE_RESOURCE_GROUP", value: resourceGroup },
              ],
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
  };

  const serviceAccountProps: Record<string, unknown> = {
    metadata: {
      name: saName,
      namespace,
      labels: {
        ...commonLabels,
        "app.kubernetes.io/component": "dns",
        "azure.workload.identity/use": "true",
      },
      annotations: {
        "azure.workload.identity/client-id": clientId,
      },
    },
  };

  const clusterRoleProps: Record<string, unknown> = {
    metadata: {
      name: clusterRoleName,
      labels: { ...commonLabels, "app.kubernetes.io/component": "rbac" },
    },
    rules: [
      { apiGroups: [""], resources: ["services", "endpoints", "pods"], verbs: ["get", "watch", "list"] },
      { apiGroups: ["extensions", "networking.k8s.io"], resources: ["ingresses"], verbs: ["get", "watch", "list"] },
      { apiGroups: [""], resources: ["nodes"], verbs: ["list", "watch"] },
    ],
  };

  const clusterRoleBindingProps: Record<string, unknown> = {
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
  };

  return {
    deployment: deploymentProps,
    serviceAccount: serviceAccountProps,
    clusterRole: clusterRoleProps,
    clusterRoleBinding: clusterRoleBindingProps,
  };
}
