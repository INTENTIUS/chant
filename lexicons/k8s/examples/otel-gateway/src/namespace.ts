/** The namespace both collectors run in. */
import { NamespaceEnv } from "@intentius/chant-lexicon-k8s";

export const NAMESPACE = "observability";

export const observability = NamespaceEnv({
  name: NAMESPACE,
  defaultDenyIngress: false,
  labels: { "app.kubernetes.io/part-of": "otel-gateway-example" },
});
