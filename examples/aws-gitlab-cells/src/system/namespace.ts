// System namespace — shared control plane services.

import { NamespaceEnv } from "@intentius/chant-lexicon-k8s";

export const { namespace, resourceQuota, limitRange } = NamespaceEnv({
  name: "system",
  cpuQuota: "8",
  memoryQuota: "16Gi",
  defaultCpuRequest: "100m",
  defaultMemoryRequest: "128Mi",
  defaultCpuLimit: "1",
  defaultMemoryLimit: "1Gi",
  defaultDenyIngress: false,
  labels: { "app.kubernetes.io/part-of": "system" },
});
