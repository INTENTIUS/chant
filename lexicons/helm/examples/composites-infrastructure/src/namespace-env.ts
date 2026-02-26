import { HelmNamespaceEnv } from "@intentius/chant-lexicon-helm";

export const { chart, values, namespace, resourceQuota, limitRange, networkPolicy } =
  HelmNamespaceEnv({
    name: "staging",
    resourceQuota: true,
    limitRange: true,
    networkPolicy: true,
  });
