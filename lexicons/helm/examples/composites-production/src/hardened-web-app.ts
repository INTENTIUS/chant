import { HelmWebApp } from "@intentius/chant-lexicon-helm";

export const { chart, values, deployment, service, serviceAccount, ingress, hpa } =
  HelmWebApp({
    name: "secure-frontend",
    imageRepository: "myorg/frontend",
    port: 8080,
    replicas: 3,
    podSecurityContext: {
      runAsNonRoot: true,
      fsGroup: 1000,
      seccompProfile: { type: "RuntimeDefault" },
    },
    securityContext: {
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ["ALL"] },
    },
    nodeSelector: { "kubernetes.io/arch": "amd64" },
    tolerations: [
      { key: "dedicated", operator: "Equal", value: "frontend", effect: "NoSchedule" },
    ],
    livenessProbe: { httpGet: { path: "/healthz", port: 8080 }, initialDelaySeconds: 15 },
    readinessProbe: { httpGet: { path: "/readyz", port: 8080 }, periodSeconds: 5 },
    strategy: { type: "RollingUpdate", rollingUpdate: { maxSurge: 1, maxUnavailable: 0 } },
  });
