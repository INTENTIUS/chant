// K8s workloads: AutoscaledService + IrsaServiceAccount + ConfigMap.

import {
  ConfigMap,
  AutoscaledService,
  IrsaServiceAccount,
  MetricsServer,
} from "@intentius/chant-lexicon-k8s";
import { config } from "../config";

const NAMESPACE = "microservice";

// ── IRSA ServiceAccount ────────────────────────────────────────────

const irsa = IrsaServiceAccount({
  name: "microservice-app-sa",
  iamRoleArn: config.appRoleArn,
  namespace: NAMESPACE,
});

export const appServiceAccount = irsa.serviceAccount;

// ── AutoscaledService (Deployment + Service + HPA + PDB) ───────────

const app = AutoscaledService({
  name: "microservice-api",
  image: config.appImage,
  port: 8080,
  replicas: 3,
  minReplicas: 2,
  maxReplicas: 10,
  targetCPU: 70,
  minAvailable: 1,
  livenessPath: "/",
  readinessPath: "/",
  topologySpread: true,
  securityContext: {
    runAsNonRoot: true,
    readOnlyRootFilesystem: true,
    allowPrivilegeEscalation: false,
    capabilities: { drop: ["ALL"] },
    seccompProfile: { type: "RuntimeDefault" },
  },
  namespace: NAMESPACE,
  cpuRequest: "200m",
  memoryRequest: "256Mi",
  cpuLimit: "1",
  memoryLimit: "512Mi",
  env: [
    { name: "APP_ENV", value: "production" },
    { name: "LOG_LEVEL", value: "info" },
  ],
  labels: {
    "app.kubernetes.io/part-of": "eks-microservice",
    "app.kubernetes.io/version": "v1.0.0",
  },
  serviceAccountName: "microservice-app-sa",
  tmpDirs: ["/tmp", "/var/cache/nginx"],
});

export const appDeployment = app.deployment;
export const appService = app.service;
export const appHpa = app.hpa;
export const appPdb = app.pdb!;

// ── App ConfigMap ──────────────────────────────────────────────────

export const appConfig = new ConfigMap({
  metadata: {
    name: "microservice-config",
    namespace: NAMESPACE,
    labels: {
      "app.kubernetes.io/name": "microservice-api",
      "app.kubernetes.io/managed-by": "chant",
      "app.kubernetes.io/component": "config",
    },
  },
  data: {
    "config.yaml": [
      "server:",
      "  port: 8080",
      "  gracefulShutdown: 30s",
      "database:",
      "  maxConnections: 20",
      "  idleTimeout: 5m",
      "cache:",
      "  ttl: 60s",
    ].join("\n"),
  },
});

// ── MetricsServer (required for HPA) ────────────────────────────

const ms = MetricsServer({});

export const metricsServerDeployment = ms.deployment;
export const metricsServerService = ms.service;
export const metricsServerSa = ms.serviceAccount;
export const metricsServerRole = ms.clusterRole;
export const metricsServerBinding = ms.clusterRoleBinding;
export const metricsServerAggRole = ms.aggregatedClusterRole;
export const metricsServerAuthBinding = ms.authDelegatorBinding;
export const metricsServerApiService = ms.apiService;
