import { HelmBatchJob } from "@intentius/chant-lexicon-helm";

export const { chart, values, job, serviceAccount, role, roleBinding } = HelmBatchJob({
  name: "db-migration",
  imageRepository: "myorg/migrator",
  imageTag: "v2.1.0",
  backoffLimit: 3,
  ttlSecondsAfterFinished: 3600,
  rbac: true,
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
