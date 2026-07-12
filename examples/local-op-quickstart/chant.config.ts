import type { ChantConfig } from "@intentius/chant";
// aws/gcp/azure/k8s are listed so `chant run` loads their relocated Op activities
// (floci / gcpApply / az group / kubectl+k3d) for the local-<cloud> demo ops.
export default { lexicons: ["temporal", "aws", "gcp", "azure", "k8s"] } satisfies ChantConfig;
