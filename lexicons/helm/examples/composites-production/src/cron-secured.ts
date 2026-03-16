import { HelmCronJob } from "@intentius/chant-lexicon-helm";

export const { chart, values, cronJob, serviceAccount } = HelmCronJob({
  name: "report-generator",
  imageRepository: "myorg/reporter",
  imageTag: "v1.3.0",
  schedule: "0 6 * * 1",
  concurrencyPolicy: "Forbid",
  backoffLimit: 2,
  serviceAccount: true,
  podSecurityContext: {
    runAsNonRoot: true,
    fsGroup: 1000,
  },
  securityContext: {
    allowPrivilegeEscalation: false,
    readOnlyRootFilesystem: true,
    capabilities: { drop: ["ALL"] },
  },
});
