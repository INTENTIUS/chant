import { NamespaceEnv } from "@intentius/chant-lexicon-k8s";

export const { namespace, resourceQuota, limitRange } = NamespaceEnv({
  name: "system",
  cpuQuota: "32",
  memoryQuota: "64Gi",
  defaultCpuRequest: "100m",
  defaultMemoryRequest: "128Mi",
  defaultCpuLimit: "1",
  defaultMemoryLimit: "1Gi",
  labels: { "app.kubernetes.io/part-of": "system" },
});
