// BackendConfig: Cloud Armor WAF policy attachment + health check for CockroachDB UI.

import { createResource } from "@intentius/chant/runtime";

const BackendConfig = createResource("K8s::GKE::BackendConfig", "k8s", {});

export const crdbBackendConfig = new BackendConfig({
  metadata: {
    name: "crdb-ui-backend",
    namespace: "crdb-west",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  spec: {
    securityPolicy: { name: "crdb-ui-waf" },
    healthCheck: { type: "HTTPS", requestPath: "/health", port: 8080 },
  },
});
