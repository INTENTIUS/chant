// Cell resource factory — creates all K8s resources for a single cell.
//
// Each cell gets: namespace (with quotas + default-deny), network policy
// (allow ingress from system namespace only), IRSA service account,
// autoscaled deployment with probes, and ingress routing.

import {
  NamespaceEnv,
  AutoscaledService,
  IrsaServiceAccount,
  NetworkPolicy,
  Ingress,
} from "@intentius/chant-lexicon-k8s";
import type { CellConfig } from "../config";
import { shared } from "../config";

export function createCell(cell: CellConfig) {
  const ns = `cell-${cell.name}`;

  // ── Namespace + ResourceQuota + LimitRange + default-deny ──────

  const { namespace, resourceQuota, limitRange, networkPolicy: defaultDeny } = NamespaceEnv({
    name: ns,
    cpuQuota: cell.cpuQuota,
    memoryQuota: cell.memoryQuota,
    defaultCpuRequest: "100m",
    defaultMemoryRequest: "128Mi",
    defaultCpuLimit: "500m",
    defaultMemoryLimit: "512Mi",
    defaultDenyIngress: true,
    defaultDenyEgress: false,
    labels: {
      "app.kubernetes.io/part-of": "cells",
      "cells.example.com/cell": cell.name,
    },
  });

  // ── Allow ingress from system namespace (ingress controller) ───

  const allowIngressFromSystem = new NetworkPolicy({
    metadata: {
      name: `${ns}-allow-system-ingress`,
      namespace: ns,
      labels: {
        "app.kubernetes.io/name": cell.name,
        "app.kubernetes.io/part-of": "cells",
        "app.kubernetes.io/managed-by": "chant",
      },
    },
    spec: {
      podSelector: { matchLabels: { "app.kubernetes.io/name": `${cell.name}-app` } },
      policyTypes: ["Ingress"],
      ingress: [{
        from: [{
          namespaceSelector: { matchLabels: { "app.kubernetes.io/name": "system" } },
        }],
        ports: [{ port: 8080, protocol: "TCP" }],
      }],
    },
  });

  // ── IRSA service account ───────────────────────────────────────

  const { serviceAccount } = IrsaServiceAccount({
    name: `${cell.name}-sa`,
    iamRoleArn: cell.iamRoleArn,
    namespace: ns,
    labels: {
      "app.kubernetes.io/part-of": "cells",
      "cells.example.com/cell": cell.name,
    },
  });

  // ── Autoscaled deployment + HPA + PDB + Service ────────────────

  const { deployment, service, hpa, pdb } = AutoscaledService({
    name: `${cell.name}-app`,
    image: shared.appImage,
    port: 8080,
    minReplicas: cell.replicas,
    maxReplicas: cell.maxReplicas,
    targetCPUPercent: cell.cpuTargetPercent,
    minAvailable: cell.minAvailable,
    cpuRequest: cell.cpuRequest,
    memoryRequest: cell.memoryRequest,
    namespace: ns,
    serviceAccountName: `${cell.name}-sa`,
    livenessPath: "/healthz",
    readinessPath: "/readyz",
    topologySpread: true,
    securityContext: {
      runAsNonRoot: true,
      allowPrivilegeEscalation: false,
      capabilities: { drop: ["ALL"] },
      seccompProfile: { type: "RuntimeDefault" },
    },
    labels: {
      "app.kubernetes.io/part-of": "cells",
      "cells.example.com/cell": cell.name,
    },
  });

  // ── Ingress routing ────────────────────────────────────────────

  const ingress = new Ingress({
    metadata: {
      name: `${cell.name}-ingress`,
      namespace: ns,
      labels: {
        "app.kubernetes.io/name": cell.name,
        "app.kubernetes.io/part-of": "cells",
        "app.kubernetes.io/managed-by": "chant",
      },
      annotations: {
        "kubernetes.io/ingress.class": "nginx",
      },
    },
    spec: {
      rules: [{
        host: cell.host,
        http: {
          paths: [{
            path: "/",
            pathType: "Prefix",
            backend: {
              service: { name: `${cell.name}-app`, port: { number: 80 } },
            },
          }],
        },
      }],
    },
  });

  return {
    namespace,
    resourceQuota,
    limitRange,
    defaultDeny,
    allowIngressFromSystem,
    serviceAccount,
    deployment,
    service,
    hpa,
    pdb,
    ingress,
  };
}
