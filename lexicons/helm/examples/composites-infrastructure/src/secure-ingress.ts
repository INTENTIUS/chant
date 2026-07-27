import { HelmSecureIngress } from "@intentius/chant-lexicon-helm";

export const {
  chart: siChart,
  values: siValues,
  ingress: siIngress,
  certificate: siCert,
} = HelmSecureIngress({
  name: "api-gateway",
  ingressClassName: "nginx",
  clusterIssuer: "letsencrypt-prod",
});
