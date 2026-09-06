import type { ChantConfig } from "@intentius/chant";
// aws/gcp/azure/k8s/k3d are listed so `chant run` loads their relocated Op activities
// (floci / gcpApply / az group / kubectl / k3dUp+k3dDown) for the local-<cloud> demo ops.
// The base activities (shellCmd, chantBuild, httpCheck) are core's own and load with no
// lexicon listed at all.
// `ownership` names the stack and env the aws effect receipt derives its path from
// (/chant-receipts/local-op-quickstart/local/<effect> — chant #1835): the same fields
// that stamp ownership markers, env explicit.
export default {
  lexicons: ["aws", "gcp", "azure", "k8s", "k3d"],
  ownership: { stack: "local-op-quickstart", env: "local" },
} satisfies ChantConfig;
