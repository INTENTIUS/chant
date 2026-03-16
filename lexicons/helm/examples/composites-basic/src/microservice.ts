import { HelmMicroservice } from "@intentius/chant-lexicon-helm";

export const { chart, values, deployment, service, serviceAccount, configMap, ingress, hpa, pdb } =
  HelmMicroservice({
    name: "order-api",
    port: 3000,
    replicas: 3,
  });
