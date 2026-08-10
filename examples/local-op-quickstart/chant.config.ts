import type { ChantConfig } from "@intentius/chant";
// aws/gcp/azure/k8s/k3d are listed so `chant run` loads their relocated Op activities
// (floci / gcpApply / az group / kubectl / k3dUp+k3dDown) for the local-<cloud> demo ops.
export default { lexicons: ["temporal", "aws", "gcp", "azure", "k8s", "k3d"] } satisfies ChantConfig;
