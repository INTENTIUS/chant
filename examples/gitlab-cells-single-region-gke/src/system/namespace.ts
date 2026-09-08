import { NamespaceEnv } from "@intentius/chant-lexicon-k8s";
import { SYSTEM_NS } from "../config";

export const { namespace, resourceQuota, limitRange } = NamespaceEnv({
  name: SYSTEM_NS,
  cpuQuota: "32",
  memoryQuota: "64Gi",
  defaultCpuRequest: "100m",
  defaultMemoryRequest: "128Mi",
  defaultCpuLimit: "1",
  defaultMemoryLimit: "1Gi",
  labels: { "app.kubernetes.io/part-of": "system" },
});
