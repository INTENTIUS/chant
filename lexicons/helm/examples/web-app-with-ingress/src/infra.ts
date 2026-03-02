import { HelmWebApp } from "@intentius/chant-lexicon-helm";

export const {
  chart,
  values,
  deployment,
  service,
  ingress,
  hpa,
  serviceAccount,
} = HelmWebApp({
  name: "frontend",
  imageRepository: "my-registry.io/frontend",
  imageTag: "latest",
  port: 3000,
  replicas: 2,
  ingress: true,
  autoscaling: true,
  serviceAccount: true,
  appVersion: "2.1.0",
  podSecurityContext: { runAsNonRoot: true, fsGroup: 1000 },
  securityContext: {
    runAsUser: 1000,
    readOnlyRootFilesystem: true,
    allowPrivilegeEscalation: false,
  },
  livenessProbe: {
    httpGet: { path: "/healthz", port: "http" },
    initialDelaySeconds: 10,
    periodSeconds: 15,
  },
  readinessProbe: {
    httpGet: { path: "/ready", port: "http" },
    initialDelaySeconds: 5,
    periodSeconds: 10,
  },
  strategy: { type: "RollingUpdate", rollingUpdate: { maxSurge: 1, maxUnavailable: 0 } },
});
