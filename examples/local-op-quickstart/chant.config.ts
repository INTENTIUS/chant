import type { ChantConfig } from "@intentius/chant";
// aws/gcp/azure are listed so `chant run` loads their relocated Op activities
// (floci / gcpApply / az group) for the local-<cloud> demo ops; k8s/k3d use the
// temporal base activities.
export default { lexicons: ["temporal", "aws", "gcp", "azure"] } satisfies ChantConfig;
