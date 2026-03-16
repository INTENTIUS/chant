// GKE ManagedCertificate + FrontendConfig for CockroachDB UI HTTPS termination.
// ManagedCertificate provisions a Google-managed TLS cert via ACME HTTP-01.
// FrontendConfig enforces HTTP→HTTPS redirect at the load balancer.

import { createResource } from "@intentius/chant/runtime";
import { config } from "../config";

const ManagedCertificate = createResource("K8s::NetworkingGKE::ManagedCertificate", "k8s", {});
const FrontendConfig = createResource("K8s::NetworkingGKEBeta::FrontendConfig", "k8s", {});

const NAMESPACE = "crdb-east";

export const crdbManagedCert = new ManagedCertificate({
  metadata: {
    name: "crdb-ui-cert",
    namespace: NAMESPACE,
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  spec: {
    domains: [config.domain],
  },
});

export const crdbFrontendConfig = new FrontendConfig({
  metadata: {
    name: "crdb-ui-frontend",
    namespace: NAMESPACE,
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  spec: {
    redirectToHttps: {
      enabled: true,
      responseCodeName: "MOVED_PERMANENTLY_DEFAULT",
    },
  },
});
