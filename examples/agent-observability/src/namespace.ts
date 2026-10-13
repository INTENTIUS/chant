/** The namespace the collectors and the backends run in. */
import { NamespaceEnv } from "@intentius/chant-lexicon-k8s";

export const NAMESPACE = "observability";

const observability = NamespaceEnv({
  name: NAMESPACE,
  defaultDenyIngress: false,
  labels: { "app.kubernetes.io/part-of": "agent-observability" },
});

export { observability };
