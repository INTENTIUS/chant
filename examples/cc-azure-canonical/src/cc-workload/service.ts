/**
 * The CC lane's canonical example, workload half (chant#1200 / #1214).
 *
 * The k8s side of the mixed-substrate round-trip: a Service on the AKS
 * cluster above, observed through the cluster's own kubeconfig rather than a
 * fixed endpoint. behold anchors it under the cluster (behold#102), which is
 * what makes "both substrates in one graph" true rather than aspirational.
 */
import { Service } from "@intentius/chant-lexicon-k8s";

export const apiService = new Service({
  metadata: { name: "cc-api", namespace: "default", labels: { app: "cc-api" } },
  spec: {
    selector: { app: "cc-api" },
    ports: [{ name: "http", port: 80, targetPort: 8080 }],
  },
});
