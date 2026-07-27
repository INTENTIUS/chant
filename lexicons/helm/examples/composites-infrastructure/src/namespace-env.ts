import { HelmNamespaceEnv } from "@intentius/chant-lexicon-helm";

export const {
  chart: nsChart,
  values: nsValues,
  namespace: nsNamespace,
  resourceQuota: nsRQ,
  limitRange: nsLR,
  networkPolicy: nsNP,
} = HelmNamespaceEnv({
    name: "staging",
    resourceQuota: true,
    limitRange: true,
    networkPolicy: true,
  });
