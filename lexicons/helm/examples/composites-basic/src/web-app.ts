import { HelmWebApp } from "@intentius/chant-lexicon-helm";

export const { chart, values, deployment, service, ingress, hpa, serviceAccount } =
  HelmWebApp({ name: "my-web-app" });
