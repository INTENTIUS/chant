import { HelmMicroservice } from "@intentius/chant-lexicon-helm";

export const {
  chart: msChart,
  values: msValues,
  deployment: msDeployment,
  service: msService,
  serviceAccount: msSa,
  configMap: msConfigMap,
  ingress: msIngress,
  hpa: msHpa,
  pdb: msPdb,
} = HelmMicroservice({
  name: "order-api",
  port: 3000,
  replicas: 3,
});
