import { HelmMicroservice } from "@intentius/chant-lexicon-helm";

export const {
  chart,
  values,
  deployment,
  service,
  serviceAccount,
  configMap,
  ingress,
  hpa,
  pdb,
} = HelmMicroservice({
  name: "payment-api",
  imageRepository: "my-registry.io/payment-api",
  imageTag: "v1.4.2",
  port: 8080,
  replicas: 3,
  ingress: true,
  autoscaling: true,
  pdb: true,
  configMap: true,
  appVersion: "1.4.2",
  podSecurityContext: { runAsNonRoot: true, runAsUser: 1000 },
  securityContext: {
    readOnlyRootFilesystem: true,
    allowPrivilegeEscalation: false,
  },
  nodeSelector: { "node-pool": "services" },
  strategy: { type: "RollingUpdate", rollingUpdate: { maxSurge: 1, maxUnavailable: 0 } },
});
