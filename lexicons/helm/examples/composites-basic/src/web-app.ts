import { HelmWebApp } from "@intentius/chant-lexicon-helm";

export const {
  chart: webChart,
  values: webValues,
  deployment: webDeployment,
  service: webService,
  ingress: webIngress,
  hpa: webHpa,
  serviceAccount: webSa,
} = HelmWebApp({ name: "my-web-app" });
