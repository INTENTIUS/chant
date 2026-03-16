import { HelmSecureIngress } from "@intentius/chant-lexicon-helm";

export const { chart, values, ingress, certificate } = HelmSecureIngress({
  name: "api-gateway",
  ingressClassName: "nginx",
  clusterIssuer: "letsencrypt-prod",
});
