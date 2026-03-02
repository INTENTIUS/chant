/**
 * GkeExternalDnsAgent composite — Deployment + ServiceAccount + ClusterRole + ClusterRoleBinding.
 *
 * @gke Like ExternalDnsAgent but uses --provider=google and GKE Workload Identity
 * instead of IRSA for Cloud DNS management.
 */

export interface GkeExternalDnsAgentProps {
  /** GCP service account email for Workload Identity (needs Cloud DNS permissions). */
  gcpServiceAccountEmail: string;
  /** GCP project ID. */
  gcpProjectId: string;
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

export interface GkeExternalDnsAgentResult {
  deployment: Record<string, unknown>;
  serviceAccount: Record<string, unknown>;
  clusterRole: Record<string, unknown>;
  clusterRoleBinding: Record<string, unknown>;
}

/**
 * Create a GkeExternalDnsAgent composite — returns prop objects for
 * a Deployment, ServiceAccount (with Workload Identity), ClusterRole, and ClusterRoleBinding.
 *
 * @gke
 * @example
 * ```ts
 * import { GkeExternalDnsAgent } from "@intentius/chant-lexicon-k8s";
 *
 * const { deployment, serviceAccount, clusterRole, clusterRoleBinding } = GkeExternalDnsAgent({
 *   gcpServiceAccountEmail: "external-dns@my-project.iam.gserviceaccount.com",
 *   gcpProjectId: "my-project",
 *   domainFilters: ["example.com"],
 *   txtOwnerId: "my-cluster",
 * });
 * ```
 */
export function GkeExternalDnsAgent(props: GkeExternalDnsAgentProps): GkeExternalDnsAgentResult {
  const {
    gcpServiceAccountEmail,
    gcpProjectId,
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
    "--provider=google",
    `--google-project=${gcpProjectId}`,
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
  };

  const serviceAccountProps: Record<string, unknown> = {
    metadata: {
      name: saName,
      namespace,
      labels: { ...commonLabels, "app.kubernetes.io/component": "dns" },
      annotations: {
        "iam.gke.io/gcp-service-account": gcpServiceAccountEmail,
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
